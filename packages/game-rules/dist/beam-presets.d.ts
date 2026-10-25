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
import { type BeamSearchOptions, type ReplySearchOptions } from './beam.js';
import { type FirstPassScore, type RolloutPick } from './rollout.js';
import type { ServerAction } from './apply.js';
import type { GameState } from './state.js';
import type { Player } from './types.js';
import { type AIWeights } from './evaluate.js';
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
    /** When set, re-rank the beam's best `candidates` plans by playing each out
     *  `turns` half-turns with greedy on both sides (rollout.ts) — replaces the
     *  reply lookahead, which measured no stronger than plain greedy. */
    rollout?: {
        candidates: number;
        turns: number;
        replies?: number;
        replyBeamWidth?: number;
        samples?: number;
        noise?: number;
        finalists?: number;
    };
}
/** The weight set `config` evaluates with (a personality scales this one).
 *  Always the base ai-weights.json: weights fitted to greedy-vs-greedy
 *  outcomes were tried for the top level and measured badly worse (it lost
 *  even to easy), so there is one evaluation for every level. */
export declare function baseWeightsFor(_config: BeamDifficultyConfig): AIWeights;
export type BeamDifficulty = 'easy' | 'medium' | 'hard' | 'expert' | 'impossible';
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
export declare const BEAM_DIFFICULTY: Record<BeamDifficulty, BeamDifficultyConfig>;
/** Convert a difficulty preset into the options `planTurn` expects. */
export declare function toBeamOptions(config: BeamDifficultyConfig): BeamSearchOptions;
/** Convert a difficulty preset into the options `planTurnWithReply` expects. */
export declare function toReplyOptions(config: BeamDifficultyConfig): ReplySearchOptions;
/** The one entry point every caller (web bridge, ladder) plans a turn through,
 *  so the measured ladder and the shipped game run the exact same search. */
export declare function planTurnFor(state: GameState, me: Player, config: BeamDifficultyConfig, rngSeed?: number, weights?: AIWeights): ServerAction[];
/**
 * One thread's share of planTurnFor: slice `slice` of `slices`. Merge the
 * slices with mergeRolloutPicks — the result equals planTurnFor exactly.
 * Presets without rollouts aren't split: slice 0 plans the whole turn.
 */
export declare function planTurnSliceFor(state: GameState, me: Player, config: BeamDifficultyConfig, rngSeed: number, weights: AIWeights | undefined, slice: number, slices: number): RolloutPick;
/** True when planning this preset takes two parallel passes (first pass, then finalists). */
export declare function isTwoPass(config: BeamDifficultyConfig): boolean;
/** Two-pass preset, pass 1: one thread's first-sample scores. Merge by concatenation. */
export declare function planTurnFirstPassFor(state: GameState, me: Player, config: BeamDifficultyConfig, rngSeed: number, weights: AIWeights | undefined, slice: number, slices: number): FirstPassScore[];
/** Two-pass preset, pass 2: one thread's share of the finalists (`selectFinalists` of the merged pass 1). */
export declare function planTurnFinalSliceFor(state: GameState, me: Player, config: BeamDifficultyConfig, rngSeed: number, weights: AIWeights | undefined, finalists: readonly FirstPassScore[], slice: number, slices: number): RolloutPick;
//# sourceMappingURL=beam-presets.d.ts.map