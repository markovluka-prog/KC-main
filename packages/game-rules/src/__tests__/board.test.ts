import { describe, expect, it, vi } from 'vitest';
import { clamp, insideBoard, manhattan, randomChoice, weightedChoice } from '../board.js';

describe('board helpers', () => {
  it('insideBoard accepts in-bounds and rejects out-of-bounds', () => {
    expect(insideBoard(0, 0)).toBe(true);
    expect(insideBoard(19, 19)).toBe(true);
    expect(insideBoard(-1, 5)).toBe(false);
    expect(insideBoard(5, -1)).toBe(false);
    expect(insideBoard(20, 0)).toBe(false);
    expect(insideBoard(0, 20)).toBe(false);
  });

  it('manhattan is the sum of axis distances', () => {
    expect(manhattan(0, 0, 0, 0)).toBe(0);
    expect(manhattan(0, 0, 3, 4)).toBe(7);
    expect(manhattan(5, 5, 2, 9)).toBe(7);
  });

  it('clamp clips to bounds inclusive', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  describe('randomChoice', () => {
    it('returns the only element of a singleton array', () => {
      expect(randomChoice([42])).toBe(42);
    });

    it('picks deterministically when Math.random is mocked', () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(randomChoice(['a', 'b', 'c'])).toBe('a');
      spy.mockReturnValue(0.99);
      expect(randomChoice(['a', 'b', 'c'])).toBe('c');
      spy.mockRestore();
    });

    it('throws on empty array', () => {
      expect(() => randomChoice([])).toThrow(/empty/);
    });
  });

  describe('weightedChoice', () => {
    it('returns the only item', () => {
      expect(weightedChoice(['solo'], [1])).toBe('solo');
    });

    it('picks first item when random rolls 0', () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(weightedChoice(['a', 'b', 'c'], [1, 1, 1])).toBe('a');
      spy.mockRestore();
    });

    it('picks last item when random rolls just below 1', () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);
      expect(weightedChoice(['a', 'b', 'c'], [1, 1, 1])).toBe('c');
      spy.mockRestore();
    });

    it('respects weights — heavily-weighted item dominates', () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      // weights total 100; pick falls at 50 → first bucket (90) wins.
      expect(weightedChoice(['heavy', 'light'], [90, 10])).toBe('heavy');
      spy.mockRestore();
    });

    it('throws on empty items', () => {
      expect(() => weightedChoice([], [])).toThrow(/empty/);
    });

    it('throws on length mismatch', () => {
      expect(() => weightedChoice(['a', 'b'], [1])).toThrow(/length mismatch/);
    });

    it('throws on zero total weight', () => {
      expect(() => weightedChoice(['a', 'b'], [0, 0])).toThrow(/total weight/);
    });
  });
});
