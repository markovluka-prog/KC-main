// AUTO-VENDORED from packages/game-rules/src/moves.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
import type { Action, AttackAction, BoardLike, MoveAction, UnitState } from './types.ts';
import { ARCHER_SQUARE_RADIUS, TOWER_RANGE_MULTIPLIER } from './constants.ts';

const ORTHO_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const ALL8_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

export const CATAPULT_MIN_RANGE = 3;
export const CATAPULT_MAX_RANGE = 6;

/** True when the unit is standing on a mage tower (high ground). */
export function isUnitOnTower(board: BoardLike, unit: UnitState): boolean {
  return typeof board.isTower === 'function' ? board.isTower(unit.row, unit.col) : false;
}

/**
 * Archer/crossbow square radius for a unit, extended ~1.5× on a tower.
 * Kept as a function (not a constant) so the client, the AI and the server
 * reducer all derive the same number from the same rule.
 */
export function archerRadiusFor(onTower: boolean): number {
  return onTower
    ? Math.round(ARCHER_SQUARE_RADIUS * TOWER_RANGE_MULTIPLIER)
    : ARCHER_SQUARE_RADIUS;
}

/** Catapult max bombardment range, extended ~1.5× on a tower. Min range is unchanged. */
export function catapultMaxRangeFor(onTower: boolean): number {
  return onTower ? Math.round(CATAPULT_MAX_RANGE * TOWER_RANGE_MULTIPLIER) : CATAPULT_MAX_RANGE;
}

export function generateLegalMoves(board: BoardLike, unit: UnitState): MoveAction[] {
  if (unit.movesLeft <= 0) return [];
  const moves: MoveAction[] = [];

  // All unit types: move 1 cell orthogonally per move point (up to movesLeft)
  for (const dir of ORTHO_DIRS) {
    for (let step = 1; step <= unit.maxMoves; step += 1) {
      if (step > unit.movesLeft) break;
      const nr = unit.row + dir[0] * step;
      const nc = unit.col + dir[1] * step;
      if (!board.isFree(nr, nc)) break;
      moves.push({ kind: 'move', row: nr, col: nc, cost: step });
      // All non-archer unit types can only step 1 cell at a time (cost=1 per step)
      if (unit.type !== 'archer') break;
    }
  }
  return moves;
}

export function generateAttackActions(board: BoardLike, unit: UnitState): AttackAction[] {
  if (unit.movesLeft <= 0) return [];
  const attacks: AttackAction[] = [];

  if (unit.type === 'archer' || unit.type === 'crossbow') {
    // Square-zone shot: any enemy within the unit's square radius (Chebyshev
    // distance) — 1.5× wider while standing on a mage tower.
    // Cost = Chebyshev distance to target (adjacent = 1, range-2 = 2). No LoS restriction.
    const radius = archerRadiusFor(isUnitOnTower(board, unit));
    if (unit.movesLeft >= 1) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (dr === 0 && dc === 0) continue;
          const cost = Math.max(Math.abs(dr), Math.abs(dc));
          if (unit.movesLeft < cost) continue;
          const tr = unit.row + dr;
          const tc = unit.col + dc;
          const cell = board.unitAt(tr, tc);
          if (!cell || cell.player === unit.player) continue;
          attacks.push({
            kind: 'attack',
            mode: 'shot',
            row: unit.row,
            col: unit.col,
            cost,
            targetRow: tr,
            targetCol: tc,
            landingRow: unit.row,
            landingCol: unit.col,
          });
        }
      }
    }
    return attacks;
  }

  if (unit.type === 'catapult') {
    // Long-range bombardment: any enemy at manhattan distance 3–6 (3–9 from a
    // mage tower). Flies over terrain and units (no line-of-sight check).
    // Costs 1 move.
    const maxRange = catapultMaxRangeFor(isUnitOnTower(board, unit));
    if (unit.movesLeft >= 1) {
      for (let dr = -maxRange; dr <= maxRange; dr++) {
        for (let dc = -maxRange; dc <= maxRange; dc++) {
          const dist = Math.abs(dr) + Math.abs(dc);
          if (dist < CATAPULT_MIN_RANGE || dist > maxRange) continue;
          const tr = unit.row + dr;
          const tc = unit.col + dc;
          const cell = board.unitAt(tr, tc);
          if (!cell || cell.player === unit.player) continue;
          attacks.push({
            kind: 'attack',
            mode: 'shot',
            row: unit.row,
            col: unit.col,
            cost: 1,
            targetRow: tr,
            targetCol: tc,
            landingRow: unit.row,
            landingCol: unit.col,
          });
        }
      }
    }
    return attacks;
  }

  if (unit.type === 'knight') {
    // Knight: adjacent melee, costs 1, attacker stays in place.
    if (unit.movesLeft < 1) return attacks;
    for (const dir of ORTHO_DIRS) {
      const er = unit.row + dir[0];
      const ec = unit.col + dir[1];
      const enemy = board.unitAt(er, ec);
      if (!enemy || enemy.player === unit.player) continue;
      attacks.push({
        kind: 'attack',
        mode: 'shot',
        row: unit.row,
        col: unit.col,
        cost: 1,
        targetRow: er,
        targetCol: ec,
        landingRow: unit.row,
        landingCol: unit.col,
      });
    }
    return attacks;
  }

  if (unit.type === 'samurai') {
    // Samurai: 8-directional melee (orthogonal + diagonal), costs 1, stays in place.
    if (unit.movesLeft < 1) return attacks;
    for (const dir of ALL8_DIRS) {
      const er = unit.row + dir[0];
      const ec = unit.col + dir[1];
      const enemy = board.unitAt(er, ec);
      if (!enemy || enemy.player === unit.player) continue;
      attacks.push({
        kind: 'attack',
        mode: 'shot',
        row: unit.row,
        col: unit.col,
        cost: 1,
        targetRow: er,
        targetCol: ec,
        landingRow: unit.row,
        landingCol: unit.col,
      });
    }
    return attacks;
  }

  // Cavalry: jump / Г-attack (unchanged).
  if (unit.movesLeft < 2) return attacks;
  for (const dir of ORTHO_DIRS) {
    const er = unit.row + dir[0];
    const ec = unit.col + dir[1];
    const enemy = board.unitAt(er, ec);
    if (!enemy || enemy.player === unit.player) continue;

    const jr = er + dir[0];
    const jc = ec + dir[1];
    if (board.isFree(jr, jc)) {
      attacks.push({
        kind: 'attack',
        mode: 'jump',
        row: jr,
        col: jc,
        cost: 2,
        targetRow: er,
        targetCol: ec,
        landingRow: jr,
        landingCol: jc,
      });
    }

    const perps: ReadonlyArray<readonly [number, number]> = [
      [dir[1], dir[0]],
      [-dir[1], -dir[0]],
    ];
    for (const p of perps) {
      const lr = er + p[0];
      const lc = ec + p[1];
      if (!board.isFree(lr, lc)) continue;
      attacks.push({
        kind: 'attack',
        mode: 'l-attack',
        row: lr,
        col: lc,
        cost: 2,
        targetRow: er,
        targetCol: ec,
        landingRow: lr,
        landingCol: lc,
      });
    }
  }

  return attacks;
}

export function generateAllActions(board: BoardLike, unit: UnitState): Action[] {
  return [...generateLegalMoves(board, unit), ...generateAttackActions(board, unit)];
}
