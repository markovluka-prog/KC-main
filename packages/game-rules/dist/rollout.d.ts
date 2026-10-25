/**
 * Rollout search — re-ranks the beam's candidate turn-plans by PLAYING THEM
 * OUT instead of trusting the static evaluation of the position right after
 * the plan.
 *
 * Measured on the real engine (scripts/ladder.mjs): every static-eval search
 * here — beam widths 1..260, with or without the opponent-reply lookahead —
 * scored about the same as a plain greedy bot, because evaluate() can't tell a
 * plan that wins a trade two turns later from one that loses it. Playing each
 * candidate forward a few turns with both sides on greedyTurn (cheap: ~5 ms a
 * turn) and scoring THAT position sees the trades actually resolve.
 *
 * Deterministic for a given (state, me, options): greedy is deterministic and
 * every applyAction draws from one seeded Rng.
 */
import { type ServerAction } from './apply.js';
import { type BeamSearchOptions } from './beam.js';
import { type AIWeights } from './evaluate.js';
import type { GameState } from './state.js';
import type { Player } from './types.js';
export interface RolloutSearchOptions extends BeamSearchOptions {
    /** How many of the beam's best distinct plans get played out. */
    candidates: number;
    /** Half-turns simulated after the plan (odd = ends after the opponent's move). */
    rolloutTurns: number;
    /**
     * Minimax over the opponent's reply: when > 0, each candidate is scored by
     * the WORST outcome over the opponent's `replies` best distinct replies
     * (beam at `replyBeamWidth`) plus its greedy reply, each played out. Plain
     * rollouts assume a greedy opponent and misjudge a stronger one.
     */
    replies?: number;
    replyBeamWidth?: number;
    /**
     * Robust playouts: play each candidate out `samples` times, the side to
     * move taking one of its 3 best actions instead of the best with chance
     * `noise`, and average. One deterministic greedy line over-trusts a single
     * predicted future; averaging noisy lines prices in the replies it missed.
     */
    samples?: number;
    noise?: number;
    /**
     * Two-pass halving (needs samples > 1, no replies): every candidate is first
     * scored with ONE sample (`rolloutFirstPass`); only the best `finalists` get
     * the remaining samples (`planTurnRolloutSlice` with `finalists`). Both
     * passes slice the candidates the same way, so threads stay exact.
     */
    finalists?: number;
}
export interface FirstPassScore {
    index: number;
    score: number;
}
/** Play `turns` half-turns of greedy-vs-greedy from `state` (already the
 *  opponent's move) and score the result from `me`'s side. A win sooner
 *  scores higher than a win later; a loss later scores higher than sooner. */
export declare function rolloutValue(state: GameState, me: Player, turns: number, seed: number, weights?: AIWeights, noise?: number): number;
/** Pass 1 for the candidates with index ≡ `slice` (mod `slices`). */
export declare function rolloutFirstPass(root: GameState, me: Player, options: RolloutSearchOptions, slice: number, slices: number): FirstPassScore[];
/** Best `n` of the merged first-pass scores (highest score, ties to lowest index). */
export declare function selectFinalists(scores: readonly FirstPassScore[], n: number): FirstPassScore[];
export interface RolloutPick {
    /** Index of the chosen candidate in candidatePlans() order (-1: none). */
    index: number;
    score: number;
    actions: ServerAction[];
}
/**
 * Score every candidate whose index ≡ `slice` (mod `slices`) and return the
 * best of them — the unit of work for running the rollouts on several
 * threads. Every slice builds the same deterministic candidate list, so the
 * caller merges slices by (highest score, then lowest index), which is
 * exactly what the sequential scan below picks.
 */
export declare function planTurnRolloutSlice(root: GameState, me: Player, options: RolloutSearchOptions, slice: number, slices: number, finalists?: readonly FirstPassScore[]): RolloutPick;
/** Merge per-slice picks: highest score, ties to the lowest index. */
export declare function mergeRolloutPicks(picks: readonly RolloutPick[]): RolloutPick;
/** The candidate plan whose played-out future is best for `me`. */
export declare function planTurnRollout(root: GameState, me: Player, options: RolloutSearchOptions): ServerAction[];
//# sourceMappingURL=rollout.d.ts.map