/**
 * `GameState` → `BoardLike` view, so the pure move generators in moves.ts can
 * run against a reducer state. Lives on its own (not in actions.ts) so that
 * apply.ts can validate moves with it without an import cycle.
 */
import { insideBoard } from './board.js';
/** Adapt a `GameState` snapshot into the `BoardLike` shape `moves.ts` expects. */
export function boardFromState(state) {
    const alive = state.units.filter((u) => u.hp > 0);
    const terrain = state.terrain;
    const towers = state.towers;
    const constructions = state.constructions ?? [];
    return {
        unitAt(row, col) {
            const found = alive.find((u) => u.row === row && u.col === col);
            return found ? toUnitState(found) : null;
        },
        isFree(row, col) {
            // Bounds on every side — this used to check only `< 0`, so a search
            // could walk a unit off the bottom/right edge of the board.
            if (!insideBoard(row, col))
                return false;
            if (alive.some((u) => u.row === row && u.col === col))
                return false;
            if (terrain.some((t) => t.row === row && t.col === col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock')))
                return false;
            // An unfinished tower/bridge site is impassable, like a mountain.
            if (constructions.some((c) => c.row === row && c.col === col))
                return false;
            return true;
        },
        isTower(row, col) {
            return towers.some((t) => t.row === row && t.col === col);
        },
        isRiver(row, col) {
            return terrain.some((t) => t.row === row && t.col === col && t.type === 'river');
        },
        isBridge(row, col) {
            return terrain.some((t) => t.row === row && t.col === col && t.type === 'bridge');
        },
    };
}
export function toUnitState(u) {
    return {
        id: u.id,
        type: u.type,
        player: u.player,
        row: u.row,
        col: u.col,
        hp: u.hp,
        armor: u.armor,
        damage: u.damage,
        maxMoves: u.maxMoves,
        movesLeft: u.movesLeft,
        name: u.type,
    };
}
//# sourceMappingURL=board-state.js.map