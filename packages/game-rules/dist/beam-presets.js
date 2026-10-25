/**
 * Beam-search difficulty presets — plan step 5.
 *
 * Deliberately a NEW, separate config surface from
 * `packages/web/src/game/ai-config.ts`'s `AIConfig`/`AI_DIFFICULTY`, not a
 * replacement of it yet. That file's ~30 fields are wired into the current
 * MCTS/minimax/combo engine end to end; rewriting it now, before step 6 (the
 * AIPlayer bridge) exists to consume a beam-based plan, would leave the game
 * temporarily unplayable with no fallback. `BeamDifficulty` is what step 6's
 * bridge will read once it's plugged in, and what step 8 promotes to replace
 * `AIConfig` outright once the arena (step 7) proves it's stronger.
 *
 * Only three knobs, matching the plan exactly:
 *   - K: beam width — how many candidate turn-plans survive each expansion.
 *   - reply: whether to spend the extra budget on planTurnWithReply's
 *     opponent-reply lookahead, or the cheaper reply-blind planTurn.
 *   - noise: chance of taking a top-3 (not strictly best) plan at each beam
 *     step, so weak presets vary and miss the sharpest line without ever
 *     blundering into obvious death (mirrors the "no blunders" philosophy
 *     ai-config.ts documents for the existing presets).
 */
import { planTurn, planTurnWithReply } from './beam.js';
import { planTurnRollout, planTurnRolloutSlice, rolloutFirstPass } from './rollout.js';
import { W } from './evaluate.js';
/** The weight set `config` evaluates with (a personality scales this one).
 *  Always the base ai-weights.json: weights fitted to greedy-vs-greedy
 *  outcomes were tried for the top level and measured badly worse (it lost
 *  even to easy), so there is one evaluation for every level. */
export function baseWeightsFor(_config) {
    return W;
}
/**
 * The difficulty ladder, measured on the real engine with
 * scripts/ladder.mjs (each map twice, sides swapped, army value adjudicated
 * at the turn limit). Every level must beat every weaker one and
 * `impossible` must not lose — re-run the ladder after any rules change:
 *
 *   node scripts/ladder.mjs --games 8 --players easy,medium,hard,impossible
 *
 * What separates them is how far ahead each one looks, not handicaps:
 *   easy       — one action at a time, any of the 3 best (never the worst)
 *   medium     — 6 candidate turn-plans, each played out 3 half-turns
 *                (measured: beats easy 10-2, loses to hard 2-10)
 *   hard       — 20 candidate turn-plans, each played out 5 half-turns
 *   impossible — 32 × 7, each played out 3× against a noisy opponent
 * Static-eval lookahead (wide beams, the old reply search) measured no
 * stronger than greedy; playing the candidates out is what made the gap.
 */
export const BEAM_DIFFICULTY = {
    easy: {
        label: 'Слабый',
        beamWidth: 1,
        reply: false,
        replyBeamWidth: 1,
        replyCandidates: 1,
        noise: 1,
    },
    medium: {
        label: 'Средний',
        beamWidth: 6,
        reply: false,
        replyBeamWidth: 1,
        replyCandidates: 1,
        noise: 0,
        rollout: { candidates: 6, turns: 3 },
    },
    hard: {
        label: 'Сложный',
        beamWidth: 12,
        reply: false,
        replyBeamWidth: 1,
        replyCandidates: 1,
        noise: 0,
        rollout: { candidates: 20, turns: 5 },
    },
    // Kept for the existing 'expert' key; sits between hard and impossible.
    expert: {
        label: 'Эксперт',
        beamWidth: 16,
        reply: false,
        replyBeamWidth: 1,
        replyCandidates: 1,
        noise: 0,
        rollout: { candidates: 32, turns: 7 },
    },
    // Robust playouts: each candidate played out 3× with the side to move
    // taking a top-3 (not always the best) action 30% of the time, averaged.
    // Measured vs the plain 32×7 playout (now `expert`): beat `hard` 8-0-0
    // where plain managed 6-1-1, and beat plain itself 5-3. Deeper plain
    // playouts (48×9) and reply minimax gained nothing.
    impossible: {
        label: 'Невозможный',
        beamWidth: 16,
        reply: false,
        replyBeamWidth: 1,
        replyCandidates: 1,
        noise: 0,
        rollout: { candidates: 32, turns: 7, samples: 3, noise: 0.3, finalists: 8 },
    },
};
/** Convert a difficulty preset into the options `planTurn` expects. */
export function toBeamOptions(config) {
    return {
        beamWidth: config.beamWidth,
        noiseChance: config.noise,
        noiseTopK: 3,
    };
}
/** Convert a difficulty preset into the options `planTurnWithReply` expects. */
export function toReplyOptions(config) {
    return {
        ...toBeamOptions(config),
        replyBeamWidth: config.replyBeamWidth,
        replyCandidates: config.replyCandidates,
    };
}
/** The one entry point every caller (web bridge, ladder) plans a turn through,
 *  so the measured ladder and the shipped game run the exact same search. */
