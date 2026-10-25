import { describe, expect, it } from 'vitest';
import { generateAttackActions, generateLegalMoves } from '../moves.js';
import { UNIT_TYPES, COLS, ROWS } from '../constants.js';
import type { BoardLike, Player, UnitState, UnitTypeKey } from '../types.js';

function makeUnit(
  id: number,
  player: Player,
  type: UnitTypeKey,
  row: number,
  col: number,
  movesLeft?: number,
): UnitState {
  const t = UNIT_TYPES[type];
  return {
    id,
    player,
    type,
    row,
    col,
    hp: t.hp,
    armor: t.armor,
    damage: t.damage,
    maxMoves: t.moves,
    movesLeft: movesLeft ?? t.moves,
    name: t.name,
    // Every fixture here aims "up" (targets at row 4 from row 5), so face that
    // way: the facing rules (turn cost) are tested in their own block below.
    facing: 'up',
  };
}

function makeBoard(units: UnitState[], towers: { row: number; col: number }[] = []): BoardLike {
  return {
    unitAt(row, col) {
      return units.find((u) => u.row === row && u.col === col && u.hp > 0) ?? null;
    },
    isFree(row, col) {
      if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return false;
      return !units.some((u) => u.row === row && u.col === col && u.hp > 0);
    },
    isTower(row, col) {
      return towers.some((t) => t.row === row && t.col === col);
    },
  };
}

describe('generateLegalMoves', () => {
  it('returns no moves when unit has 0 moves left', () => {
    const unit = makeUnit(1, 1, 'knight', 5, 5, 0);
    const board = makeBoard([unit]);
    expect(generateLegalMoves(board, unit)).toEqual([]);
  });

  it('knight with 2 moves left has up to 4 orthogonal 1-step moves', () => {
    const unit = makeUnit(1, 1, 'knight', 5, 5);
    const board = makeBoard([unit]);
    const moves = generateLegalMoves(board, unit);
    expect(moves.length).toBeGreaterThanOrEqual(1);
    for (const m of moves) {
      const dr = Math.abs(m.row - 5);
      const dc = Math.abs(m.col - 5);
      expect(dr + dc).toBe(1);
      // Facing up: stepping down (its back) costs +1 to turn round.
      expect(m.cost).toBe(m.row === 6 ? 2 : 1);
    }
  });

  it('archer can step 2 cells in a straight line at cost 2', () => {
    const archer = makeUnit(1, 1, 'archer', 5, 5);
    const board = makeBoard([archer]);
    const moves = generateLegalMoves(board, archer);
    const twoStep = moves.filter((m) => m.cost === 2);
    expect(twoStep.length).toBeGreaterThan(0);
  });

  it('blocks moves when destination is occupied by another unit', () => {
    const me = makeUnit(1, 1, 'knight', 5, 5);
    const blocker = makeUnit(2, 2, 'knight', 4, 5);
    const board = makeBoard([me, blocker]);
    const moves = generateLegalMoves(board, me);
    expect(moves.some((m) => m.row === 4 && m.col === 5)).toBe(false);
  });
});

describe('generateAttackActions — jump attack', () => {
  it('produces a jump action when enemy is adjacent and cell behind is free', () => {
    const me = makeUnit(1, 1, 'cavalry', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 4, 5);
    const board = makeBoard([me, enemy]);
    const attacks = generateAttackActions(board, me);
    const jump = attacks.find((a) => a.mode === 'jump' && a.targetRow === 4 && a.targetCol === 5);
    expect(jump).toBeDefined();
    expect(jump?.landingRow).toBe(3);
    expect(jump?.landingCol).toBe(5);
    expect(jump?.cost).toBe(2);
  });

  it('does NOT produce jump when the landing cell is blocked', () => {
    const me = makeUnit(1, 1, 'cavalry', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 4, 5);
    const blocker = makeUnit(3, 2, 'knight', 3, 5);
    const board = makeBoard([me, enemy, blocker]);
    const attacks = generateAttackActions(board, me);
    expect(attacks.find((a) => a.mode === 'jump' && a.targetRow === 4)).toBeUndefined();
  });
});

