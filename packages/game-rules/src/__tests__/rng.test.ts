import { describe, expect, it } from 'vitest';
import { mulberry32, nondetRng, randomChoiceWith, weightedChoiceWith } from '../rng.js';

describe('mulberry32 (seeded RNG)', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a.next(), a.next(), a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences', () => {
    const a = mulberry32(42);
    const b = mulberry32(43);
    expect(a.next()).not.toBe(b.next());
  });

  it('samples are in [0, 1)', () => {
    const r = mulberry32(123);
    for (let i = 0; i < 1000; i += 1) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('cursor increments per sample', () => {
    const r = mulberry32(7);
    expect(r.cursor()).toBe(0);
    r.next();
    expect(r.cursor()).toBe(1);
    r.next();
    r.next();
    expect(r.cursor()).toBe(3);
  });

  it('fast-forwarding with startCursor lands at the same position', () => {
    const a = mulberry32(99);
    a.next();
    a.next();
    a.next();
    const after = a.next();
    const b = mulberry32(99, 3);
    expect(b.next()).toBe(after);
  });
});

describe('nondetRng', () => {
  it('returns samples in [0, 1)', () => {
    const r = nondetRng();
    for (let i = 0; i < 100; i += 1) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('cursor is irrelevant — stays at 0', () => {
    const r = nondetRng();
    r.next();
    r.next();
    expect(r.cursor()).toBe(0);
  });
});

describe('randomChoiceWith / weightedChoiceWith', () => {
  it('randomChoiceWith deterministic with same seed', () => {
    const r1 = mulberry32(5);
    const r2 = mulberry32(5);
    const seq1 = [
      randomChoiceWith(r1, ['a', 'b', 'c', 'd']),
      randomChoiceWith(r1, ['a', 'b', 'c', 'd']),
      randomChoiceWith(r1, ['a', 'b', 'c', 'd']),
    ];
    const seq2 = [
      randomChoiceWith(r2, ['a', 'b', 'c', 'd']),
      randomChoiceWith(r2, ['a', 'b', 'c', 'd']),
      randomChoiceWith(r2, ['a', 'b', 'c', 'd']),
    ];
    expect(seq1).toEqual(seq2);
  });

  it('weightedChoiceWith respects weights', () => {
    const counts = { heavy: 0, light: 0 };
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i += 1) {
      const pick = weightedChoiceWith(r, ['heavy', 'light'] as const, [90, 10]);
      counts[pick] += 1;
    }
    // With weights 90:10, expect ~900:100 ± noise.
    expect(counts.heavy).toBeGreaterThan(800);
    expect(counts.light).toBeLessThan(200);
  });

  it('throws on empty / mismatched / zero-weight inputs', () => {
    const r = mulberry32(1);
    expect(() => randomChoiceWith(r, [])).toThrow();
    expect(() => weightedChoiceWith(r, [], [])).toThrow();
    expect(() => weightedChoiceWith(r, ['a', 'b'], [1])).toThrow(/mismatch/);
    expect(() => weightedChoiceWith(r, ['a', 'b'], [0, 0])).toThrow(/total/);
  });
});
