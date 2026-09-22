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
export const BEAM_DIFFICULTY = {
    easy: {
        label: 'Слабый',
        beamWidth: 1,
        reply: false,
        replyBeamWidth: 2,
        replyCandidates: 2,
        noise: 0.25,
    },
    medium: {
        label: 'Средний',
        beamWidth: 8,
        reply: false,
        replyBeamWidth: 3,
        replyCandidates: 3,
        noise: 0.05,
    },
    hard: {
        label: 'Сложный',
        beamWidth: 60,
        reply: true,
        replyBeamWidth: 5,
        replyCandidates: 10,
        noise: 0,
    },
    expert: {
        label: 'Эксперт',
        beamWidth: 100,
        reply: true,
        replyBeamWidth: 6,
        replyCandidates: 16,
        noise: 0,
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
//# sourceMappingURL=beam-presets.js.map