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
import { endTurn } from './apply.js';
import { candidatePlans } from './beam.js';
import { evaluate, unitValue } from './evaluate.js';
import { greedyTurn } from './greedy.js';
import { mulberry32 } from './rng.js';
import { applyAction } from './apply.js';
import { generateActionsForPlayer } from './actions.js';
/** greedyTurn, but each step takes one of the top-3 actions with chance `noise`. */
function noisyGreedyTurn(state, player, rng, noise) {
    let s = state;
    for (let i = 0; i < 12; i++) {
        if (s.winner !== null)
            break;
        const actions = generateActionsForPlayer(s, player);
        const scored = [];
        for (const a of actions) {
            const r = applyAction(s, a, rng);
            if (r.ok)
                scored.push({ st: r.value, v: evaluate(r.value, player) });
        }
        if (scored.length === 0)
            break;
        scored.sort((x, y) => y.v - x.v);
        const pick = rng.next() < noise ? Math.floor(rng.next() * Math.min(3, scored.length)) : 0;
        s = scored[pick].st;
    }
    return s;
}
/** Score far above any evaluate() value, so a forced result always dominates. */
const DECIDED = 10_000_000;
/** Extra weight on material the opponent's immediate reply takes: the playout
 *  opponent is greedy, a real one is not, so a unit left hanging costs more
 *  than the playout alone says. */
const HANGING_EXTRA = 0;
function armyValue(s, p) {
    let v = 0;
    for (const u of s.units)
        if (u.player === p && u.hp > 0)
            v += unitValue(u);
    return v;
}
/** Play `turns` half-turns of greedy-vs-greedy from `state` (already the
 *  opponent's move) and score the result from `me`'s side. A win sooner
 *  scores higher than a win later; a loss later scores higher than sooner. */
