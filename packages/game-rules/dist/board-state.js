/**
 * `GameState` → `BoardLike` view, so the pure move generators in moves.ts can
 * run against a reducer state. Lives on its own (not in actions.ts) so that
 * apply.ts can validate moves with it without an import cycle.
 */
import { insideBoard } from './board.js';
import { COLS, ROWS } from './constants.js';
/** Adapt a `GameState` snapshot into the `BoardLike` shape `moves.ts` expects.
 *  Grids are built once per board (search code queries them millions of
 *  times), instead of scanning the unit/terrain lists on every lookup. */
export function boardFromState(state) {
    const N = COLS * ROWS;
    const unitGrid = new Array(N);
    for (const u of state.units)
        if (u.hp > 0)
            unitGrid[u.row * COLS + u.col] = u;
    // cell flags: 1 blocked terrain, 2 river, 4 bridge, 8 tower, 16 build site
    const flags = new Uint8Array(N);
    for (const t of state.terrain) {
        if (!insideBoard(t.row, t.col))
            continue;
        const i = t.row * COLS + t.col;
        if (t.type === 'river')
            flags[i] |= 1 | 2;
        else if (t.type === 'mountain' || t.type === 'rock')
            flags[i] |= 1;
        else if (t.type === 'bridge')
            flags[i] |= 4;
    }
    for (const t of state.towers)
        if (insideBoard(t.row, t.col))
            flags[t.row * COLS + t.col] |= 8;
    for (const c of state.constructions ?? [])
        if (insideBoard(c.row, c.col))
            flags[c.row * COLS + c.col] |= 16;
    const at = (row, col) => (insideBoard(row, col) ? row * COLS + col : -1);
    return {
        unitAt(row, col) {
            const i = at(row, col);
            const found = i < 0 ? undefined : unitGrid[i];
            return found ? toUnitState(found) : null;
        },
        isFree(row, col) {
            // Bounds on every side — this used to check only `< 0`, so a search
            // could walk a unit off the bottom/right edge of the board.
            const i = at(row, col);
            if (i < 0 || unitGrid[i])
                return false;
            // River/mountain/rock, or an unfinished tower/bridge site.
            return (flags[i] & (1 | 16)) === 0;
        },
        isTower(row, col) {
            const i = at(row, col);
            return i >= 0 && (flags[i] & 8) !== 0;
        },
        isRiver(row, col) {
            const i = at(row, col);
            return i >= 0 && (flags[i] & 2) !== 0;
        },
        isBridge(row, col) {
            const i = at(row, col);
            return i >= 0 && (flags[i] & 4) !== 0;
        },
    };
}
// Scratch buffers for boardFromStateScratch — one set per thread.
// Unit grid as indices (index+1, 0 = empty) into SCRATCH_LIST: a typed array
// clears with a fast memset, unlike a generic array of objects.
const SCRATCH_IDX = new Int16Array(COLS * ROWS);
let SCRATCH_LIST = [];
const SCRATCH_FLAGS = new Uint8Array(COLS * ROWS);
/**
 * boardFromState without allocating: reuses one set of module-level grids.
 * Only for callers that finish with the board before building another one
 * (generateActionsForPlayer) — searches build millions of boards a second and
 * the allocations were a large share of their garbage-collection time.
 */
export function boardFromStateScratch(state) {
    const flags = SCRATCH_FLAGS;
    SCRATCH_IDX.fill(0);
    flags.fill(0);
    SCRATCH_LIST = state.units;
    for (let k = 0; k < state.units.length; k++) {
        const u = state.units[k];
        if (u.hp > 0)
            SCRATCH_IDX[u.row * COLS + u.col] = k + 1;
    }
    for (const t of state.terrain) {
        if (!insideBoard(t.row, t.col))
            continue;
        const i = t.row * COLS + t.col;
        if (t.type === 'river')
            flags[i] |= 1 | 2;
        else if (t.type === 'mountain' || t.type === 'rock')
            flags[i] |= 1;
        else if (t.type === 'bridge')
            flags[i] |= 4;
    }
    for (const t of state.towers)
        if (insideBoard(t.row, t.col))
            flags[t.row * COLS + t.col] |= 8;
    for (const c of state.constructions ?? [])
        if (insideBoard(c.row, c.col))
            flags[c.row * COLS + c.col] |= 16;
    return SCRATCH_BOARD;
}
const scratchAt = (row, col) => (insideBoard(row, col) ? row * COLS + col : -1);
const SCRATCH_BOARD = {
    unitAt(row, col) {
        const i = scratchAt(row, col);
        // The generators only read fields, so hand out the unit itself (it has
        // every UnitState field) instead of allocating a copy per lookup.
        const k = i < 0 ? 0 : SCRATCH_IDX[i];
        return k ? SCRATCH_LIST[k - 1] : null;
    },
    isFree(row, col) {
        const i = scratchAt(row, col);
        if (i < 0 || SCRATCH_IDX[i])
            return false;
        return (SCRATCH_FLAGS[i] & (1 | 16)) === 0;
    },
    isTower(row, col) {
        const i = scratchAt(row, col);
        return i >= 0 && (SCRATCH_FLAGS[i] & 8) !== 0;
    },
    isRiver(row, col) {
        const i = scratchAt(row, col);
        return i >= 0 && (SCRATCH_FLAGS[i] & 2) !== 0;
    },
    isBridge(row, col) {
        const i = scratchAt(row, col);
        return i >= 0 && (SCRATCH_FLAGS[i] & 4) !== 0;
    },
};
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
        facing: u.facing,
    };
}
//# sourceMappingURL=board-state.js.map