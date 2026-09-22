/**
 * Phase 5 T5.2 — ELO computation. K=32 baseline, K=16 after 30 matches
 * (master plan §10.3). Draws are valid outcomes but not produced by our
 * win condition; included for completeness in case of timeouts later.
 */

export interface EloDelta {
  /** ELO change for player A (signed). B's delta is -deltaA. */
  deltaA: number;
  deltaB: number;
  /** Expected score A — useful for suspicious-flag heuristic. */
  expectedA: number;
}

export interface EloInputs {
  ratingA: number;
  ratingB: number;
  /** 1 = A won, 0 = B won, 0.5 = draw. */
  scoreA: 0 | 0.5 | 1;
  gamesPlayedA: number;
  gamesPlayedB: number;
}

function kFactor(gamesPlayed: number): number {
  return gamesPlayed < 30 ? 32 : 16;
}

export function computeElo(input: EloInputs): EloDelta {
  const expectedA = 1 / (1 + Math.pow(10, (input.ratingB - input.ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = (1 - input.scoreA) as 0 | 0.5 | 1;
  const deltaA = Math.round(kFactor(input.gamesPlayedA) * (input.scoreA - expectedA));
  const deltaB = Math.round(kFactor(input.gamesPlayedB) * (scoreB - expectedB));
  return { deltaA, deltaB, expectedA };
}

/**
 * Suspicious-rise detection (T5.6). Trigger when ELO climbs >100 over the
 * last `windowSize` matches. Server marks user_stats.suspicious=true but
 * does not block play; the flag surfaces in admin view (out of scope for
 * launch — see master plan §10.6).
 */
export interface RecentMatchOutcome {
  ratingBefore: number;
  ratingAfter: number;
}

export function isSuspiciousRise(history: RecentMatchOutcome[], windowSize = 10): boolean {
  if (history.length < windowSize) return false;
  const slice = history.slice(-windowSize);
  const totalDelta = slice[slice.length - 1]!.ratingAfter - slice[0]!.ratingBefore;
  return totalDelta > 100;
}