export function rolloutValue(state, me, turns, seed, weights, noise = 0) {
    const rng = mulberry32(seed);
    let s = state;
    const mine0 = state.currentPlayer !== me ? armyValue(state, me) : 0;
    let hanging = 0;
    for (let t = 0; t < turns; t++) {
        if (s.winner !== null)
            break;
        s = noise > 0 ? noisyGreedyTurn(s, s.currentPlayer, rng, noise) : greedyTurn(s, s.currentPlayer, rng);
        if (s.winner !== null)
            return (s.winner === me ? 1 : -1) * (DECIDED - t);
        if (t === 0 && mine0 > 0) {
            // Measured against the opponent's BEST (greedy) reply even when the
            // playout itself is noisy — noise would otherwise average the hit away.
            const sure = noise > 0 ? greedyTurn(state, state.currentPlayer, mulberry32(seed + 1)) : s;
            hanging = Math.max(0, mine0 - armyValue(sure, me));
        }
        s = endTurn(s);
    }
    if (s.winner !== null)
        return (s.winner === me ? 1 : -1) * DECIDED;
    return evaluate(s, me, weights) - HANGING_EXTRA * hanging;
}
/** Worst played-out outcome for `me` over the opponent's best replies. */
function replyMinimax(afterMine, me, options, cutoff) {
    const opp = me === 1 ? 2 : 1;
    const seed = options.rngSeed ?? 1;
    const turns = Math.max(0, options.rolloutTurns - 1);
    const replies = candidatePlans(afterMine, opp, { beamWidth: options.replyBeamWidth ?? 6 }, options.replies ?? 0);
    const outcomes = replies.map((r) => r.state);
    outcomes.push(greedyTurn(afterMine, opp, mulberry32(seed)));
    let worst = Infinity;
    for (const o of outcomes) {
        const v = o.winner !== null
            ? (o.winner === me ? 1 : -1) * (DECIDED - 1)
            : rolloutValue(endTurn(o), me, turns, seed, options.weights);
        if (v < worst)
            worst = v;
        // Already worse than a plan we have: this one can't be chosen.
        if (worst <= cutoff)
            break;
    }
    return worst;
}
/** Mean of `samples` playouts (1 = the plain deterministic one). */
function sampledValue(afterMine, me, options) {
    const n = Math.max(1, options.samples ?? 1);
    const seed = options.rngSeed ?? 1;
    if (n === 1)
        return rolloutValue(afterMine, me, options.rolloutTurns, seed, options.weights, options.noise ?? 0);
    let sum = 0;
    for (let k = 0; k < n; k++)
        sum += rolloutValue(afterMine, me, options.rolloutTurns, seed + 7919 * k, options.weights, options.noise ?? 0.3);
    return sum / n;
}
/** Single playout (sample 0) of `afterMine`, as the first pass of halving. */
function firstSampleValue(afterMine, me, options) {
    const seed = options.rngSeed ?? 1;
    return rolloutValue(afterMine, me, options.rolloutTurns, seed, options.weights, options.noise ?? 0.3);
}
/** Pass 1 for the candidates with index ≡ `slice` (mod `slices`). */
export function rolloutFirstPass(root, me, options, slice, slices) {
    const plans = candidatePlans(root, me, options, options.candidates);
    const out = [];
    for (let i = slice; i < plans.length; i += slices) {
        const plan = plans[i];
        const score = plan.state.winner !== null
            ? (plan.state.winner === me ? 1 : -1) * (DECIDED + 1)
            : firstSampleValue(endTurn(plan.state), me, options);
        out.push({ index: i, score });
    }
    return out;
}
/** Best `n` of the merged first-pass scores (highest score, ties to lowest index). */
export function selectFinalists(scores, n) {
    return [...scores].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(1, n));
}
/** Mean over all samples, given sample 0's value from the first pass. */
function finishSampledValue(afterMine, me, options, sample0) {
    const n = Math.max(1, options.samples ?? 1);
    const seed = options.rngSeed ?? 1;
    let sum = sample0;
    for (let k = 1; k < n; k++)
        sum += rolloutValue(afterMine, me, options.rolloutTurns, seed + 7919 * k, options.weights, options.noise ?? 0.3);
    return sum / n;
}
/**
 * Score every candidate whose index ≡ `slice` (mod `slices`) and return the
 * best of them — the unit of work for running the rollouts on several
 * threads. Every slice builds the same deterministic candidate list, so the
 * caller merges slices by (highest score, then lowest index), which is
 * exactly what the sequential scan below picks.
 */
export function planTurnRolloutSlice(root, me, options, slice, slices, finalists) {
    const plans = candidatePlans(root, me, options, options.candidates);
    let best = { index: -1, score: -Infinity, actions: plans[0]?.actions ?? [] };
    const first = finalists ? new Map(finalists.map((f) => [f.index, f.score])) : null;
    for (let i = slice; i < plans.length; i += slices) {
        if (first && !first.has(i))
            continue;
        const plan = plans[i];
        const score = plan.state.winner !== null
            ? (plan.state.winner === me ? 1 : -1) * (DECIDED + 1)
            : first
                ? finishSampledValue(endTurn(plan.state), me, options, first.get(i))
                : options.replies
                    ? replyMinimax(endTurn(plan.state), me, options, best.score)
                    : sampledValue(endTurn(plan.state), me, options);
        if (score > best.score)
            best = { index: i, score, actions: plan.actions };
    }
    return best;
}
/** Merge per-slice picks: highest score, ties to the lowest index. */
export function mergeRolloutPicks(picks) {
    let best = picks[0];
    for (const p of picks) {
        if (p.index < 0)
            continue;
        if (best.index < 0 || p.score > best.score || (p.score === best.score && p.index < best.index))
            best = p;
    }
    return best;
}
/** The candidate plan whose played-out future is best for `me`. */
export function planTurnRollout(root, me, options) {
    if (options.finalists && (options.samples ?? 1) > 1 && !options.replies) {
        const top = selectFinalists(rolloutFirstPass(root, me, options, 0, 1), options.finalists);
        return planTurnRolloutSlice(root, me, options, 0, 1, top).actions;
    }
    return planTurnRolloutSlice(root, me, options, 0, 1).actions;
}
//# sourceMappingURL=rollout.js.map