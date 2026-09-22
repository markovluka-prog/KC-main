/**
 * Phase 5 T5.2 — ELO computation. K=32 baseline, K=16 after 30 matches
 * (master plan §10.3). Draws are valid outcomes but not produced by our
 * win condition; included for completeness in case of timeouts later.
 */
function kFactor(gamesPlayed) {
    return gamesPlayed < 30 ? 32 : 16;
}
export function computeElo(input) {
    const expectedA = 1 / (1 + Math.pow(10, (input.ratingB - input.ratingA) / 400));
    const expectedB = 1 - expectedA;
    const scoreB = (1 - input.scoreA);
    const deltaA = Math.round(kFactor(input.gamesPlayedA) * (input.scoreA - expectedA));
    const deltaB = Math.round(kFactor(input.gamesPlayedB) * (scoreB - expectedB));
    return { deltaA, deltaB, expectedA };
}
export function isSuspiciousRise(history, windowSize = 10) {
    if (history.length < windowSize)
        return false;
    const slice = history.slice(-windowSize);
    const totalDelta = slice[slice.length - 1].ratingAfter - slice[0].ratingBefore;
    return totalDelta > 100;
}
