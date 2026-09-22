import { afterEach, describe, expect, it } from 'vitest';
import {
  getCastleP1Col,
  getCastleP2Col,
  getRuins,
  getTowers,
  resetWorld,
  setCastleColumns,
  setCastleP1Col,
  setCastleP2Col,
  setRuins,
  setTowers,
} from '../world.js';

// Module-level world state mutates globally; reset between tests to
// avoid order-dependent failures. Phase 1.5 S4 collapses these into a
// passed GameState; once that lands, these tests still exercise the
// bridge getters/setters.
describe('world (module-state bridge)', () => {
  afterEach(() => resetWorld());

  it('defaults are returned when nothing is set', () => {
    expect(typeof getCastleP1Col()).toBe('number');
    expect(typeof getCastleP2Col()).toBe('number');
    // No starting towers any more — they're built by knights (stage B).
    expect(getTowers()).toEqual([]);
    expect(getRuins()).toEqual(
      expect.objectContaining({ top: expect.any(Number), left: expect.any(Number) }),
    );
  });

  it('setCastleColumns clamps to [0, 16]', () => {
    setCastleColumns(2, 5);
    expect(getCastleP1Col()).toBe(2);
    expect(getCastleP2Col()).toBe(5);
    setCastleColumns(-99, 99);
    expect(getCastleP1Col()).toBe(0);
    expect(getCastleP2Col()).toBe(16); // COLS(20) - 4 = 16
  });

  it('non-finite castle column falls back to the P1 default', () => {
    setCastleP1Col(Number.NaN);
    // Default is some valid column ≥ 0.
    expect(getCastleP1Col()).toBeGreaterThanOrEqual(0);
  });

  it('setCastleP1Col / setCastleP2Col update independently', () => {
    setCastleP1Col(1);
    setCastleP2Col(4);
    expect(getCastleP1Col()).toBe(1);
    expect(getCastleP2Col()).toBe(4);
  });

  it('setTowers deep-copies — mutating input does not affect stored', () => {
    const input = [{ row: 5, col: 5 }];
    setTowers(input);
    input[0]!.col = 999;
    expect(getTowers()[0]?.col).toBe(5);
  });

  it('setRuins deep-copies', () => {
    const input = { top: 7, left: 2, width: 3, height: 3 };
    setRuins(input);
    input.top = 999;
    expect(getRuins().top).toBe(7);
  });

  it('resetWorld restores defaults after mutation', () => {
    setCastleColumns(0, 0);
    setTowers([{ row: 5, col: 5 }]);
    setRuins({ top: 0, left: 0, width: 1, height: 1 });
    resetWorld();
    // No starting towers any more — they're built by knights (stage B).
    expect(getTowers()).toEqual([]);
    expect(getRuins().width).toBeGreaterThan(1);
  });
});
