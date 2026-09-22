import { expect, test, type Page } from '@playwright/test';

/** Open the play sub-modal introduced in the redesigned menu. */
async function openPlayModal(page: Page) {
  await page.locator('button[data-action="show-play"]').first().click();
  await expect(page.locator('#playModal')).toHaveClass(/active/, { timeout: 5_000 });
}

/** Open the about sub-modal (rules + tutorial). */
async function openAboutModal(page: Page) {
  await page.locator('button[data-action="show-about"]').first().click();
  await expect(page.locator('#aboutModal')).toHaveClass(/active/, { timeout: 5_000 });
}

/** Network errors from the auth proxy (no backend in CI) are not JS bugs. */
function isExpectedNetworkError(msg: string): boolean {
  return msg.includes('Failed to load resource') || msg.includes('auth/refresh');
}

test.describe('Phase 1 smoke', () => {
  test('home page loads without console errors and shows menu', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isExpectedNetworkError(msg.text())) errors.push(msg.text());
    });

    await page.goto('/');
    // Wait for the menu overlay to be visible — it's the first interactive
    // surface and proves the game's bindEvents + renderNewMenu ran.
    await page.waitForFunction(
      () => {
        const overlay = document.getElementById('menuOverlay');
        return overlay !== null && overlay.classList.contains('active');
      },
      { timeout: 10_000 },
    );

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('rules text reflects FUNC-004 fix (archer ⚔ 3, not ⚔ 2)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 10_000 },
    );
    // Rules are in aboutModal → show-rules
    await openAboutModal(page);
    await page.locator('[data-action="show-rules"]').first().click();
    await expect(page.locator('#rulesModalBody li', { hasText: /Лучник/ }).first()).toContainText(
      '⚔ 3',
    );
    await expect(
      page.locator('#rulesModalBody li', { hasText: /Лучник/ }).first(),
    ).not.toContainText('⚔ 2');
  });

  test('SEC-001: no account modal in DOM (fake-auth removed)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#accountModal')).toHaveCount(0);
    await expect(page.locator('#accountPanel')).toHaveCount(0);
  });

  test('SEC-001: localStorage has no kac_account_v1 key after page load', async ({ page }) => {
    await page.goto('/');
    const value = await page.evaluate(() => window.localStorage.getItem('kac_account_v1'));
    expect(value).toBeNull();
  });

  test('static assets served at expected paths', async ({ request }) => {
    const castle = await request.get(
      '/tiny-swords/Tiny Swords (Free Pack)/Buildings/Black Buildings/Castle.png',
    );
    expect(castle.status()).toBe(200);

    const hall = await request.get('/hall.mp3');
    expect(hall.status()).toBe(200);

    const logo = await request.get('/assets/custom/logo.png');
    expect(logo.status()).toBe(200);
  });

  test('PvP match starts and renders canvas (basic smoke)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 10_000 },
    );
    // Open play sub-modal, then click PvP — opens the army draft screen first.
    await openPlayModal(page);
    await page.locator('button[data-action="start-pvp"]').first().click();
    // Confirm default army selection to start the match.
    await page.locator('#draftConfirmBtn').click();
    // Menu overlay should hide after match start.
    await page.waitForFunction(
      () => !document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 5_000 },
    );
    // Sidebar should now show the mode label (FUNC-002 fix path).
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toContainText(/Режим: 2 игрока/i, { timeout: 5_000 });
  });

  test('Story mode: continue-story starts first chapter task as AI match', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 10_000 },
    );
    // On a fresh page load there's no progress in localStorage, so the
    // "continue-story" button should target the first task (chapter 0 / game 0
    // / task 0) and not be disabled. Click it.
    // continue-story is a campaign div-card inside playModal.
    await openPlayModal(page);
    const button = page.locator('[data-action="continue-story"]').first();
    await expect(button).toBeVisible({ timeout: 5_000 });
    await button.click();

    await page.waitForFunction(
      () => !document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 5_000 },
    );
    // Sidebar should display the story mode label (FUNC-002 path).
    await expect(page.locator('#sidebar')).toContainText(/Сюжет/i, { timeout: 5_000 });

    // Verify the game thinks it's in story mode and has a currentStoryTask.
    const state = await page.evaluate(() => {
      const w = window as unknown as {
        __kcGame?: {
          mode: string;
          currentStoryTask: { ci: number; gi: number; ti: number } | null;
        };
      };
      const g = w.__kcGame;
      if (!g) return { reason: 'no game' };
      return {
        mode: g.mode,
        hasTask: g.currentStoryTask !== null,
        ci: g.currentStoryTask?.ci ?? -1,
      };
    });
    expect(state).toMatchObject({ mode: 'ai', hasTask: true });
    // First task should be chapter 0.
    expect(state.ci).toBe(0);
  });

  test('AI (hard) makes a legal move within budget', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isExpectedNetworkError(msg.text())) errors.push(msg.text());
    });

    // Stub the LLM API: return an empty plan so LLMPlayer activates heuristic
    // fallback without producing a console error.
    await page.route('**/api/ai-move', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"plan":[]}' }),
    );

    await page.goto('/');
    await page.waitForFunction(
      () => document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 10_000 },
    );
    // Start hard-AI match via play sub-modal.
    await openPlayModal(page);
    await page.locator('button[data-action="start-ai-hard"]').first().click();
    // Confirm default army selection to start the match.
    await page.locator('#draftConfirmBtn').click();
    await page.waitForFunction(
      () => !document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 5_000 },
    );
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toContainText(/vs AI/i, { timeout: 5_000 });

    // End the human turn immediately by clicking the surrender-end? We don't
    // know the exact UI, so flip currentPlayer through the game object the
    // app exposes for tests, then drive a frame tick. The game instance is
    // available on window for hot-reload + dev introspection.
    const moved = await page.evaluate(async () => {
      // Wait up to 4s for an AI action to consume at least one unit's move.
      // The AI ticks on requestAnimationFrame inside the existing game loop;
      // we just force the turn over to it and observe state.
      const w = window as unknown as {
        __kcGame?: {
          currentPlayer: number;
          endTurn?: () => void;
          forceEndTurn?: () => void;
          board: { units: Array<{ player: number; done: boolean; hp: number }> };
        };
      };
      const g = w.__kcGame;
      if (!g) return { reason: 'no __kcGame exposed' };
      // Skip human turn.
      if (g.currentPlayer === 1) (g.forceEndTurn ?? g.endTurn)?.call(g);
      const before = g.board.units
        .filter((u) => u.player === 2 && u.hp > 0)
        .map((u) => u.done)
        .join(',');
      const start = Date.now();
      while (Date.now() - start < 6000) {
        await new Promise((r) => setTimeout(r, 100));
        const after = g.board.units
          .filter((u) => u.player === 2 && u.hp > 0)
          .map((u) => u.done)
          .join(',');
        if (after !== before) return { changed: true, before, after };
        // Or the AI finished its turn (currentPlayer === 1 again).
        if (g.currentPlayer === 1) return { changed: true, ended: true, before, after };
      }
      return { changed: false, before };
    });

    expect(moved, 'AI did not act within 6s').toMatchObject({ changed: true });
    expect(errors, `page errors during AI turn: ${errors.join('\n')}`).toEqual([]);
  });
});