describe('generateAttackActions — corner Г-attack', () => {
  it('an adjacent enemy yields a jump-through plus two corner landings beside the victim', () => {
    const cavalry = makeUnit(1, 1, 'cavalry', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 4, 5); // directly above
    const board = makeBoard([cavalry, enemy]);
    const attacks = generateAttackActions(board, cavalry);

    // straight jump-through onto the cell behind the enemy
    const jump = attacks.find((a) => a.mode === 'jump' && a.targetRow === 4 && a.targetCol === 5);
    expect(jump?.landingRow).toBe(3);
    expect(jump?.landingCol).toBe(5);

    // corner (Г) landings diagonally beside the victim
    const corners = attacks.filter(
      (a) => a.mode === 'l-attack' && a.targetRow === 4 && a.targetCol === 5,
    );
    const landings = new Set(corners.map((a) => a.landingRow + ',' + a.landingCol));
    expect(landings.has('4,4')).toBe(true);
    expect(landings.has('4,6')).toBe(true);
    for (const a of corners) {
      expect(a.cost).toBe(2);
      // landing is orthogonally adjacent to the victim...
      expect(Math.abs(a.landingRow - a.targetRow) + Math.abs(a.landingCol - a.targetCol)).toBe(1);
      // ...and diagonally adjacent to the attacker (the "corner")
      expect(Math.abs(a.landingRow - cavalry.row)).toBe(1);
      expect(Math.abs(a.landingCol - cavalry.col)).toBe(1);
    }
  });

  it('skips a corner landing when that diagonal cell is blocked', () => {
    const cavalry = makeUnit(1, 1, 'cavalry', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 4, 5);
    const blocker = makeUnit(3, 2, 'knight', 4, 4); // occupies the left corner landing
    const board = makeBoard([cavalry, enemy, blocker]);
    const attacks = generateAttackActions(board, cavalry);
    const landings = new Set(
      attacks
        .filter((a) => a.mode === 'l-attack' && a.targetRow === 4 && a.targetCol === 5)
        .map((a) => a.landingRow + ',' + a.landingCol),
    );
    expect(landings.has('4,4')).toBe(false);
    expect(landings.has('4,6')).toBe(true);
  });

  it('does NOT attack a chess-knight-offset enemy (no L-jump like a chess knight)', () => {
    const knight = makeUnit(1, 1, 'cavalry', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 3, 6); // chess-knight offset (−2, +1), not adjacent
    const board = makeBoard([knight, enemy]);
    const attacks = generateAttackActions(board, knight);
    expect(attacks.every((a) => !(a.targetRow === 3 && a.targetCol === 6))).toBe(true);
  });

  it('archers cannot perform jump or corner attacks', () => {
    const archer = makeUnit(1, 1, 'archer', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 4, 5);
    const board = makeBoard([archer, enemy]);
    const attacks = generateAttackActions(board, archer);
    expect(attacks.every((a) => a.mode !== 'l-attack' && a.mode !== 'jump')).toBe(true);
  });
});

describe('generateAttackActions — archer shot', () => {
  it('archer fires at adjacent enemy without moving', () => {
    const archer = makeUnit(1, 1, 'archer', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 4, 5);
    const board = makeBoard([archer, enemy]);
    const attacks = generateAttackActions(board, archer);
    const shot = attacks.find((a) => a.mode === 'shot');
    expect(shot).toBeDefined();
    expect(shot?.landingRow).toBe(5);
    expect(shot?.landingCol).toBe(5);
    expect(shot?.cost).toBe(1);
  });

  it('archer cannot shoot ally', () => {
    const archer = makeUnit(1, 1, 'archer', 5, 5);
    const ally = makeUnit(2, 1, 'knight', 4, 5);
    const board = makeBoard([archer, ally]);
    const attacks = generateAttackActions(board, archer);
    expect(attacks).toEqual([]);
  });
});

