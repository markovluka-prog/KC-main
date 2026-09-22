/*
 * A/B strength bench for the MCTS engine.
 *
 * Plays N headless games between two AI configurations and reports win rate,
 * game length, and per-turn search statistics. Every algorithmic change to the
 * search (Progressive Widening, RAVE, the solver, budget tuning) should be
 * accepted or rejected on numbers from this script, not on inspection.
 *
 * Run with the `bench` script (it uses vitest as the TypeScript runner, since
 * the repo has no standalone ts-node/tsx dependency). Options come from env
 * vars so they survive vitest's argument handling:
 *
 *   pnpm --filter @kc/web bench                                  # default A/B
 *   BENCH_GAMES=40 pnpm --filter @kc/web bench                   # more games
 *   BENCH_PRESET=rave pnpm --filter @kc/web bench                # named comparison
 *   BENCH_BUDGET=800 BENCH_GAMES=30 pnpm --filter @kc/web bench  # bigger budget
 *
 * Sides are swapped every other game so a first-move advantage cannot be
 * mistaken for a strength difference.
 */
import { it } from 'vitest';
import { AI_DIFFICULTY, type AIConfig } from '../src/game/ai-config.js';
import {
  makeState,
  makeUnit,
  playGame,
  type HarnessState,
  type Player,
} from '../src/game/__tests__/mcts-harness.js';

interface Args {
  games: number;
  budget: number;
  preset: string;
  maxTurns: number;
}

function parseArgs(): Args {
  const get = (name: string, fallback: string): string =>
    process.env[`BENCH_${name.toUpperCase()}`] ?? fallback;
  return {
    games: Number(get('games', '20')),
    budget: Number(get('budget', '400')),
    preset: get('preset', 'pw'),
    maxTurns: Number(get('maxTurns', '50')),
  };
}

/** A symmetric starting position: three units a side, mirrored across the map. */
function startPosition(): HarnessState {
  const p1 = [
    makeUnit({ id: 1, player: 1 as Player, type: 'knight', row: 14, col: 8, hp: 5, damage: 3 }),
    makeUnit({ id: 2, player: 1 as Player, type: 'archer', row: 15, col: 9, hp: 3, damage: 3 }),
    makeUnit({ id: 3, player: 1 as Player, type: 'cavalry', row: 14, col: 10, hp: 4, damage: 3, maxMoves: 4 }),
  ];
  const p2 = [
    makeUnit({ id: 4, player: 2 as Player, type: 'knight', row: 5, col: 8, hp: 5, damage: 3 }),
    makeUnit({ id: 5, player: 2 as Player, type: 'archer', row: 4, col: 9, hp: 3, damage: 3 }),
    makeUnit({ id: 6, player: 2 as Player, type: 'cavalry', row: 5, col: 10, hp: 4, damage: 3, maxMoves: 4 }),
  ];
  return makeState([...p1, ...p2]);
}

/**
 * Armies already in contact, with the real unit stats.
 *
 * The symmetric long-range opening above is SATURATED: both sides spend the
 * first several turns walking, so two strong configs find the same moves and
 * every A/B lands on 50%. A position with immediate tactical content is what
 * actually discriminates — set BENCH_POS=contact to use it.
 */
function contactPosition(): HarnessState {
  const KN = { hp: 3, armor: 4, dmg: 5, mv: 2 };
  const CV = { hp: 5, armor: 3, dmg: 6, mv: 3 };
  const AR = { hp: 3, armor: 1, dmg: 3, mv: 3 };
  const mk = (id: number, p: Player, type: string, row: number, col: number) => {
    const st = type === 'knight' ? KN : type === 'cavalry' ? CV : AR;
    return makeUnit({
      id, player: p, type: type as never, row, col,
      hp: st.hp, armor: st.armor, damage: st.dmg, maxMoves: st.mv,
    });
  };
  return makeState(
    [
      mk(1, 2 as Player, 'knight', 8, 9), mk(2, 2 as Player, 'archer', 7, 10),
      mk(3, 2 as Player, 'cavalry', 8, 11), mk(4, 2 as Player, 'knight', 7, 8),
      mk(5, 1 as Player, 'knight', 11, 9), mk(6, 1 as Player, 'archer', 12, 10),
      mk(7, 1 as Player, 'cavalry', 11, 11), mk(8, 1 as Player, 'knight', 12, 8),
    ],
    3,
  );
}

function base(budget: number): Partial<AIConfig> {
  return {
    ...AI_DIFFICULTY.hard,
    label: 'bench',
    intelligence: 1,
    mctsTimeBudgetMs: budget,
    mctsRolloutDepth: 6,
    mctsBreadth: 16,
    mctsSelectionTemp: 0, // deterministic: measure search strength, not sampling
    trustSearch: true,
  };
}

