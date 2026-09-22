export declare function insideBoard(row: number, col: number): boolean;
export declare function manhattan(r1: number, c1: number, r2: number, c2: number): number;
export declare function clamp(n: number, min: number, max: number): number;
export declare function randomChoice<T>(arr: readonly T[]): T;
/**
 * Weighted random pick. `weights[i]` corresponds to `items[i]`.
 * Throws if items is empty or sum of weights is 0.
 */
export declare function weightedChoice<T>(items: readonly T[], weights: readonly number[]): T;
//# sourceMappingURL=board.d.ts.map