export function planTurnFor(state, me, config, rngSeed = 1, weights) {
    if (config.rollout) {
        return planTurnRollout(state, me, {
            ...toBeamOptions(config),
            rngSeed,
            weights,
            candidates: config.rollout.candidates,
            rolloutTurns: config.rollout.turns,
            replies: config.rollout.replies,
            replyBeamWidth: config.rollout.replyBeamWidth,
            samples: config.rollout.samples,
            noise: config.rollout.noise,
            finalists: config.rollout.finalists,
        });
    }
    return config.reply
        ? planTurnWithReply(state, me, { ...toReplyOptions(config), rngSeed, weights })
        : planTurn(state, me, { ...toBeamOptions(config), rngSeed, weights });
}
/**
 * One thread's share of planTurnFor: slice `slice` of `slices`. Merge the
 * slices with mergeRolloutPicks — the result equals planTurnFor exactly.
 * Presets without rollouts aren't split: slice 0 plans the whole turn.
 */
export function planTurnSliceFor(state, me, config, rngSeed, weights, slice, slices) {
    if (!config.rollout) {
        return slice === 0
            ? { index: 0, score: 0, actions: planTurnFor(state, me, config, rngSeed, weights) }
            : { index: -1, score: -Infinity, actions: [] };
    }
    return planTurnRolloutSlice(state, me, {
        ...toBeamOptions(config),
        rngSeed,
        weights,
        candidates: config.rollout.candidates,
        rolloutTurns: config.rollout.turns,
        replies: config.rollout.replies,
        replyBeamWidth: config.rollout.replyBeamWidth,
        samples: config.rollout.samples,
        noise: config.rollout.noise,
        finalists: config.rollout.finalists,
    }, slice, slices);
}
/** True when planning this preset takes two parallel passes (first pass, then finalists). */
export function isTwoPass(config) {
    const r = config.rollout;
    return !!r && !!r.finalists && (r.samples ?? 1) > 1 && !r.replies;
}
function rolloutOptionsFor(config, rngSeed, weights) {
    const r = config.rollout;
    return {
        ...toBeamOptions(config),
        rngSeed,
        weights,
        candidates: r.candidates,
        rolloutTurns: r.turns,
        replies: r.replies,
        replyBeamWidth: r.replyBeamWidth,
        samples: r.samples,
        noise: r.noise,
        finalists: r.finalists,
    };
}
/** Two-pass preset, pass 1: one thread's first-sample scores. Merge by concatenation. */
export function planTurnFirstPassFor(state, me, config, rngSeed, weights, slice, slices) {
    return rolloutFirstPass(state, me, rolloutOptionsFor(config, rngSeed, weights), slice, slices);
}
/** Two-pass preset, pass 2: one thread's share of the finalists (`selectFinalists` of the merged pass 1). */
export function planTurnFinalSliceFor(state, me, config, rngSeed, weights, finalists, slice, slices) {
    return planTurnRolloutSlice(state, me, rolloutOptionsFor(config, rngSeed, weights), slice, slices, finalists);
}
//# sourceMappingURL=beam-presets.js.map