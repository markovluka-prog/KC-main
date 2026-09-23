/*
 * Self-play data generator for the learned policy/value net (see
 * src/game/nn-eval.ts, src/game/nn-features.ts).
 *
 * Plays N headless games with the search itself deciding every move (full
 * MCTS, same engine `hard` uses in production — see ai-config.ts), records
 * one training example per turn per side:
 *
 *   { spatial, scalar, policyFeatures[], policyChosenIndex, outcome }
 *
 * `outcome` is filled in AFTER the game ends (+1 win / -1 loss / 0 draw or
 * turn-limit, from that example's own perspective), discounted by distance to
 * the end of the game — the same terminal-discount idea mctsRollout already
 * uses for its own reward, so the training signal and the search's own notion
 * of "how much does a delayed win matter" agree.
 *
 * IMPORTANT — why self-play here does NOT start from the net's own
 * (untrained) judgement, unlike a from-scratch AlphaZero run: `useNeuralNet`
 * is left OFF for this generator. Moves come entirely from the existing,
 * strong hand-tuned MCTS (the one `hard` ships with), and the net only
 * OBSERVES those games to learn a value/policy function from them — i.e. this
 * is imitation-flavoured bootstrapping of the value head from a strong
 * teacher's outcomes, not RL against the net's own current (bad) evaluation.
 * Training purely against the net's own early guesses is exactly the failure
 * mode that sank the old tabular Q-brain (see supabase/migrations/
 * 0006_drop_ai_brain.sql) — a value function bootstrapped off its own noise
 * has nothing solid to converge to. Once nn-loop.sh has a net that scores
 * competitively against `hard` in scripts/ai-bench.ts, flip SELFPLAY_NN_MOVES
 * to have the net's own search generate the data — true self-play — for
 * further iterations.
 *
 * Output: JSONL, one example per line, APPENDED to the path in OUT_FILE (or
 * scripts/nn-data/selfplay-<timestamp>.jsonl by default) after every game —
 * not buffered until the end — so a run killed partway through a multi-hour
 * batch keeps every game played so far instead of losing all of it.
 * scripts/nn-train.py reads this format directly.
 *
 * Run with:
 *   SELFPLAY_GAMES=50 pnpm --filter @kc/web exec vitest run --config \
 *     scripts/nn-selfplay.config.ts scripts/nn-selfplay.ts
 * (see the `nn:selfplay` package.json script for the wrapped form)
 */
import { it } from 'vitest';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AI_DIFFICULTY, type AIConfig } from '../src/game/ai-config.js';
import { encodeState, type BoardOrientation } from '../src/game/nn-features.js';
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
  outFile: string;
}

function parseArgs(): Args {
  const get = (name: string, fallback: string): string => process.env[`SELFPLAY_${name.toUpperCase()}`] ?? fallback;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    games: Number(get('games', '20')),
    budgetMs: Number(get('budget', '500')),
    maxTurns: Number(get('maxturns', '60')),
    outFile: resolve(get('out', `scripts/nn-data/selfplay-${stamp}.jsonl`)),
  };
}

/** Mirrors ai-bench.ts's contactPosition: armies already in contact, so games
 *  have tactical content from turn 1 instead of several turns of pure walking
 *  (which would otherwise dominate the dataset with near-identical examples). */
