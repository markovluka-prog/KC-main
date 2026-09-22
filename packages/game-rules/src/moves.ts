import type { Action, AttackAction, BoardLike, MoveAction, UnitState } from './types.js';
import { insideBoard } from './board.js';
import { ARCHER_SQUARE_RADIUS, TOWER_RANGE_MULTIPLIER } from './constants.js';

const ORTHO_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export const ALL8_DIRS: ReadonlyArray<readonly [number, number]> = [
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

/** Crossbow piercing bolt: how many cells deep it flies along its line. */
export const CROSSBOW_PIERCE_RANGE = 2;
/** Crossbow piercing bolt: flat move cost, regardless of how many cells hold a unit. */
export const CROSSBOW_PIERCE_COST = 2;

/**
 * Move points a cavalry unit spends to leap a one-cell river. Matches its jump
 * attack cost so crossing is a real commitment, not free mobility.
 */
export const CAVALRY_RIVER_JUMP_COST = 2;

/** True when (row,col) is river water — bridges are crossings, not water. */
export function isRiverCell(board: BoardLike, row: number, col: number): boolean {
  return typeof board.isRiver === 'function' ? board.isRiver(row, col) : false;
}

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

  // Cavalry river leap: a horse can clear a river that is exactly ONE cell wide,
  // landing on the far bank. Two or more cells of water is too wide, and the
  // landing cell must be genuinely free (no unit, no mountain/rock). Costs 2 —
  // the same as its jump attack — so it isn't a cheap way to outrun infantry.
  if (unit.type === 'cavalry' && unit.movesLeft >= CAVALRY_RIVER_JUMP_COST) {
    for (const dir of ORTHO_DIRS) {
      const wr = unit.row + dir[0];
      const wc = unit.col + dir[1];
      // The adjacent cell must be water (bridges are crossed normally instead).
      if (!isRiverCell(board, wr, wc)) continue;
      const lr = unit.row + dir[0] * 2;
      const lc = unit.col + dir[1] * 2;
      // One cell of water only: the landing must not be water as well.
      if (isRiverCell(board, lr, lc)) continue;
      if (!board.isFree(lr, lc)) continue;
      // Don't duplicate a move the normal walk already produced.
      if (moves.some((m) => m.row === lr && m.col === lc)) continue;
      moves.push({ kind: 'move', row: lr, col: lc, cost: CAVALRY_RIVER_JUMP_COST });
    }
  }

  return moves;
}

export function generateAttackActions(board: BoardLike, unit: UnitState): AttackAction[] {
  if (unit.movesLeft <= 0) return [];
  const attacks: AttackAction[] = [];

  if (unit.type === 'archer') {
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

  if (unit.type === 'crossbow') {
    // Piercing bolt: fires straight along one of the 8 chess-king directions,
    // flying through CROSSBOW_PIERCE_RANGE cells and hitting a unit on EVERY
    // one of them (friend or foe — see applyAttack). Flat cost regardless of
    // how many cells are actually occupied. Only offered when at least one
    // cell on the line holds a living unit (otherwise there's nothing to
    // shoot at, matching every other unit's "no empty-air attacks" rule).
    if (unit.movesLeft >= CROSSBOW_PIERCE_COST) {
      for (const dir of ALL8_DIRS) {
        const line: Array<{ row: number; col: number }> = [];
        let hasTarget = false;
        for (let step = 1; step <= CROSSBOW_PIERCE_RANGE; step++) {
          const r = unit.row + dir[0] * step;
          const c = unit.col + dir[1] * step;
          if (!insideBoard(r, c)) break;
          line.push({ row: r, col: c });
          const cell = board.unitAt(r, c);
          if (cell) hasTarget = true;
        }
        if (line.length === 0 || !hasTarget) continue;
        const first = line[0]!;
        attacks.push({
          kind: 'attack',
          mode: 'pierce',
          row: unit.row,
          col: unit.col,
          cost: CROSSBOW_PIERCE_COST,
          targetRow: first.row,
          targetCol: first.col,
          landingRow: unit.row,
          landingCol: unit.col,
          targets: line,
        });
      }
    }
    return attacks;
  }

  if (unit.type === 'catapult') {
    // Long-range bombardment: any enemy at manhattan distance 3–6 (3–9 from a
    // mage tower). Flies over terrain and units (no line-of-sight check).
    // Costs 1 move. A built bridge in range is also a legal target — 1 hit
    // of demolition instead of unit damage (see applyCatapultBridgeShot).
    const maxRange = catapultMaxRangeFor(isUnitOnTower(board, unit));
    if (unit.movesLeft >= 1) {
      for (let dr = -maxRange; dr <= maxRange; dr++) {
        for (let dc = -maxRange; dc <= maxRange; dc++) {
          const dist = Math.abs(dr) + Math.abs(dc);
          if (dist < CATAPULT_MIN_RANGE || dist > maxRange) continue;
          const tr = unit.row + dr;
          const tc = unit.col + dc;
          const cell = board.unitAt(tr, tc);
          const isEnemyUnit = cell && cell.player !== unit.player;
          const isBridge = !cell && typeof board.isBridge === 'function' && board.isBridge(tr, tc);
          if (!isEnemyUnit && !isBridge) continue;
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

  if (unit.type === 'mage') {
    // The mage has no plain 'attack' action at all — every one of its 4
    // abilities (mage-attack/mage-ward/mage-drain/mage-burn-bridge/mage-heal)
    // is its own ServerAction kind, energy-costed rather than movesLeft-costed.
    // Generated separately by actions.ts's generateMageActions, not here. See
    // apply.ts.
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
