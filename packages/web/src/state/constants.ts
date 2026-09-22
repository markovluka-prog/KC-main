// Board/canvas geometry constants, extracted from main.ts (Phase 2 refactor,
// Increment 1). Pure module — no DOM, no mutable state — so it can be imported
// by both the orchestrator and the future render/input modules.
import { COLS, ROWS } from '@kc/game-rules';

/** Pixel size of one board cell. */
export const CELL_SIZE = 30;

/** Canvas logical width/height — the board spans the full canvas. */
export const WIDTH = COLS * CELL_SIZE;
export const HEIGHT = ROWS * CELL_SIZE;

/** Vertical offset shifting the board down to leave headroom at the top. */
export const FIELD_Y_OFFSET = Math.round(CELL_SIZE * 0.75);

/** Perspective scale + centering offsets applied to the board when drawing. */
export const BOARD_SCALE = (HEIGHT - FIELD_Y_OFFSET) / HEIGHT;
export const BOARD_OFFSET_X = Math.round((WIDTH - WIDTH * BOARD_SCALE) / 2);
export const BOARD_OFFSET_Y = FIELD_Y_OFFSET;

/** Stable string key for a board cell — used by the move/attack lookup maps. */
export function toKey(row: number, col: number): string {
  return row + ',' + col;
}
