// AUTO-VENDORED from packages/game-rules/src/board.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
import { COLS, ROWS } from './constants.ts';

export function insideBoard(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

export function manhattan(r1: number, c1: number, r2: number, c2: number): number {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}

export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function randomChoice<T>(arr: readonly T[]): T {
  if (arr.length === 0) {
    throw new Error('randomChoice: empty array');
  }
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx] as T;
}

/**
 * Weighted random pick. `weights[i]` corresponds to `items[i]`.
 * Throws if items is empty or sum of weights is 0.
 */
export function weightedChoice<T>(items: readonly T[], weights: readonly number[]): T {
  if (items.length === 0) {
    throw new Error('weightedChoice: empty items');
  }
  if (items.length !== weights.length) {
    throw new Error('weightedChoice: items/weights length mismatch');
  }
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) {
    throw new Error('weightedChoice: total weight is 0');
  }
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i] as number;
    if (r < 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}
