import { expect, test } from '@playwright/test';

/**
 * Live-browser regression for the AI plan vs. real-rules mismatch.
 *
 * Two independent move/attack generators exist: the game's own
 * (generateLegalMoves / generateAttackActions from @kc/game-rules, used to
 * build moveMap/attackMap) and the search's light-state generator in ai.ts.
 * When they disagree, `performMove`/`performAttack` return false and the
 * planned action is silently dropped — invisible from the outside, since the
 * bot just quietly wastes an activation instead of erroring.
 *
 * Unit tests over the light-state harness cannot catch every case: this class
 * of bug has already slipped past them three times (knight/samurai move shape,
 * impassable terrain, cavalry Г-attack side landings) because the harness's own
 * `applyPlan` used to skip the same real-rules check the game performs. This
 * spec plays REAL turns in a REAL browser against the REAL board (real terrain,
 * real castle layout, real ruins) and reads `AIPlayer.execStats` — the counters
 * recorded at the one place a planned action meets `performMove`/`performAttack`
 * — so it cannot be fooled by a harness that is more permissive than the game.
 */

interface ProbeGame {
  currentPlayer?: number;
  winner?: number | null;
  board?: { units: Array<{ player: number; done: boolean; hp: number }> };
  ai?: { thinkProgress: number | null };
  startMatch: (mode: string, difficulty: string) => void;
  forceEndTurn: () => void;
}

interface ExecStats {
  moveOk: number;
  moveRejected: number;
  attackOk: number;
  attackRejected: number;
  log: string[];
}

declare global {
  interface Window {
    __kcGame?: ProbeGame;
    __kcAIStats?: () => ExecStats;
  }
}

test('AI plan matches the real rules across several turns of live play', async ({ page }) => {
  test.setTimeout(300_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // Skip the first-run coachmark tutorial so it cannot intercept clicks/taps
  // meant for the board during the AI's think-then-play loop below.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('kac_tutorial_v1', '1');
    } catch {
      /* ignore */
    }
  });

  await page.goto('/');
  await page.waitForFunction(
    () => document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 15_000 },
  );

  // Hard: the deepest search and the one the user reported playing.
  await page.evaluate(() => window.__kcGame?.startMatch('ai', 'hard'));
  await page.waitForFunction(() => window.__kcGame?.board !== undefined, { timeout: 15_000 });

  // Reset counters right after the match starts, so only THIS run counts.
  await page.evaluate(() => {
    const s = window.__kcAIStats?.();
    if (s) {
      s.moveOk = 0;
      s.moveRejected = 0;
      s.attackOk = 0;
      s.attackRejected = 0;
      s.log.length = 0;
    }
  });

  // Alternate: human passes immediately, AI thinks and plays, repeat. Six full
  // AI turns is enough to exercise every unit type multiple times without
  // making the run too slow (hard's think is the long pole here).
  const TURNS = 6;
  for (let i = 0; i < TURNS; i += 1) {
    const winner = await page.evaluate(() => window.__kcGame?.winner ?? null);
    if (winner !== null && winner !== undefined) {
      console.log(`[ai-illegal-moves] game ended early at turn ${i}, winner=${winner}`);
      break;
    }

    // Hand the turn to the AI. Do NOT gate on thinkProgress becoming a number
    // first — with few units left the search can finish inside a single
    // frame, so thinkProgress goes 0 -> null before a poll ever observes it.
    // currentPlayer flipping back to 1 (or a winner appearing) is the only
    // signal that cannot be missed by a race.
    await page.evaluate(() => window.__kcGame?.forceEndTurn());
    await page.waitForFunction(
      () => window.__kcGame?.currentPlayer === 1 || (window.__kcGame?.winner ?? null) !== null,
      { timeout: 60_000 },
    );
    console.log(`[ai-illegal-moves] turn ${i} done`);
  }

  const stats = await page.evaluate(() => window.__kcAIStats?.());
  expect(stats, 'window.__kcAIStats() must be exposed').toBeTruthy();
  const s = stats as ExecStats;

  const totalMoves = s.moveOk + s.moveRejected;
  const totalAttacks = s.attackOk + s.attackRejected;
  const moveRejectRate = totalMoves > 0 ? s.moveRejected / totalMoves : 0;
  const attackRejectRate = totalAttacks > 0 ? s.attackRejected / totalAttacks : 0;

  console.log(
    `[ai-illegal-moves] moveOk=${s.moveOk} moveRejected=${s.moveRejected} (${(moveRejectRate * 100).toFixed(1)}%) ` +
      `attackOk=${s.attackOk} attackRejected=${s.attackRejected} (${(attackRejectRate * 100).toFixed(1)}%)`,
  );
  if (s.log.length > 0) console.log('[ai-illegal-moves] rejected actions:\n' + s.log.join('\n'));

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  // Some rejects can be legitimate races (a unit dying mid-plan from an earlier
  // action changes what's legal for a later one) — the bar is "rare", not zero.
  expect(
    moveRejectRate,
    `move reject rate too high (${s.moveRejected}/${totalMoves}):\n${s.log.join('\n')}`,
  ).toBeLessThan(0.03);
  expect(
    attackRejectRate,
    `attack reject rate too high (${s.attackRejected}/${totalAttacks}):\n${s.log.join('\n')}`,
  ).toBeLessThan(0.03);
});
