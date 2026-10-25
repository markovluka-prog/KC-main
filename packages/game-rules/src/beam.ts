/**
 * Beam search over `GameState` via `applyAction` — plan step 3.
 *
 * Replaces walking a hand-rolled `LightState` tree (the old MCTS/minimax in
 * packages/web/src/game/ai.ts) with a search that operates directly on the
 * canonical, server-authoritative state. Every expanded child is produced by
 * a real `applyAction` call, so a plan this returns can never contain an
 * illegal action — unlike the old search, which occasionally planned moves
 * the live game silently rejected (see ai.ts's own comments on that bug).
 *
 * Turn-scoped only: `planTurn` plans ONE player's turn (up to
 * MAX_ACTIVATIONS_PER_TURN activations), not a multi-turn game. Depth is
 * naturally bounded by the activation cap plus each activated unit's own
 * remaining move points — `actableUnits`/`candidateActions` stop offering
 * actions once that budget is exhausted, so MAX_DEPTH below is a safety cap,
 * not the real limiter.
 */

import { PARTS } from './constants.js';
import { applyAction, endTurn, type ServerAction } from './apply.js';
import { candidateActions } from './candidates.js';
import { evaluate, type AIWeights } from './evaluate.js';
import { mulberry32, type Rng } from './rng.js';
import type { GameState } from './state.js';
import type { Player } from './types.js';

/** Safety cap on plan length. 3 activations × up to 3 move points is the
 * realistic ceiling; this just stops runaway search if that assumption ever
 * breaks (e.g. a future unit type with more moves). */
export const MAX_PLAN_DEPTH = 12;

export interface Plan {
  actions: ServerAction[];
  state: GameState;
  score: number;
}

export interface BeamSearchOptions {
  /** Beam width — how many plans survive each depth level. */
  beamWidth: number;
  /** Safety cap on actions per plan. Defaults to MAX_PLAN_DEPTH. */
  maxDepth?: number;
  /**
   * Optional noise: with this probability, when picking the beam for the
   * next depth, shuffle among the top `noiseTopK` plans instead of always
   * keeping the strict best-K. Used by easier AI difficulty presets so they
   * play plausibly weaker instead of obviously randomly (see ai-config.ts).
   */
  noiseChance?: number;
  noiseTopK?: number;
  rngSeed?: number;
  /** Evaluation weights for MY plans (a personality's tilt); default base. */
  weights?: AIWeights;
}

/** Every unit `player` could still activate or continue acting with right now. */
function actableUnitIds(state: GameState, player: Player): number[] {
  return state.units.filter((u) => u.player === player && u.hp > 0 && !u.done).map((u) => u.id);
}

/**
 * Canonical key for a `GameState`, used to deduplicate plans that reach the
 * same position via different action orderings (e.g. "step right, then down"
 * vs "step down, then right"). Without this the beam fills up with
 * permutations of one underlying plan and loses diversity — see plan step 3.
 *
 * Includes: every living unit's id/position/hp/armor/done/movesLeft/backpack
 * (position + remaining budget fully determines future options for that
 * unit; backpack gates crafting), plus activatedCount and pendingWeaponEquip
 * (both gate what actions are legal next), plus buff/shield timers
 * (evaluate() prices them). Terrain/droppedBackpacks/hiddenPickups are
 * omitted: they never change within a single turn in the current action set
 * (no catapult rock-throwing action exists yet), so including them would
 * only slow hashing without ever distinguishing two otherwise-identical plans.
 */
export function stateKey(state: GameState): string {
  // Hot path (one call per candidate plan per beam depth): a plain string
  // build in a fixed part order, no per-unit sort/localeCompare. Unit array
  // order is stable across plans (the reducer never reorders units), so the
  // old sort of the unit strings bought nothing.
  let key = '';
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    const bp = u.backpack;
    key += `${u.id}:${u.row},${u.col},${u.hp},${u.armor},${u.done ? 1 : 0},${u.movesLeft},[${bp[PARTS[0]!] ?? 0},${bp[PARTS[1]!] ?? 0},${bp[PARTS[2]!] ?? 0},${bp[PARTS[3]!] ?? 0},${bp[PARTS[4]!] ?? 0}]|`;
  }
  const pending = state.pendingWeaponEquip ? state.pendingWeaponEquip.name : '-';
  return `${key}#${state.activatedCount}#${pending}#${state.shieldTurns[1]},${state.shieldTurns[2]}#${state.damageBuff[1]},${state.damageBuff[2]}`;
}

