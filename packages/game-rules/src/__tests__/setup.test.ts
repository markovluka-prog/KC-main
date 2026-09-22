import { describe, expect, it } from 'vitest';
import { createMatchSetup } from '../setup.js';

describe('createMatchSetup', () => {
  it('is deterministic for a given seed', () => {
    expect(createMatchSetup(12345)).toEqual(createMatchSetup(12345));
  });

  it('varies across seeds', () => {
    // Across a spread of seeds the layout should not be identical every time.
    const a = JSON.stringify(createMatchSetup(1));
    const differs = [2, 3, 4, 5, 6, 7, 8].some((s) => JSON.stringify(createMatchSetup(s)) !== a);
    expect(differs).toBe(true);
  });

  it('builds 22 units (11 per side, incl. the base-roster mage) with unique ids and correct stats', () => {
    const s = createMatchSetup(42);
    expect(s.units).toHaveLength(22);
    expect(s.units.filter((u) => u.player === 1)).toHaveLength(11);
    expect(s.units.filter((u) => u.player === 2)).toHaveLength(11);
    expect(new Set(s.units.map((u) => u.id)).size).toBe(22);

    const knight = s.units.find((u) => u.type === 'knight')!;
    expect(knight.hp).toBe(3);
    expect(knight.maxHp).toBe(3);
    expect(knight.damage).toBe(5);
    expect(knight.armor).toBe(4);
    expect(knight.maxMoves).toBe(2);
    const cavalry = s.units.find((u) => u.type === 'cavalry')!;
    expect(cavalry.hp).toBe(5);
    expect(cavalry.damage).toBe(6);
    const archer = s.units.find((u) => u.type === 'archer')!;
    expect(archer.damage).toBe(3);

    // Every unit starts fresh.
    s.units.forEach((u) => {
      expect(u.done).toBe(false);
      expect(u.movesLeft).toBe(u.maxMoves);
      expect(u.weapon).toBeNull();
      expect(u.hp).toBe(u.maxHp);
    });
  });

  it('places player 1 on top rows and player 2 on bottom rows', () => {
    const s = createMatchSetup(7);
    const p1max = Math.max(...s.units.filter((u) => u.player === 1).map((u) => u.row));
    const p2min = Math.min(...s.units.filter((u) => u.player === 2).map((u) => u.row));
    expect(p1max).toBeLessThan(p2min);
  });

  it('produces a valid map: no starting towers (built by knights now), a 2x2 ruins, castle cols 0-16', () => {
    const s = createMatchSetup(99);
    expect(s.towers).toHaveLength(0);
    expect(s.ruins.width).toBe(2);
    expect(s.ruins.height).toBe(2);
    expect(s.ruins.top).toBeGreaterThanOrEqual(8);
    expect(s.ruins.top).toBeLessThanOrEqual(10);
    expect(s.castleP1Col).toBeGreaterThanOrEqual(0);
    expect(s.castleP1Col).toBeLessThanOrEqual(16); // COLS(20) - 4 = 16
    expect(s.castleP2Col).toBeGreaterThanOrEqual(0);
    expect(s.castleP2Col).toBeLessThanOrEqual(16); // COLS(20) - 4 = 16
  });
});
