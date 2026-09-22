import type { HiddenPickup, RuinsArea, TerrainCell, TowerPosition } from './types.js';
import type { SerializedUnit } from './save.js';
export interface MatchSetup {
    units: SerializedUnit[];
    towers: TowerPosition[];
    ruins: RuinsArea;
    /** Second ruins area (two ruins on the map). */
    ruins2: RuinsArea;
    castleP1Col: number;
    castleP2Col: number;
    terrain: TerrainCell[];
    /** Hidden artifacts/weapons/armour buried across the board for this match. */
    hiddenPickups: HiddenPickup[];
}
/**
 * Build a fresh, deterministic match from `seed`. Canonical orientation:
 * player 1 occupies the top rows, player 2 the bottom (the client flips for
 * rendering based on which side it controls). Castles are 4×4 at cols 0–6;
 * ruins are a 2×2 in the mid-board avoiding both castle footprints; two tower
 * columns sit on rows 5 and 14.
 */
export declare function createMatchSetup(seed: number): MatchSetup;
//# sourceMappingURL=setup.d.ts.map