describe('crossbow pierce shot', () => {
  it('fires along a straight line 2 cells deep, costing 2 moves', () => {
    const unit = makeUnit(1, 1, 'crossbow', 5, 5);
    const enemy = makeUnit(2, 2, 'knight', 5, 7); // 2 cells east
    const attacks = generateAttackActions(makeBoard([unit, enemy]), unit);
    expect(attacks).toHaveLength(1);
    expect(attacks[0]!.mode).toBe('pierce');
    expect(attacks[0]!.cost).toBe(2);
    expect(attacks[0]!.targetRow).toBe(5);
    expect(attacks[0]!.targetCol).toBe(6);
    expect(attacks[0]!.targets).toEqual([
      { row: 5, col: 6 },
      { row: 5, col: 7 },
    ]);
  });

  it('offers a shot in all 8 directions when a unit sits on that line', () => {
    const unit = makeUnit(1, 1, 'crossbow', 5, 5);
    const enemies = [
      makeUnit(2, 2, 'knight', 3, 5), // north
      makeUnit(3, 2, 'knight', 7, 5), // south
      makeUnit(4, 2, 'knight', 5, 3), // west
      makeUnit(5, 2, 'knight', 5, 7), // east
      makeUnit(6, 2, 'knight', 3, 3), // NW
      makeUnit(7, 2, 'knight', 3, 7), // NE
      makeUnit(8, 2, 'knight', 7, 3), // SW
      makeUnit(9, 2, 'knight', 7, 7), // SE
    ];
    const attacks = generateAttackActions(makeBoard([unit, ...enemies]), unit);
    // Facing up with 2 moves: the 3 southern lines are behind it and would
    // cost 2 + 1 to turn — unaffordable, so 5 of the 8 are offered.
    expect(attacks).toHaveLength(5);
    expect(attacks.every((a) => a.targetRow <= 5)).toBe(true);
  });

  it('does not offer a shot with no unit anywhere on the line', () => {
    const unit = makeUnit(1, 1, 'crossbow', 5, 5);
    const board = makeBoard([unit]);
    expect(generateAttackActions(board, unit)).toEqual([]);
  });

  it('does NOT offer a shot when the only unit on the line is an ally', () => {
    const unit = makeUnit(1, 1, 'crossbow', 5, 5);
    const ally = makeUnit(2, 1, 'knight', 5, 7);
    expect(generateAttackActions(makeBoard([unit, ally]), unit)).toHaveLength(0);
  });

  it('still offers it (hitting the ally too) once an enemy shares the line', () => {
    const unit = makeUnit(1, 1, 'crossbow', 5, 5);
    const ally = makeUnit(2, 1, 'knight', 5, 6);
    const enemy = makeUnit(3, 2, 'knight', 5, 7);
    const attacks = generateAttackActions(makeBoard([unit, ally, enemy]), unit);
    expect(attacks).toHaveLength(1);
    expect(attacks[0]!.mode).toBe('pierce');
  });

  it('clips the line at the board edge instead of throwing', () => {
    const unit = makeUnit(1, 1, 'crossbow', 0, 0); // corner: most directions run off-board immediately
    const enemy = makeUnit(2, 2, 'knight', 0, 1); // 1 cell east — line would want to go to col -1 too
    expect(() => generateAttackActions(makeBoard([unit, enemy]), unit)).not.toThrow();
    const attacks = generateAttackActions(makeBoard([unit, enemy]), unit);
    const east = attacks.find((a) => a.targetRow === 0 && a.targetCol === 1);
    expect(east).toBeDefined();
    expect(east!.targets).toEqual([{ row: 0, col: 1 }, { row: 0, col: 2 }]);
  });

  it('is not offered with fewer than 2 moves left', () => {
    const unit = makeUnit(1, 1, 'crossbow', 5, 5, 1);
    const enemy = makeUnit(2, 2, 'knight', 5, 7);
    expect(generateAttackActions(makeBoard([unit, enemy]), unit)).toEqual([]);
  });
});

describe('tower range bonus', () => {
  it('archer on a tower reaches range 3, off a tower only range 2', () => {
    // Enemy at Chebyshev distance 3 — out of the normal 5x5 square zone.
    const enemy = makeUnit(2, 2, 'knight', 5, 8);
    const ground = makeUnit(1, 1, 'archer', 5, 5, 3);
    expect(
      generateAttackActions(makeBoard([ground, enemy]), ground).some(
        (a) => a.targetRow === 5 && a.targetCol === 8,
      ),
    ).toBe(false);

    const onTower = makeUnit(1, 1, 'archer', 5, 5, 3);
    const shots = generateAttackActions(makeBoard([onTower, enemy], [{ row: 5, col: 5 }]), onTower);
    const shot = shots.find((a) => a.targetRow === 5 && a.targetCol === 8);
    expect(shot).toBeDefined();
    // Cost still equals the Chebyshev distance, so the extra reach costs moves.
    expect(shot?.cost).toBe(3);
  });

  it('crossbow no longer gets a tower square-zone bonus (it has its own pierce shot instead)', () => {
    const enemy = makeUnit(2, 2, 'knight', 8, 8); // Chebyshev 3 — outside even the tower archer zone
    const unit = makeUnit(1, 1, 'crossbow', 5, 5, 3);
    expect(
      generateAttackActions(makeBoard([unit, enemy], [{ row: 5, col: 5 }]), unit).some(
        (a) => a.targetRow === 8 && a.targetCol === 8,
      ),
    ).toBe(false);
  });

  it('catapult on a tower bombards out to 9, not just 6', () => {
    const enemy = makeUnit(2, 2, 'knight', 5, 13); // manhattan 8
    const ground = makeUnit(1, 1, 'catapult', 5, 5);
    expect(
      generateAttackActions(makeBoard([ground, enemy]), ground).some(
        (a) => a.targetRow === 5 && a.targetCol === 13,
      ),
    ).toBe(false);

    const onTower = makeUnit(1, 1, 'catapult', 5, 5);
    expect(
      generateAttackActions(makeBoard([onTower, enemy], [{ row: 5, col: 5 }]), onTower).some(
        (a) => a.targetRow === 5 && a.targetCol === 13,
      ),
    ).toBe(true);
  });

  it('tower does not shrink the catapult minimum range', () => {
    const enemy = makeUnit(2, 2, 'knight', 5, 7); // manhattan 2 — inside the dead zone
    const unit = makeUnit(1, 1, 'catapult', 5, 5);
    expect(
      generateAttackActions(makeBoard([unit, enemy], [{ row: 5, col: 5 }]), unit).some(
        (a) => a.targetRow === 5 && a.targetCol === 7,
      ),
    ).toBe(false);
  });

  it('melee units get no range bonus from a tower', () => {
    const enemy = makeUnit(2, 2, 'knight', 5, 7);
    const unit = makeUnit(1, 1, 'knight', 5, 5);
    expect(generateAttackActions(makeBoard([unit, enemy], [{ row: 5, col: 5 }]), unit)).toEqual([]);
  });
});

