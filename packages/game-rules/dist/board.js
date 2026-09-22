import { COLS, ROWS } from './constants.js';
export function insideBoard(row, col) {
    return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}
export function manhattan(r1, c1, r2, c2) {
    return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}
export function clamp(n, min, max) {
    if (n < min)
        return min;
    if (n > max)
        return max;
    return n;
}
export function randomChoice(arr) {
    if (arr.length === 0) {
        throw new Error('randomChoice: empty array');
    }
    const idx = Math.floor(Math.random() * arr.length);
    return arr[idx];
}
/**
 * Weighted random pick. `weights[i]` corresponds to `items[i]`.
 * Throws if items is empty or sum of weights is 0.
 */
export function weightedChoice(items, weights) {
    if (items.length === 0) {
        throw new Error('weightedChoice: empty items');
    }
    if (items.length !== weights.length) {
        throw new Error('weightedChoice: items/weights length mismatch');
    }
    let total = 0;
    for (const w of weights)
        total += w;
    if (total <= 0) {
        throw new Error('weightedChoice: total weight is 0');
    }
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r < 0)
            return items[i];
    }
    return items[items.length - 1];
}
//# sourceMappingURL=board.js.map