/** Deduplicate plans by stateKey, keeping the first (highest-scored, since
 * callers sort before calling this) occurrence of each distinct position. */
function dedupe(plans: Plan[]): Plan[] {
  const seen = new Set<string>();
  const out: Plan[] = [];
  for (const p of plans) {
    const key = stateKey(p.state);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Mulberry32-driven shuffle-among-top-K, for noiseChance. Deterministic given rngSeed. */
function pickWithNoise(sorted: Plan[], k: number, noiseChance: number, noiseTopK: number, rng: Rng): Plan[] {
  if (noiseChance <= 0) return sorted.slice(0, k);
  const pool = [...sorted];
  const out: Plan[] = [];
  while (out.length < k && pool.length > 0) {
    if (rng.next() < noiseChance && pool.length > 1) {
      const topK = Math.min(noiseTopK, pool.length);
      const idx = Math.floor(rng.next() * topK);
      out.push(pool.splice(idx, 1)[0]!);
    } else {
      out.push(pool.shift()!);
    }
  }
  return out;
}

/**
 * Core beam search loop shared by `planTurn` and `planTurnWithReply`. Walks
 * `me`'s turn depth by depth, returns every surviving plan sorted best-first
 * (deduplicated by `stateKey`, width-capped), plus the single best plan seen
 * at ANY depth (not just the final one — a plan that peaks early and then
 * only gets worse must not lose to a deeper-but-worse one).
 */
function searchPlans(
  root: GameState,
  me: Player,
  options: BeamSearchOptions,
): { beam: Plan[]; best: Plan; all: Plan[] } {
  const maxDepth = options.maxDepth ?? MAX_PLAN_DEPTH;
  const noiseChance = options.noiseChance ?? 0;
  const noiseTopK = options.noiseTopK ?? 3;
  // A single seeded Rng drives every applyAction call this search makes
  // (move/attack scoring inside candidateActions, and any search-ruins/
  // draw-artifact loot roll a candidate might trigger) AND the noise
  // shuffle below. Previously each applyAction call got its OWN
  // nondetRng() (Math.random()-backed) — invisible in the returned
  // ACTIONS, but each throwaway "what does this move do" simulation still
  // consumed a real random loot draw when the branch touched ruins, so two
  // runs against the identical position and seed could genuinely pick
  // different plans. Measured: the same arena seed produced a real beam
  // loss to greedy on one run and a draw on another. One shared seeded Rng
  // makes `planTurn`/`planTurnWithReply` a pure function of (state, me,
  // options) — same inputs, same plan, every time.
  const rng = mulberry32(options.rngSeed ?? 1);

  const rootPlan: Plan = { actions: [], state: root, score: evaluate(root, me, options.weights) };
  let beam: Plan[] = [rootPlan];
  let best: Plan = rootPlan;
  // Every depth's surviving beam, so reply lookahead can pick finalists that
  // stop early (e.g. "kill and stop") instead of only the deepest plans.
  const all: Plan[] = [rootPlan];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: Plan[] = [];

    for (const plan of beam) {
      if (plan.score > best.score) best = plan;
      if (plan.state.winner !== null) continue; // terminal — nothing more to plan
      for (const unitId of actableUnitIds(plan.state, me)) {
        for (const action of candidateActions(plan.state, unitId, rng)) {
          const result = applyAction(plan.state, action, rng);
          if (!result.ok) continue; // filtered-but-illegal shouldn't happen; skip defensively
          next.push({
            actions: [...plan.actions, action],
            state: result.value,
            score: evaluate(result.value, me, options.weights),
          });
        }
      }
    }

    if (next.length === 0) break;
    next.sort((a, b) => b.score - a.score);
    const deduped = dedupe(next);
    const width = Math.max(1, options.beamWidth);
    beam = noiseChance > 0 ? pickWithNoise(deduped, width, noiseChance, noiseTopK, rng) : deduped.slice(0, width);
    all.push(...beam);
  }

  for (const plan of beam) if (plan.score > best.score) best = plan;
  return { beam, best, all };
}

/**
 * Beam search over one player's turn. Returns the action sequence
 * (`ServerAction[]`) with the best resulting `evaluate(finalState, me)` found
 * — a "stop here" option is implicitly included at every depth (a plan that
 * stops improving is simply never extended, and the best-scoring plan seen
 * across all depths wins, not just the deepest one).
 *
 * NOTE: this is pure static evaluation — it scores the position right after
 * `me`'s own move, without looking at how the opponent could reply. That is
 * exactly the gap `planTurnWithReply` closes (plan step 4): a plan can look
 * great by this function's own lights and still hang two units for a single
 * kill, because nothing here prices in the opponent's next turn.
 */
export function planTurn(root: GameState, me: Player, options: BeamSearchOptions): ServerAction[] {
  return searchPlans(root, me, options).best.actions;
}

/**
 * The `count` best distinct plans the beam found at ANY depth (deduplicated by
 * resulting position, best-first) — the candidate list for searches that
 * re-rank plans by something deeper than the static evaluation.
 */
export function candidatePlans(root: GameState, me: Player, options: BeamSearchOptions, count: number): Plan[] {
  const { all } = searchPlans(root, me, options);
  return dedupe([...all].sort((a, b) => b.score - a.score)).slice(0, Math.max(1, count));
}

export interface ReplySearchOptions extends BeamSearchOptions {
  /**
   * How many of THIS beam's top-scoring finalists get a full opponent-reply
   * lookahead. Keep small — this is the expensive part: each candidate costs
   * a full nested `planTurn` call. Defaults to 5.
   */
  replyCandidates?: number;
  /** Beam width used for the OPPONENT's simulated reply search. Deliberately
   * narrow — plan step 4 calls for "the same beam, but narrow: 3-5" since
   * this runs once per candidate rather than once per turn. Defaults to 4. */
  replyBeamWidth?: number;
  /** Safety cap on the opponent reply plan's depth. Defaults to MAX_PLAN_DEPTH. */
  replyMaxDepth?: number;
}

/**
 * `planTurn`, but the top `replyCandidates` finalists are re-ranked by how
 * the position looks after the opponent's own best reply, not just
 * immediately after `me`'s move. This is what actually rejects the
 * "both-attackers-hang" suicide combo shape that pure `planTurn` cannot see
 * (see beam.test.ts's documented KNOWN LIMITATION) — a plan that exposes two
 * units gets punished in the score once the opponent's best reply is
 * simulated and kills them back.
 *
 * Cost: `replyCandidates` × (a full nested beam search at `replyBeamWidth`).
 * If a finalist's plan already ends the match (castle capture / opponent
 * wipeout), its reply is skipped — there is no next turn to look ahead into,
 * and simulating one would just waste the budget.
 */
export function planTurnWithReply(
  root: GameState,
  me: Player,
  options: ReplySearchOptions,
): ServerAction[] {
  const { all } = searchPlans(root, me, options);
  const beam = dedupe([...all].sort((a, b) => b.score - a.score));
  if (beam.length === 0) return [];

  const opp: Player = me === 1 ? 2 : 1;
  const replyCandidates = options.replyCandidates ?? 5;
  const replyBeamWidth = options.replyBeamWidth ?? 4;
  const replyMaxDepth = options.replyMaxDepth ?? MAX_PLAN_DEPTH;

  const finalists = beam.slice(0, Math.max(1, replyCandidates));

  let bestFinalist = finalists[0]!;
  let bestReplyScore = -Infinity;

  for (const plan of finalists) {
    if (plan.state.winner !== null) {
      // Game-ending plan (e.g. undefended castle capture) — nothing to look
      // ahead into. evaluate() already prices the win at castle.captureUndefended,
      // so it wins the comparison outright unless another finalist also ends
      // the game (then whichever evaluate() prefers, prefer).
      const score = evaluate(plan.state, me);
      if (score > bestReplyScore) {
        bestReplyScore = score;
        bestFinalist = plan;
      }
      continue;
    }
    const afterEndTurn = endTurn(plan.state);
    const { best: oppBest } = searchPlans(afterEndTurn, opp, {
      beamWidth: replyBeamWidth,
      maxDepth: replyMaxDepth,
    });
    // Score the position after their best reply from MY perspective.
    // evaluate() is not antisymmetric (hanging pieces, raid threat and
    // retreat terms are one-sided), so −evaluate(…, opp) is a different
    // function: it ignored my own hanging units and let hard/impossible pick
    // plans that look bad for the opponent instead of good for me.
    const replyScore = evaluate(oppBest.state, me);
    if (replyScore > bestReplyScore) {
      bestReplyScore = replyScore;
      bestFinalist = plan;
    }
  }

  return bestFinalist.actions;
}
