import type { Rng } from './rng.js';
import type { HiddenPickup, TerrainCell, TowerPosition } from './types.js';
export interface ScatterOptions {
    castleP1Col: number;
    castleP2Col: number;
    towers: readonly TowerPosition[];
    /** Cells of the starting roster — knights and friends must not sit on loot. */
    occupied: readonly {
        row: number;
        col: number;
    }[];
    /**
     * Map terrain. Anything a unit can't stand on (river, mountain, rock) is
     * excluded — loot buried there would be unreachable forever. Bridges stay
     * eligible since units walk across them.
     */
    terrain?: readonly TerrainCell[];
}
/**
 * Cells that may never hold a hidden pickup: both castle zones, every tower,
 * every starting unit's cell, and every impassable terrain feature.
 */
export declare function buildExcludedCells(opts: ScatterOptions): Set<string>;
/**
 * Scatter every entry of HIDDEN_PICKUP_SPAWN across the free cells of the
 * board. Each entry claims `round(percent% × ROWS × COLS)` distinct cells; one
 * cell holds at most one pickup.
 */
export declare function scatterHiddenPickups(rng: Rng, opts: ScatterOptions): HiddenPickup[];
/** The pickup buried at (row,col), or null. */
export declare function pickupAt(pickups: readonly HiddenPickup[], row: number, col: number): HiddenPickup | null;
/** All pickups except the one at (row,col) — used after a unit claims it. */
export declare function removePickupAt(pickups: readonly HiddenPickup[], row: number, col: number): HiddenPickup[];
//# sourceMappingURL=pickups.d.ts.map