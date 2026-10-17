import type { GameState } from './state.js';
import type { SerializedUnit } from './save.js';
import type { BoardLike, UnitState } from './types.js';
/** Adapt a `GameState` snapshot into the `BoardLike` shape `moves.ts` expects. */
export declare function boardFromState(state: GameState): BoardLike;
export declare function toUnitState(u: SerializedUnit): UnitState;
//# sourceMappingURL=board-state.d.ts.map