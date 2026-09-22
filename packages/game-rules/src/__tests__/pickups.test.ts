import { describe, expect, it } from 'vitest';
import { buildExcludedCells, pickupAt, removePickupAt, scatterHiddenPickups } from '../pickups.js';
import { createMatchSetup } from '../setup.js';
import { COLS, HIDDEN_PICKUP_SPAWN, ROWS } from '../constants.js';
import { mulberry32 } from '../rng.js';

const TOWERS = [
  { row: 5, col: 4 },
  { row: 14, col: 15 },
];

function scatter(seed = 1234, occupied: { row: number; col: number }[] = []) {
  return scatterHiddenPickups(mulberry32(seed), {
    castleP1Col: 8,
    castleP2Col: 8,
    towers: TOWERS,
    occupied,
  });
}

describe('scatterHiddenPickups', () => {
  it('buries the configured share of the board for each entry', () => {
    const pickups = scatter();
    const totalCells = ROWS * COLS;
    for (const entry of HIDDEN_PICKUP_SPAWN) {
      const expected = Math.round((entry.percent / 100) * totalCells);
      const actual = pickups.filter((p) => p.kind === entry.kind && p.name === entry.name).length;
      expect(actual).toBe(expected);
    }
  });

  it('scatters weapons and armour alongside weapon parts', () => {
    const pickups = scatter();
    expect(pickups.some((p) => p.kind === 'part')).toBe(true);
    expect(pickups.some((p) => p.kind === 'weapon' && p.name === 'Солнечный меч')).toBe(true);
    expect(pickups.some((p) => p.kind === 'armor' && p.name === 'Латы')).toBe(true);
  });

  it('never puts two pickups on the same cell', () => {
    const pickups = scatter();
    const seen = new Set(pickups.map((p) => `${p.row},${p.col}`));
    expect(seen.size).toBe(pickups.length);
  });

  it('never buries anything on a tower, in a castle, or under a starting unit', () => {
    const occupied = [
      { row: 6, col: 3 },
      { row: 13, col: 17 },
    ];
    const pickups = scatter(99, occupied);
    const excluded = buildExcludedCells({
      castleP1Col: 8,
      castleP2Col: 8,
      towers: TOWERS,
      occupied,
    });
    for (const p of pickups) {
      expect(excluded.has(`${p.row},${p.col}`)).toBe(false);
    }
    for (const t of TOWERS) {
      expect(pickups.some((p) => p.row === t.row && p.col === t.col)).toBe(false);
    }
    for (const o of occupied) {
      expect(pickups.some((p) => p.row === o.row && p.col === o.col)).toBe(false);
    }
  });

  it('is deterministic for a given seed and differs across seeds', () => {
    const a = scatter(7);
    const b = scatter(7);
    expect(b).toEqual(a);
    const c = scatter(8);
    expect(c).not.toEqual(a);
  });

  it('stays inside the board', () => {
    for (const p of scatter(4242)) {
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeLessThan(ROWS);
      expect(p.col).toBeGreaterThanOrEqual(0);
      expect(p.col).toBeLessThan(COLS);
    }
  });
});

describe('pickupAt / removePickupAt', () => {
  it('finds a buried pickup and removes exactly that one', () => {
    const pickups = scatter(31337);
    const target = pickups[0]!;
    expect(pickupAt(pickups, target.row, target.col)).toEqual(target);

    const rest = removePickupAt(pickups, target.row, target.col);
    expect(rest.length).toBe(pickups.length - 1);
    expect(pickupAt(rest, target.row, target.col)).toBeNull();
  });

  it('returns null for an empty cell', () => {
    const pickups = scatter(5);
    const empty = { row: TOWERS[0]!.row, col: TOWERS[0]!.col }; // towers are never seeded
    expect(pickupAt(pickups, empty.row, empty.col)).toBeNull();
  });
});

describe('createMatchSetup', () => {
  it('buries pickups clear of every starting unit', () => {
    const setup = createMatchSetup(2024);
    expect(setup.hiddenPickups.length).toBeGreaterThan(0);
    for (const u of setup.units) {
      expect(setup.hiddenPickups.some((p) => p.row === u.row && p.col === u.col)).toBe(false);
    }
    for (const t of setup.towers) {
      expect(setup.hiddenPickups.some((p) => p.row === t.row && p.col === t.col)).toBe(false);
    }
  });

  it('produces the same scatter for the same seed', () => {
    expect(createMatchSetup(77).hiddenPickups).toEqual(createMatchSetup(77).hiddenPickups);
  });
});
