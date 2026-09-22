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
import { applyAction } from './apply.js';
import { generateActionsForPlayer } from './actions.js';
import { evaluate } from './evaluate.js';
import { nondetRng } from './rng.js';
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
export function greedyStep(state, player, rng = nondetRng()) {
    const actions = generateActionsForPlayer(state, player);
    let best = null;
    for (const action of actions) {
        const result = applyAction(state, action, rng);
        if (!result.ok)
            continue;
        const score = evaluate(result.value, player);
        if (!best || score > best.score)
            best = { action, state: result.value, score };
    }
    return best ? { action: best.action, state: best.state } : null;
}
/**
 * Play a full greedy turn for `player`: repeatedly take the single best
 * action until nobody can act. Returns the resulting `GameState` (still
 * `player`'s turn — caller is responsible for `endTurn`).
 */
export function greedyTurn(state, player, rng = nondetRng()) {
    let s = state;
    // Bounded by the same realistic ceiling as planTurn's MAX_PLAN_DEPTH — a
    // greedy loop that never terminates would indicate a stuck position, not a
    // legitimately long turn.
    for (let i = 0; i < 12; i++) {
        if (s.winner !== null)
            break;
        const step = greedyStep(s, player, rng);
        if (!step)
            break;
        s = step.state;
    }
    return s;
}
//# sourceMappingURL=greedy.js.map