import { expect, test } from '@playwright/test';

/**
 * Verifies the AI search really runs off the main thread.
 *
 * Unit tests cannot cover this: under Node there is no `Worker`, so every test
 * run takes the in-thread fallback. The properties that matter here — the worker
 * module loads, the protocol round-trips, and the main thread stays responsive
 * while the bot thinks — only exist in a browser.
 */
test.describe('AI search worker', () => {
  test('worker module loads and returns a plan for a real position', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');

    // Drive the worker directly through its client, using the same protocol the
    // game uses. This isolates the worker from the UI flow.
    const result = await page.evaluate(async () => {
      const { AISearchWorker, isSupported, captureLayout } = await import(
        '/src/game/ai-worker-client.ts'
      );
      const { AI_DIFFICULTY } = await import('/src/game/ai-config.ts');
      if (!isSupported()) return { supported: false as const };

      const worker = new AISearchWorker();
      const mk = (
        id: number,
        player: 1 | 2,
        type: string,
        row: number,
        col: number,
        hp: number,
      ) => ({
        id,
        player,
        type,
        row,
        col,
        hp,
        armor: 1,
        damage: 3,
        maxMoves: 2,
        movesLeft: 2,
        done: false,
        maxHp: hp,
        maxArmor: 1,
      });
      // A free lethal capture: the search must return a plan that takes it.
      const state = {
        units: [
          mk(1, 1, 'knight', 10, 10, 6),
          mk(2, 2, 'knight', 10, 11, 1),
          mk(3, 2, 'knight', 2, 2, 5),
        ],
        shieldTurns: { 1: 0, 2: 0 },
        damageBuff: { 1: 0, 2: 0 },
      };

      const progressValues: number[] = [];
      const started = performance.now();
      const outcome = await worker.search({
        player: 1,
        player1Bottom: true,
        config: {
          ...AI_DIFFICULTY.hard,
          intelligence: 1,
          mctsTimeBudgetMs: 400,
          mctsRolloutDepth: 4,
          mctsBreadth: 8,
          mctsSelectionTemp: 0,
        },
        state,
        onProgress: (p) => progressValues.push(p),
      });
      const elapsed = performance.now() - started;
      worker.dispose();

      return {
        supported: true as const,
        planLength: outcome.plan.length,
        // The bot should attack the 1 hp knight rather than shuffle.
        attacks: outcome.plan.filter((e) => e.action.type === 'attack').length,
        iterations: outcome.stats?.iterations ?? 0,
        progressCount: progressValues.length,
        layoutCaptured: typeof captureLayout().castleP1Col === 'number',
        elapsed,
      };
    });

    expect(result.supported).toBe(true);
    if (!result.supported) return;

    expect(result.planLength).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.attacks).toBeGreaterThan(0); // found the capture
    expect(result.progressCount).toBeGreaterThan(0); // progress was reported
    expect(result.layoutCaptured).toBe(true);
    expect(errors).toEqual([]);
  });

  test('main thread keeps running while the worker searches', async ({ page }) => {
    await page.goto('/');

    // Count animation frames during a long search. If the search were on the
    // main thread, a multi-second budget would starve rAF almost completely.
    const frames = await page.evaluate(async () => {
      const { AISearchWorker, isSupported } = await import('/src/game/ai-worker-client.ts');
      const { AI_DIFFICULTY } = await import('/src/game/ai-config.ts');
      if (!isSupported()) return -1;

      let count = 0;
      let running = true;
      const tick = (): void => {
        if (!running) return;
        count += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      const worker = new AISearchWorker();
      await worker.search({
        player: 1,
        player1Bottom: true,
        config: {
          ...AI_DIFFICULTY.hard,
          intelligence: 1,
          mctsTimeBudgetMs: 1500,
          mctsRolloutDepth: 6,
          mctsBreadth: 12,
          mctsSelectionTemp: 0,
        },
        state: {
          units: [
            { id: 1, player: 1, type: 'knight', row: 14, col: 8, hp: 5, armor: 1, damage: 3, maxMoves: 2, movesLeft: 2, done: false, maxHp: 5, maxArmor: 1 },
            { id: 2, player: 1, type: 'archer', row: 15, col: 9, hp: 3, armor: 1, damage: 3, maxMoves: 2, movesLeft: 2, done: false, maxHp: 3, maxArmor: 1 },
            { id: 3, player: 2, type: 'knight', row: 5, col: 8, hp: 5, armor: 1, damage: 3, maxMoves: 2, movesLeft: 2, done: false, maxHp: 5, maxArmor: 1 },
            { id: 4, player: 2, type: 'archer', row: 4, col: 9, hp: 3, armor: 1, damage: 3, maxMoves: 2, movesLeft: 2, done: false, maxHp: 3, maxArmor: 1 },
          ],
          shieldTurns: { 1: 0, 2: 0 },
          damageBuff: { 1: 0, 2: 0 },
        },
      });
      running = false;
      worker.dispose();
      return count;
    });

    expect(frames).toBeGreaterThan(0);
    // ~1.5 s of search at 60 fps is ~90 frames. A generous floor still fails
    // decisively if the search ever moves back onto the main thread.
    expect(frames).toBeGreaterThan(30);
  });
});