describe('cavalry river leap', () => {
  // Board stub: `water` lists river cells; everything else is open ground.
  const mkBoard = (water: [number, number][], units: any[] = []) => ({
    unitAt: (r: number, c: number) => units.find((u) => u.row === r && u.col === c) ?? null,
    isRiver: (r: number, c: number) => water.some(([wr, wc]) => wr === r && wc === c),
    isFree: (r: number, c: number) =>
      r >= 0 && r < 20 && c >= 0 && c < 20 &&
      !water.some(([wr, wc]) => wr === r && wc === c) &&
      !units.some((u) => u.row === r && u.col === c),
  });
  const horse = (row = 5, col = 5, movesLeft = 3) => ({
    id: 1, type: 'cavalry' as const, player: 1 as const, row, col,
    hp: 5, armor: 3, damage: 6, maxMoves: 3, movesLeft, name: 'Конный',
  });

  it('leaps a one-cell river onto the far bank', () => {
    const moves = generateLegalMoves(mkBoard([[6, 5]]), horse());
    const leap = moves.find((m) => m.row === 7 && m.col === 5);
    expect(leap).toBeDefined();
    expect(leap!.cost).toBe(2);
  });

  it('cannot leap a two-cell river', () => {
    const moves = generateLegalMoves(mkBoard([[6, 5], [7, 5]]), horse());
    expect(moves.some((m) => m.row === 7 && m.col === 5)).toBe(false);
    expect(moves.some((m) => m.row === 8 && m.col === 5)).toBe(false);
  });

  it('cannot land on an occupied far bank', () => {
    const blocker = { id: 9, row: 7, col: 5, player: 2 };
    const moves = generateLegalMoves(mkBoard([[6, 5]], [blocker]), horse());
    expect(moves.some((m) => m.row === 7 && m.col === 5)).toBe(false);
  });

  it('needs 2 move points', () => {
    const moves = generateLegalMoves(mkBoard([[6, 5]]), horse(5, 5, 1));
    expect(moves.some((m) => m.row === 7 && m.col === 5)).toBe(false);
  });

  it('only cavalry can leap — a knight cannot', () => {
    const knight = { ...horse(), type: 'knight' as const, maxMoves: 2, movesLeft: 2 };
    const moves = generateLegalMoves(mkBoard([[6, 5]]), knight);
    expect(moves.some((m) => m.row === 7 && m.col === 5)).toBe(false);
  });
});

describe('facing — turning round costs a move', () => {
  it('a step into the back half costs +1 and side steps are free', () => {
    const k = { ...makeUnit(1, 1, 'knight', 5, 5), facing: 'right' as const };
    const moves = generateLegalMoves(makeBoard([k]), k);
    const cost = (r: number, c: number) => moves.find((m) => m.row === r && m.col === c)?.cost;
    expect(cost(5, 6)).toBe(1); // front
    expect(cost(4, 5)).toBe(1); // side
    expect(cost(6, 5)).toBe(1); // side
    expect(cost(5, 4)).toBe(2); // back: turn + step
  });

  it('a unit with no move to spare cannot strike behind itself', () => {
    const k = { ...makeUnit(1, 1, 'knight', 5, 5, 1), facing: 'up' as const };
    const behind = makeUnit(2, 2, 'knight', 6, 5);
    const ahead = makeUnit(3, 2, 'knight', 4, 5);
    expect(generateAttackActions(makeBoard([k, behind]), k)).toHaveLength(0);
    expect(generateAttackActions(makeBoard([k, ahead]), k).map((a) => a.cost)).toEqual([1]);
  });
});