function startPosition(): HarnessState {
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

/** One raw training example, value not yet filled in (backfilled after the
 *  game ends — see finalizeGame). Policy fields are omitted when the searched
 *  turn produced no starters worth recording (e.g. no legal actions). */
interface RawExample {
  spatial: number[];
  scalar: number[];
  perspective: Player;
  turnIndexFromEnd: number; // filled in once the game length is known
  outcome: number; // +1/-1/0 from `perspective`'s POV, discounted
  /** Per-candidate action-feature vectors, same layout ai.ts's
   *  encodeActionFeatures/POLICY_ACTION_FEATURE_WIDTH produce — what the
   *  policy head is trained to score. */
  policyFeatures?: number[][];
  /** Index into policyFeatures of the starter matching the first action of
   *  the plan MCTS actually committed to this turn — the training LABEL for
   *  the policy head (cross-entropy target). Absent when the chosen action
   *  wasn't among the recorded top-K starters (rare; those turns simply carry
   *  no policy label, only a value target). */
  policyChosenIndex?: number;
}

/** Reaches into AIPlayer's private search internals the same way
 *  mcts-harness.ts already does (`as Internals`) — see that file's header
 *  comment for why this is the established pattern here rather than widening
 *  ai.ts's public surface just for tooling. */
type AIInternals = {
  createLightState(): unknown;
  computePlanStarters(state: unknown, player: Player): Array<{ unitId: number; action: { type: string }; score: number }>;
  encodeActionFeatures(state: unknown, unit: unknown, action: unknown): number[];
};

const TERMINAL_DISCOUNT = 0.97; // matches W.rollout.terminalDiscount in ai-weights.json

/** Same-target check for two AIAction-shaped objects — used only to line up
 *  computePlanStarters' candidate with the plan's actually-chosen first
 *  action, both produced from the identical position, so equal type+row/col+
 *  target is enough (no need to compare every optional field). */
function actionsMatch(a: { row?: number; col?: number; targetRow?: number; targetCol?: number }, b: typeof a): boolean {
  return a.row === b.row && a.col === b.col && a.targetRow === b.targetRow && a.targetCol === b.targetCol;
}

function teacherConfig(budgetMs: number): Partial<AIConfig> {
  return {
    ...AI_DIFFICULTY.hard,
    label: 'selfplay-teacher',
    mctsTimeBudgetMs: budgetMs,
    mctsSelectionTemp: 0.3, // slight sampling so games aren't all identical
    trustSearch: true,
  };
}

function playOneGame(args: Args): RawExample[] {
  const start = startPosition();
  const config = teacherConfig(args.budgetMs);
  const ais = { 1: makeSearcher(1, config, start), 2: makeSearcher(2, config, start) };
  let state = start;
  let player: Player = 1;
  const examples: RawExample[] = [];
  let winner: Player | null = null;
  let turns = 0;

  for (turns = 0; turns < args.maxTurns; turns += 1) {
    if (aliveCount(state, 1) === 0) { winner = 2; break; }
    if (aliveCount(state, 2) === 0) { winner = 1; break; }

    const orientation: BoardOrientation = { player1Bottom: true };
    // Record ONE example per turn from the mover's perspective — recording
    // both sides' view of the same position would just duplicate it mirrored,
    // which nn-features.ts already makes redundant (see its symmetry test).
    const { spatial, scalar } = encodeState(state, player, orientation);
    const example: RawExample = {
      spatial: Array.from(spatial),
      scalar: Array.from(scalar),
      perspective: player,
      turnIndexFromEnd: -1, // patched below once the game ends
      outcome: 0,
    };
    examples.push(example);

    // Capture the policy training pair BEFORE searching consumes/mutates
    // anything: the candidate starters at this exact position, and (after the
    // search below) which one MCTS's chosen plan actually started with.
    const internals = ais[player] as unknown as AIInternals;
    const lightState = internals.createLightState();
    const starters = internals.computePlanStarters(lightState, player);
    if (starters.length > 0) {
      example.policyFeatures = starters.map((s) => {
        const unit = (lightState as { units: Array<{ id: number }> }).units.find((u) => u.id === s.unitId);
        return unit ? internals.encodeActionFeatures(lightState, unit, s.action) : [];
      });
    }

    const { plan } = search(ais[player], state);
    if (starters.length > 0 && plan.length > 0) {
      const first = plan[0]!;
      const idx = starters.findIndex(
        (s) => s.unitId === first.unitId && s.action.type === first.action.type && actionsMatch(s.action, first.action),
      );
      if (idx >= 0) example.policyChosenIndex = idx;
    }
    if (plan.length === 0) {
      state = { ...state }; // no-op turn; applyEndOfTurn below via applyPlan([]) path
      state = applyPlan(ais[player], state, player, []);
    } else {
      state = applyPlan(ais[player], state, player, plan);
    }

    const opp: Player = player === 1 ? 2 : 1;
    const castleInternals = ais[player] as unknown as { inCastleZone(r: number, c: number, o: Player): boolean };
    const inCastle = state.units.some((u) => u.player === player && u.hp > 0 && castleInternals.inCastleZone(u.row, u.col, opp));
    const defended = state.units.some((u) => u.player === opp && u.hp > 0 && castleInternals.inCastleZone(u.row, u.col, opp));
    if (inCastle && !defended) { winner = player; turns += 1; break; }

    player = opp;
  }

  // Backfill outcomes now that the game's result is known.
  const total = examples.length;
  examples.forEach((ex, i) => {
    const distFromEnd = total - 1 - i;
    let base: number;
    if (winner === null) base = 0; // draw / turn limit — no signal either way
    else base = winner === ex.perspective ? 1 : -1;
    ex.outcome = base * Math.pow(TERMINAL_DISCOUNT, distFromEnd);
    ex.turnIndexFromEnd = distFromEnd;
  });

  process.stdout.write(`  game done: winner=${winner ?? 'draw'} turns=${turns} examples=${total}\n`);
  return examples;
}

function main(): void {
  const args = parseArgs();
  process.stdout.write(`Self-play: ${args.games} games, ${args.budgetMs}ms/turn budget, max ${args.maxTurns} turns -> ${args.outFile}\n`);
  mkdirSync(dirname(args.outFile), { recursive: true });
  // Truncate/create up front, then APPEND after every game (not just at the
  // end): a multi-hour run that gets killed, crashes, or hits an OOM partway
  // through must not lose every game played so far. process.stdout.write is
  // flushed eagerly (unlike console.log's vitest-buffered output, which only
  // surfaces once the whole `it(...)` completes), so this doubles as the way
  // to watch real progress with `tail -f` while it runs.
  writeFileSync(args.outFile, '', 'utf8');
  let totalExamples = 0;
  const t0 = Date.now();
  for (let g = 0; g < args.games; g += 1) {
    process.stdout.write(`game ${g + 1}/${args.games}...\n`);
    const examples = playOneGame(args);
    const lines = examples.map((ex) => JSON.stringify(ex)).join('\n') + '\n';
    appendFileSync(args.outFile, lines, 'utf8');
    totalExamples += examples.length;
    const elapsedSoFar = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`  [${g + 1}/${args.games}] +${examples.length} examples (total ${totalExamples}), ${elapsedSoFar}s elapsed\n`);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`Wrote ${totalExamples} examples from ${args.games} games in ${elapsed}s -> ${args.outFile}\n`);
}

// Run as a single vitest "test" so it reuses the existing TS-runner plumbing
// (see ai-bench.ts's header comment — the repo has no standalone tsx/ts-node
// dependency). This is a data-generation script, not an assertion.
it('generates self-play data', () => {
  main();
}, 24 * 60 * 60 * 1000);
