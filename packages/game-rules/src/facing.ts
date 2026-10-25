/**
 * Facing — every unit looks one of 4 ways, and that splits the square around
 * it into halves:
 *
 *   facing 'up':   . F F F .      F = front half (rows above)
 *                  . s U s .      s = side (the unit's own row/col line)
 *                  . B B B .      B = back half (rows below)
 *
 * Rules (shared by the server reducer, the offline client and the AI):
 *   - a hit landing from the target's back half deals ×2, from its side ×1.25
 *     (rounded), from its front ×1;
 *   - acting INTO your own back half (stepping or striking backwards) costs
 *     +1 move — the unit turns round first, no separate button;
 *   - after a step the unit faces the way it walked; after a strike that
 *     made it turn, it faces its target.
 *
 * Directions are in whatever row orientation the caller uses (canonical in
 * game-rules, live/flipped in the web client) — `down` simply means "row + 1".
 */
import type { Facing } from './types.js';

export const BACK_DAMAGE_MULTIPLIER = 2;
export const SIDE_DAMAGE_MULTIPLIER = 1.25;
/** Extra moves to act into your own back half. */
export const TURN_COST = 1;

const VEC: Record<Facing, readonly [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

export const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right'];

export function isFacing(v: unknown): v is Facing {
  return v === 'up' || v === 'down' || v === 'left' || v === 'right';
}

/** Default facing at match start: toward the other half of the board. */
export function defaultFacingForRow(row: number, rows = 20): Facing {
  return row < rows / 2 ? 'down' : 'up';
}

/** The facing a unit without one is treated as having (canonical orientation:
 *  player 1 starts at the top). */
export function facingOf(u: { facing?: Facing | null; player: number }): Facing {
  return u.facing ?? (u.player === 1 ? 'down' : 'up');
}

export type Half = 'front' | 'side' | 'back';

/** Which half of the square around a unit facing `f` the cell offset (dr, dc) is in. */
export function halfOf(f: Facing, dr: number, dc: number): Half {
  if (dr === 0 && dc === 0) return 'front'; // its own cell: no direction at all
  const [fr, fc] = VEC[f];
  const dot = dr * fr + dc * fc;
  return dot > 0 ? 'front' : dot < 0 ? 'back' : 'side';
}

/** Extra move cost for `u` to step or strike toward (row, col). */
export function turnCost(u: { row: number; col: number; facing?: Facing | null; player: number }, row: number, col: number): number {
  return halfOf(facingOf(u), row - u.row, col - u.col) === 'back' ? TURN_COST : 0;
}

/** Damage multiplier for a hit on `target` coming from the cell (fromRow, fromCol). */
export function facingDamageMultiplier(
  target: { row: number; col: number; facing?: Facing | null; player: number },
  fromRow: number,
  fromCol: number,
): number {
  const h = halfOf(facingOf(target), fromRow - target.row, fromCol - target.col);
  return h === 'back' ? BACK_DAMAGE_MULTIPLIER : h === 'side' ? SIDE_DAMAGE_MULTIPLIER : 1;
}

/** `damage` after the facing multiplier (rounded; never turns a hit into 0). */
export function applyFacingDamage(
  damage: number,
  target: { row: number; col: number; facing?: Facing | null; player: number },
  fromRow: number,
  fromCol: number,
): number {
  if (damage <= 0) return damage;
  return Math.max(1, Math.round(damage * facingDamageMultiplier(target, fromRow, fromCol)));
}

/** The facing that looks from (r1,c1) toward (r2,c2): dominant axis, vertical on ties. */
export function facingToward(r1: number, c1: number, r2: number, c2: number, fallback: Facing = 'up'): Facing {
  const dr = r2 - r1;
  const dc = c2 - c1;
  if (dr === 0 && dc === 0) return fallback;
  if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? 'down' : 'up';
  return dc > 0 ? 'right' : 'left';
}

/** The same facing with rows mirrored (up ↔ down) — for the web's flipped board. */
export function flipFacing(f: Facing): Facing {
  return f === 'up' ? 'down' : f === 'down' ? 'up' : f;
}
