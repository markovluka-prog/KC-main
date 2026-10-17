// AUTO-VENDORED from packages/game-rules/src/setup.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
// Deterministic match setup (A0): seeds the board roster + map layout from a
// single seed, so the SERVER (not the client) is the source of truth for an
// online match. Pure + DOM-free. Mirrors the client's Board.initUnits +
// randomizeMapPositions, but seeded so both peers agree.
import { mulberry32 } from './rng.ts';
import { COLS, MAGE_MAX_ENERGY, ROWS, START_POSITIONS_P1, UNIT_TYPES, emptyBackpack } from './constants.ts';
import { scatterHiddenPickups } from './pickups.ts';
import type {
  HiddenPickup,
  Player,
  RuinsArea,
  StartPosition,
  TerrainCell,
  TowerPosition,
} from './types.ts';
import type { SerializedUnit } from './save.ts';

export interface MatchSetup {
  units: SerializedUnit[];
  towers: TowerPosition[];
  ruins: RuinsArea;
  /** Second ruins area (two ruins on the map). */
  ruins2: RuinsArea;
  castleP1Col: number;
  castleP2Col: number;
  terrain: TerrainCell[];
  /** Hidden artifacts/weapons/armour buried across the board for this match. */
  hiddenPickups: HiddenPickup[];
}

function buildUnit(
  id: number,
  player: Player,
  pos: StartPosition,
  row: number,
  col: number,
): SerializedUnit {
  const t = UNIT_TYPES[pos.type];
  const unit: SerializedUnit = {
    id,
    player,
    type: pos.type,
    row,
    col,
    maxHp: t.hp,
    hp: t.hp,
    startArmor: t.armor,
    armor: t.armor,
    maxArmor: t.armor,
    damage: t.damage,
    maxMoves: t.moves,
    movesLeft: t.moves,
    done: false,
    activated: false,
    visualRow: null,
    visualCol: null,
    dying: false,
    deathProgress: 0,
    weapon: null,
    armorGear: null,
    backpack: emptyBackpack(),
    wardedBy: null,
  };
  if (pos.type === 'mage') {
    unit.maxEnergy = MAGE_MAX_ENERGY;
    unit.energy = MAGE_MAX_ENERGY;
    unit.warding = [];
  }
  return unit;
}

/**
 * Build a fresh, deterministic match from `seed`. Canonical orientation:
 * player 1 occupies the top rows, player 2 the bottom (the client flips for
 * rendering based on which side it controls). Castles are 4×4 at cols 0–6;
 * ruins are a 2×2 in the mid-board avoiding both castle footprints; two tower
 * columns sit on rows 5 and 14.
 */
