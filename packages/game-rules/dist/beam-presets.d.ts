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
import type { BeamSearchOptions, ReplySearchOptions } from './beam.js';
export interface BeamDifficultyConfig {
    label: string;
    /** Beam width (K in the plan). */
    beamWidth: number;
    /** Use planTurnWithReply (opponent-reply lookahead) instead of plain planTurn. */
    reply: boolean;
    /** Beam width for the opponent's simulated reply, when reply=true. */
    replyBeamWidth: number;
    /** How many top finalists get a reply lookahead, when reply=true. */
    replyCandidates: number;
    /** Chance of picking a top-3 plan instead of the strict best at each beam step. */
    noise: number;
}
export type BeamDifficulty = 'easy' | 'medium' | 'hard' | 'expert';
export declare const BEAM_DIFFICULTY: Record<BeamDifficulty, BeamDifficultyConfig>;
/** Convert a difficulty preset into the options `planTurn` expects. */
export declare function toBeamOptions(config: BeamDifficultyConfig): BeamSearchOptions;
/** Convert a difficulty preset into the options `planTurnWithReply` expects. */
export declare function toReplyOptions(config: BeamDifficultyConfig): ReplySearchOptions;
//# sourceMappingURL=beam-presets.d.ts.map