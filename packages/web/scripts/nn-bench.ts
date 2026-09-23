/*
 * A/B strength bench for the learned policy/value net: plays the net (inside
 * the same MCTS engine, via useNeuralNet — see ai.ts's mctsRollout/
 * computePlanStarters integration) against the shipped hand-tuned `hard`
 * heuristic, headless, and reports win rate — mirrors ai-bench.ts's
 * methodology (side-swapping, 1σ noise note) but adds the one thing that
 * script's playGame() doesn't support: injecting a loaded NNEvaluator into
 * one side's AIPlayer via setNNEvaluator().
 *
 * Run with:
 *   NNBENCH_WEIGHTS=scripts/nn-data/nn-weights-latest.json \
 *     pnpm --filter @kc/web exec vitest run --config vitest.nn-bench.config.ts
 * (see the `nn:bench` package.json script for the wrapped form; also printed
 * by nn-loop.sh after each training run)
 */
import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_DIFFICULTY, type AIConfig } from '../src/game/ai-config.js';
import { NNEvaluator, emptyWeights, type NNWeights } from '../src/game/nn-eval.js';
import {
  makeState,
  makeUnit,
  makeSearcher,
  search,
  applyPlan,
  aliveCount,
  type HarnessState,
  type Player,
} from '../src/game/__tests__/mcts-harness.js';

interface Args {
  games: number;
  budgetMs: number;
  maxTurns: number;
  weightsPath: string;
  blend: number;
}

function parseArgs(): Args {
  const get = (name: string, fallback: string): string => process.env[`NNBENCH_${name.toUpperCase()}`] ?? fallback;
  return {
    games: Number(get('games', '30')),
    budgetMs: Number(get('budget', '900')),
    maxTurns: Number(get('maxturns', '60')),
    weightsPath: get('weights', 'scripts/nn-data/nn-weights-latest.json'),
    blend: Number(get('blend', '0')),
  };
}

function contactPosition(): HarnessState {
  const KN = { hp: 3, armor: 4, dmg: 5, mv: 2 };
  const CV = { hp: 5, armor: 3, dmg: 6, mv: 3 };
  const AR = { hp: 3, armor: 1, dmg: 3, mv: 3 };
  const mk = (id: number, p: Player, type: string, row: number, col: number) => {
    const st = type === 'knight' ? KN : type === 'cavalry' ? CV : AR;
    return makeUnit({ id, player: p, type: type as never, row, col, hp: st.hp, armor: st.armor, damage: st.dmg, maxMoves: st.mv });
  };
  return makeState(
    [
      mk(1, 2, 'knight', 8, 9), mk(2, 2, 'archer', 7, 10), mk(3, 2, 'cavalry', 8, 11), mk(4, 2, 'knight', 7, 8),
      mk(5, 1, 'knight', 11, 9), mk(6, 1, 'archer', 12, 10), mk(7, 1, 'cavalry', 11, 11), mk(8, 1, 'knight', 12, 8),
    ],
    3,
  );
}

function loadWeights(path: string): NNWeights {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as NNWeights;
  } catch (err) {
    console.warn(`Could not load weights from ${path} (${(err as Error).message}); using an untrained (all-zero) net.`);
    return emptyWeights();
  }
}

function baseConfig(budget: number): Partial<AIConfig> {
  return { ...AI_DIFFICULTY.hard, label: 'bench', intelligence: 1, mctsTimeBudgetMs: budget, mctsSelectionTemp: 0, trustSearch: true };
}

function playOne(
  args: Args,
  weights: NNWeights,
  nnIsP1: boolean,
): { winner: Player | null; turns: number } {
  const start = contactPosition();
  const nnConfig: Partial<AIConfig> = { ...baseConfig(args.budgetMs), useNeuralNet: true, neuralNetBlend: args.blend };
  const heuristicConfig: Partial<AIConfig> = baseConfig(args.budgetMs);

  const p1Config = nnIsP1 ? nnConfig : heuristicConfig;
  const p2Config = nnIsP1 ? heuristicConfig : nnConfig;
  const p1 = makeSearcher(1, p1Config, start);
  const p2 = makeSearcher(2, p2Config, start);
  if (nnIsP1) p1.setNNEvaluator(new NNEvaluator(weights));
  else p2.setNNEvaluator(new NNEvaluator(weights));

  const ais = { 1: p1, 2: p2 };
  let state = start;
  let player: Player = 1;

  for (let turn = 0; turn < args.maxTurns; turn += 1) {
    if (aliveCount(state, 1) === 0) return { winner: 2, turns: turn };
    if (aliveCount(state, 2) === 0) return { winner: 1, turns: turn };

    const { plan } = search(ais[player], state);
    state = applyPlan(ais[player], state, player, plan);

    const opp: Player = player === 1 ? 2 : 1;
    const internals = ais[player] as unknown as { inCastleZone(r: number, c: number, o: Player): boolean };
    const inCastle = state.units.some((u) => u.player === player && u.hp > 0 && internals.inCastleZone(u.row, u.col, opp));
    const defended = state.units.some((u) => u.player === opp && u.hp > 0 && internals.inCastleZone(u.row, u.col, opp));
    if (inCastle && !defended) return { winner: player, turns: turn + 1 };

    player = opp;
  }
  return { winner: null, turns: args.maxTurns };
}

function runBench(): void {
  const args = parseArgs();
  const weights = loadWeights(args.weightsPath);
  console.log(`\nNN bench — net (${args.weightsPath}, blend=${args.blend}) vs hard heuristic`);
  console.log(`games=${args.games} budget=${args.budgetMs}ms maxTurns=${args.maxTurns}\n`);

  let nnWins = 0;
  let heuristicWins = 0;
  let draws = 0;
  const t0 = Date.now();

  for (let g = 0; g < args.games; g += 1) {
    const nnIsP1 = g % 2 === 0;
    const result = playOne(args, weights, nnIsP1);
    if (result.winner === null) draws += 1;
    else if ((result.winner === 1) === nnIsP1) nnWins += 1;
    else heuristicWins += 1;
    process.stdout.write(`\rgame ${g + 1}/${args.games}  net ${nnWins} — ${heuristicWins} heuristic (${draws} draws)`);
  }

  const decisive = nnWins + heuristicWins;
  console.log('\n');
  console.log('─'.repeat(58));
  console.log(`net wins        : ${nnWins}  (${((nnWins / args.games) * 100).toFixed(1)}%)`);
  console.log(`heuristic wins  : ${heuristicWins}  (${((heuristicWins / args.games) * 100).toFixed(1)}%)`);
  console.log(`draws           : ${draws}`);
  if (decisive > 0) console.log(`decisive win rate for the net: ${((nnWins / decisive) * 100).toFixed(1)}%`);
  const sigma = 50 / Math.sqrt(Math.max(1, args.games));
  console.log(`(1σ noise at this sample size: ±${sigma.toFixed(1)}pp — treat smaller gaps as noise)`);
  console.log(`wall clock      : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log('─'.repeat(58));
}

it('nn bench', () => {
  runBench();
}, 60 * 60 * 1000);
