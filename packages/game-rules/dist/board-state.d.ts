import type { GameState } from './state.js';
import type { SerializedUnit } from './save.js';
import type { BoardLike, UnitState } from './types.js';
/** Adapt a `GameState` snapshot into the `BoardLike` shape `moves.ts` expects.
 *  Grids are built once per board (search code queries them millions of
 *  times), instead of scanning the unit/terrain lists on every lookup. */
export declare function boardFromState(state: GameState): BoardLike;
/**
 * boardFromState without allocating: reuses one set of module-level grids.
 * Only for callers that finish with the board before building another one
 * (generateActionsForPlayer) — searches build millions of boards a second and
 * the allocations were a large share of their garbage-collection time.
 */
export declare function boardFromStateScratch(state: GameState): BoardLike;
export declare function toUnitState(u: SerializedUnit): UnitState;
//# sourceMappingURL=board-state.d.ts.map