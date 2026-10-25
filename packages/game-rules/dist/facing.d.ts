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
export declare const BACK_DAMAGE_MULTIPLIER = 2;
export declare const SIDE_DAMAGE_MULTIPLIER = 1.25;
/** Extra moves to act into your own back half. */
export declare const TURN_COST = 1;
export declare const FACINGS: readonly Facing[];
export declare function isFacing(v: unknown): v is Facing;
/** Default facing at match start: toward the other half of the board. */
export declare function defaultFacingForRow(row: number, rows?: number): Facing;
/** The facing a unit without one is treated as having (canonical orientation:
 *  player 1 starts at the top). */
export declare function facingOf(u: {
    facing?: Facing | null;
    player: number;
}): Facing;
export type Half = 'front' | 'side' | 'back';
/** Which half of the square around a unit facing `f` the cell offset (dr, dc) is in. */
export declare function halfOf(f: Facing, dr: number, dc: number): Half;
/** Extra move cost for `u` to step or strike toward (row, col). */
export declare function turnCost(u: {
    row: number;
    col: number;
    facing?: Facing | null;
    player: number;
}, row: number, col: number): number;
/** Damage multiplier for a hit on `target` coming from the cell (fromRow, fromCol). */
export declare function facingDamageMultiplier(target: {
    row: number;
    col: number;
    facing?: Facing | null;
    player: number;
}, fromRow: number, fromCol: number): number;
/** `damage` after the facing multiplier (rounded; never turns a hit into 0). */
export declare function applyFacingDamage(damage: number, target: {
    row: number;
    col: number;
    facing?: Facing | null;
    player: number;
}, fromRow: number, fromCol: number): number;
/** The facing that looks from (r1,c1) toward (r2,c2): dominant axis, vertical on ties. */
export declare function facingToward(r1: number, c1: number, r2: number, c2: number, fallback?: Facing): Facing;
/** The same facing with rows mirrored (up ↔ down) — for the web's flipped board. */
export declare function flipFacing(f: Facing): Facing;
//# sourceMappingURL=facing.d.ts.map