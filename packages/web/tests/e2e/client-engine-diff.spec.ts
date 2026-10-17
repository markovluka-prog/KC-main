import { expect, test } from '@playwright/test';

/**
 * Differential test: the real offline client (main.ts) vs the pure reducer
 * (applyAction, used by the AI search and the online server). Random legal
 * actions of every kind are played on the live client through its own
 * methods and on the engine from the same snapshot; any divergence in units,
 * terrain, loot, wards, constructions or turn state fails the test. See
 * client-engine-diff.harness.ts.
 */
const ROSTER = [
  { type: 'knight', row: 0, col: 0 },
  { type: 'cavalry', row: 0, col: 1 },
  { type: 'archer', row: 0, col: 2 },
  { type: 'catapult', row: 0, col: 3 },
  { type: 'crossbow', row: 1, col: 0 },
  { type: 'samurai', row: 1, col: 1 },
  { type: 'mage', row: 1, col: 2 },
  { type: 'knight', row: 1, col: 3 },
  { type: 'cavalry', row: 2, col: 0 },
];

test('client and engine agree on every action kind', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('kac_tutorial_v1', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __kcGame?: unknown }).__kcGame);

  const report = await page.evaluate(async (roster) => {
    const h = await import('/tests/e2e/client-engine-diff.harness.ts');
    const g = (window as unknown as { __kcGame: any }).__kcGame;  
    const total = { steps: 0, kinds: {} as Record<string, number>, failures: [] as string[] };
    for (let seed = 1; seed <= 12 && total.failures.length === 0; seed += 1) {
      g.startMatch('pvp', null, null, roster);
      h.setupBrawl(g, seed);
      const r = h.runDiff(g, seed, 120);
      total.steps += r.steps;
      for (const [k, n] of Object.entries(r.kinds)) total.kinds[k] = (total.kinds[k] ?? 0) + n;
      total.failures.push(...r.failures.map((f: string) => `seed ${seed}: ${f}`));
    }
    return total;
  }, ROSTER);

  // Same sweep in a vs-AI match: the board is physically flipped (player 1 at
  // the bottom), so every rule that depends on orientation is exercised too.
  const flipped = await page.evaluate(async (roster) => {
    const h = await import('/tests/e2e/client-engine-diff.harness.ts');
    const g = (window as unknown as { __kcGame: any }).__kcGame; // eslint-disable-line @typescript-eslint/no-explicit-any
    const total = { steps: 0, failures: [] as string[], flipped: false };
    for (let seed = 1; seed <= 8 && total.failures.length === 0; seed += 1) {
      g.startMatch('ai', 'easy', null, roster);
      total.flipped = g.player1Bottom === true;
      g.ai.update = () => {}; // the harness plays both sides
      h.setupBrawl(g, seed);
      const r = h.runDiff(g, seed, 120);
      total.steps += r.steps;
      total.failures.push(...r.failures.map((f: string) => `ai seed ${seed}: ${f}`));
    }
    return total;
  }, ROSTER);
  console.log('[client-engine-diff:ai]', flipped.steps, 'steps, flipped =', flipped.flipped);
  expect(flipped.flipped).toBe(true);
  expect(flipped.failures, flipped.failures.join('\n')).toEqual([]);
  expect(flipped.steps).toBeGreaterThan(200);

  console.log('[client-engine-diff]', report.steps, 'steps', JSON.stringify(report.kinds));
  expect(report.failures, report.failures.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
  expect(report.steps).toBeGreaterThan(300);
  for (const k of ['move', 'attack:shot', 'attack:pierce', 'mage-attack', 'mage-ward', 'build-tower', 'throw-rock']) {
    expect(report.kinds[k] ?? 0, `never exercised ${k}`).toBeGreaterThan(0);
  }
});
