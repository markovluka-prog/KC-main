/// <reference lib="webworker" />
/**
 * One thread of the beam/rollout AI (game-rules beam-presets.ts). The pool in
 * beam-pool.ts gives every worker the same position and a different slice of
 * the candidate plans; merging the slices reproduces planTurnFor exactly, so
 * the shipped AI is the one scripts/ladder.mjs measures — just on every core.
 */
import {
  planTurnFinalSliceFor,
  planTurnFirstPassFor,
  planTurnSliceFor,
  type FirstPassScore,
  type AIWeights, type BeamDifficultyConfig, type GameState, type Player } from '@kc/game-rules';

interface Req {
  id: number;
  state: GameState;
  me: Player;
  config: BeamDifficultyConfig;
  seed: number;
  weights?: AIWeights;
  slice: number;
  slices: number;
  /** 'first' / 'final': the two passes of a halving preset; omitted: one pass. */
  pass?: 'first' | 'final';
  finalists?: FirstPassScore[];
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, state, me, config, seed, weights, slice, slices, pass, finalists } = e.data;
  const post = (m: object) => (self as unknown as Worker).postMessage({ id, ...m });
  if (pass === 'first') post({ scores: planTurnFirstPassFor(state, me, config, seed, weights, slice, slices) });
  else if (pass === 'final') post({ pick: planTurnFinalSliceFor(state, me, config, seed, weights, finalists ?? [], slice, slices) });
  else post({ pick: planTurnSliceFor(state, me, config, seed, weights, slice, slices) });
};
