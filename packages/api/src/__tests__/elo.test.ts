import { describe, expect, it } from 'vitest';
import { computeElo, isSuspiciousRise } from '../stats/elo.js';

describe('computeElo', () => {
  it('K=32 below 30 games played', () => {
    const r = computeElo({
      ratingA: 1500,
      ratingB: 1500,
      scoreA: 1,
      gamesPlayedA: 0,
      gamesPlayedB: 0,
    });
    // Expected 0.5, score 1 → delta = 32 * 0.5 = 16.
    expect(r.deltaA).toBe(16);
    expect(r.deltaB).toBe(-16);
  });

  it('K=16 at ≥ 30 games played', () => {
    const r = computeElo({
      ratingA: 1500,
      ratingB: 1500,
      scoreA: 1,
      gamesPlayedA: 30,
      gamesPlayedB: 30,
    });
    expect(r.deltaA).toBe(8);
    expect(r.deltaB).toBe(-8);
  });

  it('higher-rated player gains less from beating lower-rated', () => {
    const r = computeElo({
      ratingA: 1800,
      ratingB: 1500,
      scoreA: 1,
      gamesPlayedA: 30,
      gamesPlayedB: 30,
    });
    expect(r.deltaA).toBeGreaterThan(0);
    expect(r.deltaA).toBeLessThan(8);
  });

  it('lower-rated player gains more from upset', () => {
    const r = computeElo({
      ratingA: 1200,
      ratingB: 1800,
      scoreA: 1,
      gamesPlayedA: 30,
      gamesPlayedB: 30,
    });
    expect(r.deltaA).toBeGreaterThan(8);
  });

  it('draw produces small or zero deltas', () => {
    const r = computeElo({
      ratingA: 1500,
      ratingB: 1500,
      scoreA: 0.5,
      gamesPlayedA: 30,
      gamesPlayedB: 30,
    });
    expect(r.deltaA).toBe(0);
    expect(r.deltaB).toBe(0);
  });
});

describe('isSuspiciousRise', () => {
  it('false when history smaller than window', () => {
    const h = [{ ratingBefore: 1000, ratingAfter: 1200 }];
    expect(isSuspiciousRise(h, 10)).toBe(false);
  });

  it('true when rise > 100 across the window', () => {
    const h = Array.from({ length: 10 }, (_, i) => ({
      ratingBefore: 1000 + i * 15,
      ratingAfter: 1000 + (i + 1) * 15,
    }));
    // Total rise: 150.
    expect(isSuspiciousRise(h, 10)).toBe(true);
  });

  it('false when rise ≤ 100 across the window', () => {
    const h = Array.from({ length: 10 }, (_, i) => ({
      ratingBefore: 1000 + i * 8,
      ratingAfter: 1000 + (i + 1) * 8,
    }));
    expect(isSuspiciousRise(h, 10)).toBe(false);
  });
});
