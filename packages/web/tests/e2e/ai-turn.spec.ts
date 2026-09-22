import { expect, test } from '@playwright/test';

/**
 * Regression test for the watchdog aborting worker-backed AI turns.
 *
 * The watchdog force-ends a turn that shows no measurable progress. While the
 * search is thinking the board deliberately does not change, so the think must
 * be exempt. The exemption originally checked only `mctsRoot`, which the
 * off-thread worker never sets — so every AI turn logged
 *   "AI watchdog: no progress; forcing end of turn."
 * and the bot's turn was cut short mid-search.
 *
 * Unit tests cannot cover this: under Node there is no Worker, so the whole
 * worker path is skipped. It has to be a real browser playing a real turn.
 */

interface ProbeGame {
  currentPlayer?: number;
  board?: { units: Array<{ player: number; done: boolean }> };
  ai?: { thinkProgress: number | null };
  startMatch: (mode: string, difficulty: string) => void;
  forceEndTurn: () => void;
}

declare global {
  interface Window {
    __kcGame?: ProbeGame;
  }
}

test('AI completes a worker-backed turn without the watchdog force-ending it', async ({ page }) => {
  test.setTimeout(120_000);

  const watchdogWarnings: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('AI watchdog')) watchdogWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto('/');
  await page.waitForFunction(
    () => document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 15_000 },
  );

  // Hard = the longest think, so the most watchdog frames to survive.
  await page.evaluate(() => window.__kcGame?.startMatch('ai', 'hard'));
  await page.waitForFunction(() => window.__kcGame?.board !== undefined, { timeout: 15_000 });
  // The game opens on the human's turn; hand it straight to the AI.
  await page.evaluate(() => window.__kcGame?.forceEndTurn());

  // The search must actually run: thinkProgress becomes a number while the
  // worker is busy. Without this the assertion below could pass vacuously on a
  // bot that never thought at all.
  await page.waitForFunction(() => typeof window.__kcGame?.ai?.thinkProgress === 'number', {
    timeout: 30_000,
  });

  // The AI must then finish its turn and hand play back — proving the search ran
  // to completion rather than being cut short by the watchdog.
  await page.waitForFunction(() => window.__kcGame?.currentPlayer === 1, { timeout: 60_000 });

  expect(watchdogWarnings, `watchdog fired: ${watchdogWarnings.join(' | ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
