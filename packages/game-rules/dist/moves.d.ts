import type { Action, AttackAction, BoardLike, MoveAction, UnitState } from './types.js';
export declare const ALL8_DIRS: ReadonlyArray<readonly [number, number]>;
export declare const CATAPULT_MIN_RANGE = 3;
export declare const CATAPULT_MAX_RANGE = 6;
/** Crossbow piercing bolt: how many cells deep it flies along its line. */
export declare const CROSSBOW_PIERCE_RANGE = 2;
/** Crossbow piercing bolt: flat move cost, regardless of how many cells hold a unit. */
export declare const CROSSBOW_PIERCE_COST = 2;
/**
 * Move points a cavalry unit spends to leap a one-cell river. Matches its jump
 * attack cost so crossing is a real commitment, not free mobility.
 */
export declare const CAVALRY_RIVER_JUMP_COST = 2;
/** True when (row,col) is river water — bridges are crossings, not water. */
export declare function isRiverCell(board: BoardLike, row: number, col: number): boolean;
/** True when the unit is standing on a mage tower (high ground). */
export declare function isUnitOnTower(board: BoardLike, unit: UnitState): boolean;
/**
 * Archer/crossbow square radius for a unit, extended ~1.5× on a tower.
 * Kept as a function (not a constant) so the client, the AI and the server
 * reducer all derive the same number from the same rule.
 */
export declare function archerRadiusFor(onTower: boolean): number;
/** Catapult max bombardment range, extended ~1.5× on a tower. Min range is unchanged. */
export declare function catapultMaxRangeFor(onTower: boolean): number;
export declare function generateLegalMoves(board: BoardLike, unit: UnitState): MoveAction[];
/**
 * Every attack `unit` can make now. Striking into its own back half costs
 * TURN_COST extra on top of the attack's own cost (facing.ts) — added here
 * once for every unit type, so the per-type generators below stay as is.
 */
export declare function generateAttackActions(board: BoardLike, unit: UnitState): AttackAction[];
export declare function generateAllActions(board: BoardLike, unit: UnitState): Action[];
//# sourceMappingURL=moves.d.ts.map