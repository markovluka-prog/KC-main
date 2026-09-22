/**
 * Greedy baseline agent — plan step 7's arena opponent for `planTurn`.
 *
 * Plays the single best-scoring legal action repeatedly (one activation at a
 * time, no lookahead beyond `evaluate()` on the resulting position) until no
 * unit can act or the activation cap is hit. This is deliberately the
 * simplest possible opponent: no search, no combo detection, no reply
 * awareness — a sanity floor the beam search must clear convincingly before
 * any claim of strength means anything.
 */
import { type ServerAction } from './apply.js';
import { type Rng } from './rng.js';
import type { GameState } from './state.js';
import type { Player } from './types.js';
/**
 * Play one greedy action: score every legal action for `player` by the
 * resulting position's `evaluate(..., player)`, apply the single best one.
 * Returns `null` if the player has no legal actions at all (search a fresh
 * `endTurn` in that case).
 *
 * `rng` defaults to `nondetRng()` for ad hoc/manual use, but the chosen
 * action here is REALLY applied (unlike candidateActions' scratch
 * evaluations) — if it happens to be `search-ruins`/`draw-artifact`, the
 * loot roll is real and consumes `rng`. A caller that wants a reproducible
 * greedy turn (the arena, a regression test) MUST pass its own seeded Rng,
 * or two runs on the same starting state can diverge the moment the greedy
 * side searches ruins.
 */
export declare function greedyStep(state: GameState, player: Player, rng?: Rng): {
    action: ServerAction;
    state: GameState;
} | null;
/**
 * Play a full greedy turn for `player`: repeatedly take the single best
 * action until nobody can act. Returns the resulting `GameState` (still
 * `player`'s turn — caller is responsible for `endTurn`).
 */
export declare function greedyTurn(state: GameState, player: Player, rng?: Rng): GameState;
//# sourceMappingURL=greedy.d.ts.map