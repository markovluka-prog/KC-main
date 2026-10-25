/// <reference lib="webworker" />
/**
 * Rollout worker for the "Свой шанс" AI (see AIPlayer.chanceStep in ai.ts).
 *
 * Estimates a player's win probability from a position: the share of the
 * game tree's branches below it that end in that player's win, sampled —
 * play `samples` random branches (every legal action equally likely).
 *
 * Speed: a random branch needs ~7 700 actions to reach a win, so each one is
 * cut after `maxLen` (~200) actions and the position it reached is scored by
 * winChance() — the evaluation with weights fitted to random-play outcomes
 * (chance-weights.json, scripts/fit-chance.mjs).
 */
import { applyAction, generateActionsForPlayer, mulberry32, winChance, type GameState, type ServerAction } from '@kc/game-rules';

interface Req {
  id: number;
  state: GameState;
  samples: number;
  maxLen: number;
  player: 1 | 2;
  seed: number;
}

const RNG = mulberry32(1);
const END: ServerAction = { kind: 'end-turn' };

function playout(s: GameState, rand: () => number, maxLen: number): GameState {
  for (let i = 0; i < maxLen && s.winner === null; i++) {
    const acts = generateActionsForPlayer(s, s.currentPlayer);
    acts.push(END);
    for (let tries = 0; tries < 4; tries++) {
      const r = applyAction(s, acts[Math.floor(rand() * acts.length)]!, RNG);
      if (r.ok) {
        s = r.value;
        break;
      }
    }
  }
  return s;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, state, samples, maxLen, player } = e.data;
  let seed = e.data.seed | 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let wins = 0; // fractional: a cut-off branch counts as its estimated probability
  for (let k = 0; k < samples; k++) {
    const end = playout(state, rand, maxLen);
    wins += end.winner === null ? winChance(end, player) : end.winner === player ? 1 : 0;
  }
  (self as unknown as Worker).postMessage({ id, wins, samples });
};
