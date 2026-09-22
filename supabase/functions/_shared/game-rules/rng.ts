// AUTO-VENDORED from packages/game-rules/src/rng.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
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
export function mulberry32(seed: number, startCursor = 0): Rng {
  let s = seed >>> 0;
  let cursor = 0;
  // Burn cursor samples to align with replay state.
  for (let i = 0; i < startCursor; i += 1) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    cursor += 1;
  }
  return {
    next: () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      cursor += 1;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    cursor: () => cursor,
  };
}

/** Non-deterministic RNG that wraps Math.random. cursor() is meaningless. */
export function nondetRng(): Rng {
  return {
    next: () => Math.random(),
    cursor: () => 0,
  };
}

/**
 * Seeded analogue of `randomChoice` from board.ts. The legacy function uses
 * Math.random and stays as-is for the web client; server code calls this
 * variant with the match's Rng.
 */
export function randomChoiceWith<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('randomChoiceWith: empty array');
  const idx = Math.floor(rng.next() * arr.length);
  return arr[idx] as T;
}

/** Seeded analogue of `weightedChoice`. */
export function weightedChoiceWith<T>(
  rng: Rng,
  items: readonly T[],
  weights: readonly number[],
): T {
  if (items.length === 0) throw new Error('weightedChoiceWith: empty items');
  if (items.length !== weights.length) {
    throw new Error('weightedChoiceWith: items/weights length mismatch');
  }
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) throw new Error('weightedChoiceWith: total weight is 0');
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i] as number;
    if (r < 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}
