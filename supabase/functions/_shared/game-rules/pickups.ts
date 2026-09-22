// AUTO-VENDORED from packages/game-rules/src/pickups.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
/**
 * Hidden pickups — artifacts, weapons and armour buried across the board at
 * match setup, replacing the old searchable ruins.
 *
 * Rules:
 *  - scattered exactly once per match, from the match seed (never respawn);
 *  - invisible to both players (nothing is drawn for them);
 *  - claimed by the first unit that steps onto the cell;
 *  - never placed on a starting unit's cell, inside a castle zone, or on a tower.
 *
 * Pure and seeded so the offline client, the optimistic online client and the
 * authoritative server reducer all bury the same things in the same cells.
 */
import { COLS, HIDDEN_PICKUP_SPAWN, ROWS } from './constants.ts';
import type { Rng } from './rng.ts';
import type { HiddenPickup, TowerPosition } from './types.ts';

/** Castle footprint depth (rows) at each end of the board, per setup.ts. */
const CASTLE_ROWS = 5;
/** Castle footprint width (cols), per setup.ts. */
const CASTLE_COLS = 4;

export interface ScatterOptions {
  castleP1Col: number;
  castleP2Col: number;
  towers: readonly TowerPosition[];
  /** Cells of the starting roster — knights and friends must not sit on loot. */
  occupied: readonly { row: number; col: number }[];
}

/**
 * Cells that may never hold a hidden pickup: both castle zones, every tower,
 * and every starting unit's cell.
 */
export function buildExcludedCells(opts: ScatterOptions): Set<string> {
  const excluded = new Set<string>();

  for (const castleCol of [opts.castleP1Col, opts.castleP2Col]) {
    for (let c = castleCol; c < castleCol + CASTLE_COLS; c += 1) {
      if (c < 0 || c >= COLS) continue;
      // Castles sit at both ends of the board; block both footprints so loot
      // never spawns inside a keep regardless of which side owns it.
      for (let r = 0; r < CASTLE_ROWS; r += 1) excluded.add(`${r},${c}`);
      for (let r = ROWS - CASTLE_ROWS; r < ROWS; r += 1) excluded.add(`${r},${c}`);
    }
  }

  for (const t of opts.towers) excluded.add(`${t.row},${t.col}`);
  for (const u of opts.occupied) excluded.add(`${u.row},${u.col}`);

  return excluded;
}

/**
 * Scatter every entry of HIDDEN_PICKUP_SPAWN across the free cells of the
 * board. Each entry claims `round(percent% × ROWS × COLS)` distinct cells; one
 * cell holds at most one pickup.
 */
export function scatterHiddenPickups(rng: Rng, opts: ScatterOptions): HiddenPickup[] {
  const excluded = buildExcludedCells(opts);

  // Every legal cell, in a fixed order, then shuffled once with the seeded RNG.
  const pool: { row: number; col: number }[] = [];
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      if (!excluded.has(`${r},${c}`)) pool.push({ row: r, col: c });
    }
  }
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }

  const totalCells = ROWS * COLS;
  const pickups: HiddenPickup[] = [];
  let cursor = 0;

  for (const entry of HIDDEN_PICKUP_SPAWN) {
    const count = Math.round((entry.percent / 100) * totalCells);
    for (let i = 0; i < count && cursor < pool.length; i += 1, cursor += 1) {
      const cell = pool[cursor]!;
      pickups.push({ row: cell.row, col: cell.col, kind: entry.kind, name: entry.name });
    }
  }

  return pickups;
}

/** The pickup buried at (row,col), or null. */
export function pickupAt(
  pickups: readonly HiddenPickup[],
  row: number,
  col: number,
): HiddenPickup | null {
  return pickups.find((p) => p.row === row && p.col === col) ?? null;
}

/** All pickups except the one at (row,col) — used after a unit claims it. */
export function removePickupAt(
  pickups: readonly HiddenPickup[],
  row: number,
  col: number,
): HiddenPickup[] {
  return pickups.filter((p) => !(p.row === row && p.col === col));
}
