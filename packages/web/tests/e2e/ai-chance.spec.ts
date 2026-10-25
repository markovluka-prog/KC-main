import { test, expect } from '@playwright/test';

/**
 * The "Свой шанс" AI must answer fast enough to play against: every AI turn
 * under 5 s here (headless software rendering; a real browser is faster),
 * no rejected actions, no errors.
 */
test('«Свой шанс» AI plays legal turns in a few seconds', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => { try { localStorage.setItem('kac_tutorial_v1', '1'); } catch {} });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__kcGame);
  await page.evaluate(() => (window as any).__kcGame.startMatch('ai', 'chance:100'));
  for (let t = 0; t < 4; t++) {
    const before = await page.evaluate(() => (window as any).__kcAIStats());
    const t0 = Date.now();
    await page.evaluate(() => (window as any).__kcGame.forceEndTurn());
    await page.waitForFunction(() => (window as any).__kcGame.currentPlayer === 1 || (window as any).__kcGame.winner !== null, { timeout: 150_000 });
    const after = await page.evaluate(() => (window as any).__kcAIStats());
    const label = await page.evaluate(() => (window as any).__kcGame.getGameModeLabel());
    const acts = after.moveOk + after.attackOk - before.moveOk - before.attackOk;
    const sec = (Date.now() - t0) / 1000;
    expect(sec, `AI turn ${t} took ${sec.toFixed(1)} s`).toBeLessThan(5);
    expect(after.moveRejected + after.attackRejected).toBe(before.moveRejected + before.attackRejected);
    console.log(`AI turn ${t}: ${((Date.now() - t0) / 1000).toFixed(1)} s, actions ${acts}, rejected ${after.moveRejected + after.attackRejected - before.moveRejected - before.attackRejected} | ${label}`);
  }
  expect(errors).toEqual([]);
});