/** Named A/B comparisons. Each returns [challenger, baseline]. */
function buildPreset(name: string, budget: number): [Partial<AIConfig>, Partial<AIConfig>, string] {
  const b = base(budget);
  switch (name) {
    case 'pw':
      return [
        { ...b, pwAlpha: 0.45 },
        { ...b, pwAlpha: 0 },
        'Progressive Widening vs fixed breadth',
      ];
    case 'rave':
      return [
        { ...b, useRAVE: true, raveBias: 0.05 },
        { ...b, useRAVE: false },
        'RAVE/AMAF on vs off',
      ];
    case 'both':
      return [
        { ...b, pwAlpha: 0.45, useRAVE: true, raveBias: 0.05 },
        { ...b, pwAlpha: 0, useRAVE: false },
        'PW + RAVE vs neither',
      ];
    case 'exploration':
      return [
        { ...b, mctsExploration: 1.1 },
        { ...b, mctsExploration: 2.2 },
        'low exploration (hard) vs high (easy)',
      ];
    case 'minimax':
      // The core correctness fix: minimax-aware backup at opponent nodes vs the
      // plain averaging the tree used before. `flatBackup` restores the old
      // behaviour, so this measures what that fix is worth in real games.
      return [
        { ...b, flatBackup: false },
        { ...b, flatBackup: true },
        'minimax-aware backup vs plain averaging (the pre-existing behaviour)',
      ];
    case 'threat':
      // Move-then-attack threat detection + graded danger, vs the old model
      // that only saw enemies already standing in attack range.
      return [
        { ...b, accurateThreatModel: true },
        { ...b, accurateThreatModel: false },
        'accurate move-then-attack threats vs the (stronger) adjacent-only default',
      ];
    case 'plans':
      // Set-dedup + varied completions + no aimless shuffling, vs the old
      // generator whose candidates were mostly permutations of one greedy turn.
      return [
        { ...b, legacyPlanGen: false },
        { ...b, legacyPlanGen: true },
        'diverse turn-plan generation vs legacy permutations-of-one-greedy-turn',
      ];
    case 'budget':
      return [
        { ...b, mctsTimeBudgetMs: budget * 4 },
        { ...b },
        '4x thinking time vs baseline (sanity check: more time must win)',
      ];
    default:
      throw new Error(`unknown preset: ${name} (pw|rave|both|exploration|budget)`);
  }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

function runBench(): void {
  const args = parseArgs();
  const [challenger, baseline, description] = buildPreset(args.preset, args.budget);

  console.log(`\nAI bench — ${description}`);
  console.log(`games=${args.games} budget=${args.budget}ms maxTurns=${args.maxTurns}\n`);

  let chWins = 0;
  let blWins = 0;
  let draws = 0;
  const lengths: number[] = [];
  const chIters: number[] = [];
  const blIters: number[] = [];
  const chDepth: number[] = [];
  const blDepth: number[] = [];
  const turnMs: number[] = [];
  const t0 = Date.now();

  for (let g = 0; g < args.games; g += 1) {
    // Swap sides every other game to cancel any first-move advantage.
    const challengerIsP1 = g % 2 === 0;
    const p1 = challengerIsP1 ? challenger : baseline;
    const p2 = challengerIsP1 ? baseline : challenger;
    const start =
      (process.env.BENCH_POS ?? 'open') === 'contact' ? contactPosition() : startPosition();
    const result = playGame(start, p1, p2, args.maxTurns);

    if (result.winner === null) draws += 1;
    else if ((result.winner === 1) === challengerIsP1) chWins += 1;
    else blWins += 1;

    lengths.push(result.turns);
    const chSide: Player = challengerIsP1 ? 1 : 2;
    const blSide: Player = challengerIsP1 ? 2 : 1;
    for (const s of result.statsByPlayer[chSide]) {
      chIters.push(s.iterations);
      chDepth.push(s.maxDepth);
      turnMs.push(s.ms);
    }
    for (const s of result.statsByPlayer[blSide]) {
      blIters.push(s.iterations);
      blDepth.push(s.maxDepth);
      turnMs.push(s.ms);
    }

    process.stdout.write(
      `\rgame ${g + 1}/${args.games}  challenger ${chWins} — ${blWins} baseline (${draws} draws)`,
    );
  }

  const decisive = chWins + blWins;
  const sorted = [...turnMs].sort((a, b) => a - b);
  const p95 = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length * 0.95)]!;

  console.log('\n');
  console.log('─'.repeat(58));
  console.log(`challenger wins : ${chWins}  (${pct(chWins, args.games)} of all games)`);
  console.log(`baseline wins   : ${blWins}  (${pct(blWins, args.games)})`);
  console.log(`draws           : ${draws}  (${pct(draws, args.games)})`);
  if (decisive > 0) {
    console.log(`decisive win rate: ${pct(chWins, decisive)} for the challenger`);
  }
  console.log('─'.repeat(58));
  console.log(`avg game length : ${mean(lengths).toFixed(1)} turns`);
  console.log(`challenger      : ${mean(chIters).toFixed(0)} iters/turn, depth ${mean(chDepth).toFixed(1)}`);
  console.log(`baseline        : ${mean(blIters).toFixed(0)} iters/turn, depth ${mean(blDepth).toFixed(1)}`);
  console.log(`turn time p95   : ${p95.toFixed(0)} ms`);
  console.log(`wall clock      : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log('─'.repeat(58));
  // A note on reading this: with N games the 1-sigma noise on a win rate is
  // roughly 50/sqrt(N) percentage points, so 20 games cannot resolve anything
  // smaller than about ±11pp. Raise --games before trusting a small edge.
  const sigma = 50 / Math.sqrt(Math.max(1, args.games));
  console.log(`(1σ noise at this sample size: ±${sigma.toFixed(1)}pp — treat smaller gaps as noise)\n`);
}

// Wrapped in `it` so vitest runs it; the timeout is generous because a full
// A/B sweep is minutes of real search, not a unit test.
it('ai bench', () => {
  runBench();
}, 60 * 60 * 1000);
