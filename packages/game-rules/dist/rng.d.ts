/**
 * Phase 1.5 S3 — deterministic and non-deterministic RNG primitives.
 *
 * The server (Phase 3-4) needs every random outcome (ruins loot, AI seed,
 * etc.) to be reproducible from a per-match seed so that:
 *   1. Match replay reconstructs the same loot from the action log;
 *   2. Match audit can verify outcomes after the fact;
 *   3. Anti-cheat can reject any client-supplied "randomness".
 *
 * The web client (single-player) keeps using Math.random via `nondetRng()`
 * so we don't disturb existing balance during the bridge phase.
 */
/** Stateful RNG that returns floats in [0, 1) and tracks a step counter. */
export interface Rng {
    /** Advance and return the next sample. */
    next(): number;
    /** Number of samples consumed since the seed was set. */
    cursor(): number;
}
/**
 * mulberry32 — fast, well-distributed seedable PRNG. 32-bit state, period
 * ≈ 2^32. Plenty for a single match (we'll consume tens to hundreds of
 * samples per match, not millions).
 *
 * If `startCursor` is provided, the RNG fast-forwards that many samples
 * before returning anything. Used to resume a partially-played match
 * server-side: replay state can capture (seed, cursor) and rebuild RNG
 * position deterministically.
 */
export declare function mulberry32(seed: number, startCursor?: number): Rng;
/** Non-deterministic RNG that wraps Math.random. cursor() is meaningless. */
export declare function nondetRng(): Rng;
/**
 * Seeded analogue of `randomChoice` from board.ts. The legacy function uses
 * Math.random and stays as-is for the web client; server code calls this
 * variant with the match's Rng.
 */
export declare function randomChoiceWith<T>(rng: Rng, arr: readonly T[]): T;
/** Seeded analogue of `weightedChoice`. */
export declare function weightedChoiceWith<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T;
//# sourceMappingURL=rng.d.ts.map