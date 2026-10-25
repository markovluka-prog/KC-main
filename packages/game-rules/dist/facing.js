export const BACK_DAMAGE_MULTIPLIER = 2;
export const SIDE_DAMAGE_MULTIPLIER = 1.25;
/** Extra moves to act into your own back half. */
export const TURN_COST = 1;
const VEC = {
    up: [-1, 0],
    down: [1, 0],
    left: [0, -1],
    right: [0, 1],
};
export const FACINGS = ['up', 'down', 'left', 'right'];
export function isFacing(v) {
    return v === 'up' || v === 'down' || v === 'left' || v === 'right';
}
/** Default facing at match start: toward the other half of the board. */
export function defaultFacingForRow(row, rows = 20) {
    return row < rows / 2 ? 'down' : 'up';
}
/** The facing a unit without one is treated as having (canonical orientation:
 *  player 1 starts at the top). */
export function facingOf(u) {
    return u.facing ?? (u.player === 1 ? 'down' : 'up');
}
/** Which half of the square around a unit facing `f` the cell offset (dr, dc) is in. */
export function halfOf(f, dr, dc) {
    if (dr === 0 && dc === 0)
        return 'front'; // its own cell: no direction at all
    const [fr, fc] = VEC[f];
    const dot = dr * fr + dc * fc;
    return dot > 0 ? 'front' : dot < 0 ? 'back' : 'side';
}
/** Extra move cost for `u` to step or strike toward (row, col). */
export function turnCost(u, row, col) {
    return halfOf(facingOf(u), row - u.row, col - u.col) === 'back' ? TURN_COST : 0;
}
/** Damage multiplier for a hit on `target` coming from the cell (fromRow, fromCol). */
export function facingDamageMultiplier(target, fromRow, fromCol) {
    const h = halfOf(facingOf(target), fromRow - target.row, fromCol - target.col);
    return h === 'back' ? BACK_DAMAGE_MULTIPLIER : h === 'side' ? SIDE_DAMAGE_MULTIPLIER : 1;
}
/** `damage` after the facing multiplier (rounded; never turns a hit into 0). */
export function applyFacingDamage(damage, target, fromRow, fromCol) {
    if (damage <= 0)
        return damage;
    return Math.max(1, Math.round(damage * facingDamageMultiplier(target, fromRow, fromCol)));
}
/** The facing that looks from (r1,c1) toward (r2,c2): dominant axis, vertical on ties. */
export function facingToward(r1, c1, r2, c2, fallback = 'up') {
    const dr = r2 - r1;
    const dc = c2 - c1;
    if (dr === 0 && dc === 0)
        return fallback;
    if (Math.abs(dr) >= Math.abs(dc))
        return dr > 0 ? 'down' : 'up';
    return dc > 0 ? 'right' : 'left';
}
/** The same facing with rows mirrored (up ↔ down) — for the web's flipped board. */
export function flipFacing(f) {
    return f === 'up' ? 'down' : f === 'down' ? 'up' : f;
}
//# sourceMappingURL=facing.js.map