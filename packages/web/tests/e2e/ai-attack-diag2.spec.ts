import { expect, test } from '@playwright/test';

/** ONE-OFF diagnostic: force the NON-worker (frame-sliced, main-thread) search
 *  path and see whether attacks show up, to isolate whether the missing-attack
 *  bug is specific to the Worker path or present in the shared search code. */

interface ProbeGame {
  currentPlayer?: number;
  winner?: number | null;
  startMatch: (mode: string, difficulty: string) => void;
  forceEndTurn: () => void;
  ai?: unknown;
}

interface ExecStats {
  moveOk: number;
  moveRejected: number;
  attackOk: number;
  attackRejected: number;
  plannedAttacks: number;
  plannedMoves: number;
  log: string[];
}

declare global {
  interface Window {
    __kcGame?: ProbeGame;
    __kcAIStats?: () => ExecStats;
    __kcForceNoWorker?: () => void;
  }
}

test('does the NON-worker (in-thread) search find attacks', async ({ page }) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') {
      console.log(`[browser ${msg.type()}]`, msg.text());
    }
  });

  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('kac_tutorial_v1', '1');
      window.localStorage.removeItem('knights_and_castles_save_v1');
    } catch {
      /* ignore */
    }
  });

  await page.goto('/');
  await page.waitForFunction(
    () => document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 15_000 },
  );

  await page.evaluate(() => window.__kcGame?.startMatch('ai', 'hard'));
  await page.waitForFunction(() => window.__kcGame !== undefined, { timeout: 15_000 });

  // Force the in-thread fallback: disable the worker path entirely so every
  // subsequent AI turn uses mctsBegin/mctsSlice/mctsFinish sliced across
  // frames on the main thread instead of postMessage to ai-worker.ts.
  const disabled = await page.evaluate(() => {
    const w = window as unknown as { __kcAIStats?: () => ExecStats };
    // AIPlayer isn't on window directly; reach it via the running game's `ai`
    // instance constructor (static workerEnabled lives on the class).
    const ai = (window.__kcGame as unknown as { ai?: { constructor: { workerEnabled?: boolean } } })
      ?.ai;
    if (ai && ai.constructor) {
      (ai.constructor as unknown as { workerEnabled: boolean }).workerEnabled = false;
      return true;
    }
    return false;
  });
  console.log(`[attack-diag2] forced workerEnabled=false: ${disabled}`);

  await page.evaluate(() => {
    const s = window.__kcAIStats?.();
    if (s) {
      s.moveOk = 0;
      s.moveRejected = 0;
      s.attackOk = 0;
      s.attackRejected = 0;
      s.plannedAttacks = 0;
      s.plannedMoves = 0;
      s.log.length = 0;
    }
  });

  const TURNS = 10;
  for (let i = 0; i < TURNS; i += 1) {
    const winner = await page.evaluate(() => window.__kcGame?.winner ?? null);
    if (winner !== null && winner !== undefined) {
      console.log(`[attack-diag2] game ended early at turn ${i}, winner=${winner}`);
      break;
    }
    await page.evaluate(() => window.__kcGame?.forceEndTurn());
    await page.waitForFunction(
      () => window.__kcGame?.currentPlayer === 1 || (window.__kcGame?.winner ?? null) !== null,
      { timeout: 60_000 },
    );
    const mid = await page.evaluate(() => window.__kcAIStats?.());
    console.log(
      `[attack-diag2] after turn ${i}: plannedAttacks=${mid?.plannedAttacks} plannedMoves=${mid?.plannedMoves} attackOk=${mid?.attackOk}`,
    );
  }

  const stats = await page.evaluate(() => window.__kcAIStats?.());
  const s = stats as ExecStats;
  console.log(
    `[attack-diag2] FINAL plannedAttacks=${s.plannedAttacks} plannedMoves=${s.plannedMoves} attackOk=${s.attackOk} attackRejected=${s.attackRejected} moveOk=${s.moveOk}`,
  );
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
