import { expect, test } from '@playwright/test';

/**
 * Every AI difficulty, in a crowded mid-board fight (so attacks, pierce lines,
 * wards and kills actually happen), must play only actions the real game
 * accepts and must never leave the board in an impossible state. The opening
 * position alone never brings units into contact, so the older
 * ai-illegal-moves spec only ever exercised moves.
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

for (const difficulty of ['easy', 'medium', 'hard', 'impossible']) {
  test(`AI "${difficulty}" plays only legal actions in a melee`, async ({ page }) => {
    // "impossible" deliberately thinks ~90 s per turn (60× budget, see
    // ai-config.ts) — give it fewer turns and room to finish them.
    const turns = difficulty === 'impossible' ? 2 : 4;
    test.setTimeout(difficulty === 'impossible' ? 480_000 : 300_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && /AI turn step failed/.test(m.text())) errors.push(m.text());
    });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('kac_tutorial_v1', '1');
      } catch {
        /* ignore */
      }
    });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as unknown as { __kcGame?: unknown }).__kcGame);
    const before = await page.evaluate(async ({ roster, difficulty }) => {
      const h = await import('/tests/e2e/client-engine-diff.harness.ts');
      const w = window as unknown as { __kcGame: any; __kcAIStats: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      w.__kcGame.startMatch('ai', difficulty, null, roster);
      h.setupBrawl(w.__kcGame, 3);
      return w.__kcAIStats();
    }, { roster: ROSTER, difficulty });

    const violations: string[] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      const over = await page.evaluate(() => (window as unknown as { __kcGame: { winner: number | null } }).__kcGame.winner !== null);
      if (over) break;
      await page.evaluate(() => (window as unknown as { __kcGame: { forceEndTurn(): void } }).__kcGame.forceEndTurn());
      await page.waitForFunction(
        () => {
          const g = (window as unknown as { __kcGame: { currentPlayer: number; winner: number | null } }).__kcGame;
          return g.currentPlayer === 1 || g.winner !== null;
        },
        { timeout: 200_000 },
      );
      const v = await page.evaluate(async () => {
        const h = await import('/tests/e2e/client-engine-diff.harness.ts');
        return h.invariantViolations((window as unknown as { __kcGame: unknown }).__kcGame);
      });
      violations.push(...v.map((x: string) => `after AI turn ${turn}: ${x}`));
    }
    const after = await page.evaluate(() => (window as unknown as { __kcAIStats: () => any }).__kcAIStats()); // eslint-disable-line @typescript-eslint/no-explicit-any
    const d = (k: string) => after[k] - before[k];
    console.log(
      `[ai-all:${difficulty}] moveOk=${d('moveOk')} moveRejected=${d('moveRejected')} attackOk=${d('attackOk')} attackRejected=${d('attackRejected')}`,
    );
    const newLog = after.log.slice(before.log.length);
    if (newLog.length) console.log(`[ai-all:${difficulty}] rejected:\n` + newLog.join('\n'));
    expect(errors).toEqual([]);
    expect(violations).toEqual([]);
    expect(d('moveRejected') + d('attackRejected'), newLog.join('\n')).toBe(0);
    expect(d('moveOk') + d('attackOk'), 'the AI should have acted').toBeGreaterThan(0);
    // Weaker presets may legitimately hold back; the strong ones must fight.
    if (difficulty === 'hard' || difficulty === 'impossible') {
      expect(d('attackOk'), 'the AI should have attacked in a melee').toBeGreaterThan(0);
    }
  });
}
