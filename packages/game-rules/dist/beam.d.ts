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
import { type ServerAction } from './apply.js';
import type { GameState } from './state.js';
import type { Player } from './types.js';
/** Safety cap on plan length. 3 activations × up to 3 move points is the
 * realistic ceiling; this just stops runaway search if that assumption ever
 * breaks (e.g. a future unit type with more moves). */
export declare const MAX_PLAN_DEPTH = 12;
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
export declare function stateKey(state: GameState): string;
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
export declare function planTurn(root: GameState, me: Player, options: BeamSearchOptions): ServerAction[];
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
export declare function planTurnWithReply(root: GameState, me: Player, options: ReplySearchOptions): ServerAction[];
//# sourceMappingURL=beam.d.ts.map