export function createMatchSetup(seed: number): MatchSetup {
  const rng = mulberry32(seed);
  const int = (n: number): number => Math.floor(rng.next() * n);

  const maxCastleCol = COLS - 4; // 16 for COLS=20
  const castleP1Col = int(maxCastleCol + 1);
  const castleP2Col = int(maxCastleCol + 1);

  const overlapsCastle = (left: number, width: number, castleCol: number): boolean =>
    left < castleCol + 4 && left + width > castleCol;

  const maxRuinsCol = COLS - 2;
  let ruinsCol = int(maxRuinsCol + 1);
  for (let guard = 0; guard < 50; guard += 1) {
    if (!overlapsCastle(ruinsCol, 2, castleP1Col) && !overlapsCastle(ruinsCol, 2, castleP2Col))
      break;
    ruinsCol = int(maxRuinsCol + 1);
  }
  const ruins: RuinsArea = { left: ruinsCol, top: 8 + int(3), width: 2, height: 2 };

  // Second ruins area — avoid castles AND the first ruins so they don't touch.
  const overlapsRect = (a: RuinsArea, b: RuinsArea): boolean =>
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top;
  let ruins2: RuinsArea = { left: int(maxRuinsCol + 1), top: 8 + int(3), width: 2, height: 2 };
  for (let guard = 0; guard < 80; guard += 1) {
    const clearOfCastles =
      !overlapsCastle(ruins2.left, 2, castleP1Col) && !overlapsCastle(ruins2.left, 2, castleP2Col);
    // Keep a 1-cell gap between the two ruins so they read as distinct.
    const padded: RuinsArea = {
      left: ruins.left - 1,
      top: ruins.top - 1,
      width: ruins.width + 2,
      height: ruins.height + 2,
    };
    if (clearOfCastles && !overlapsRect(ruins2, padded)) break;
    ruins2 = { left: int(maxRuinsCol + 1), top: 8 + int(3), width: 2, height: 2 };
  }

  // Mage towers no longer exist as a fixed match-start feature — towers are
  // now an ordinary structure knights build themselves (see
  // BUILD_WORK_TOTAL / applyBuild). The match starts with none.
  const towers: TowerPosition[] = [];

  // River: pick a row that doesn't intersect the ruins area.
  let riverRow = 7 + int(6); // rows 7–12
  for (let guard = 0; guard < 20; guard += 1) {
    const rowInRuins = (a: RuinsArea): boolean => riverRow >= a.top && riverRow < a.top + a.height;
    if (!rowInRuins(ruins) && !rowInRuins(ruins2)) break;
    riverRow = 7 + int(6);
  }
  // No auto-generated bridges any more — a river is impassable everywhere
  // until a knight builds a bridge on it (see BUILD_WORK_TOTAL / applyBuild).
  const terrain: TerrainCell[] = [];
  for (let c = 0; c < COLS; c += 1) {
    terrain.push({ row: riverRow, col: c, type: 'river' });
  }

  // Mountains: 5–8 scattered impassable cells in the non-castle mid-board.
  const mountainCount = 5 + int(4);
  const blocked = new Set<string>();
  // Pre-block castle zones, river row, ruins cells, and tower cells.
  for (let c = castleP1Col; c < castleP1Col + 4; c += 1)
    for (let r = 0; r < 4; r += 1) blocked.add(`${r},${c}`);
  for (let c = castleP2Col; c < castleP2Col + 4; c += 1)
    for (let r = ROWS - 4; r < ROWS; r += 1) blocked.add(`${r},${c}`);
  for (let c = 0; c < COLS; c += 1) blocked.add(`${riverRow},${c}`);
  for (const area of [ruins, ruins2])
    for (let r = area.top; r < area.top + area.height; r += 1)
      for (let c = area.left; c < area.left + area.width; c += 1) blocked.add(`${r},${c}`);
  for (const t of towers) blocked.add(`${t.row},${t.col}`);

  for (
    let attempt = 0;
    attempt < 200 && terrain.filter((t) => t.type === 'mountain').length < mountainCount;
    attempt += 1
  ) {
    const mr = 4 + int(ROWS - 8); // rows 4–15
    const mc = int(COLS);
    const key = `${mr},${mc}`;
    if (!blocked.has(key)) {
      blocked.add(key);
      terrain.push({ row: mr, col: mc, type: 'mountain' });
    }
  }

  const units: SerializedUnit[] = [];
  let id = 1;
  for (const p of START_POSITIONS_P1) {
    units.push(buildUnit(id++, 1, p, p.row, p.col + castleP1Col));
  }
  for (const p of START_POSITIONS_P1) {
    units.push(buildUnit(id++, 2, p, ROWS - 1 - p.row, p.col + castleP2Col));
  }

  // Bury the hidden pickups last, once every unit and structure is placed, so
  // the scatter can exclude their cells.
  const hiddenPickups = scatterHiddenPickups(rng, {
    castleP1Col,
    castleP2Col,
    towers,
    occupied: units.map((u) => ({ row: u.row, col: u.col })),
    terrain,
  });

  return { units, towers, ruins, ruins2, castleP1Col, castleP2Col, terrain, hiddenPickups };
}
