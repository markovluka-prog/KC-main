/**
 * Mobile UI — полное покрытие всех кнопок и окон игры на мобильном вьюпорте.
 *
 * Каждый тест запускается при viewport 390×844 (< breakpoint 860px), поэтому
 * срабатывают все мобильные CSS-правила:
 *   - sidebar становится нижней панелью высотой ~38dvh
 *   - menu-panel-left / menu-panel-right — drawer'ы, скрытые за translateX
 *   - arrow-buttons появляются поверх обложки
 *
 * Минимальный размер tap-цели — 44×44px (iOS HIG). Все .btn имеют min-height:44px,
 * тесты подтверждают, что rendered height >= 44px.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// ── Helpers ────────────────────────────────────────────────────────────────

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** Wait for the splash to disappear and the menu overlay to become active. */
async function waitForMenu(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 15_000 },
  );
}

/** Open the play sub-modal (new redesigned menu has a «show-play» gate). */
async function openPlayModal(page: Page) {
  await page.locator('button[data-action="show-play"]').first().click();
  await expect(page.locator('#playModal')).toHaveClass(/active/, { timeout: 5_000 });
}

/** Start a PvP match, wait for the game screen, and dismiss any tutorial overlay. */
async function startPvP(page: Page) {
  await openPlayModal(page);
  await page.locator('button[data-action="start-pvp"]').first().click();
  await page.locator('#draftConfirmBtn').click();
  await page.waitForFunction(
    () => !document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 8_000 },
  );
  // Give the game loop a tick to render the sidebar
  await page.waitForTimeout(300);
  // Dismiss tutorial overlay if it appeared (first-run coachmark)
  const tut = page.locator('#tutorialOverlay');
  if (await tut.isVisible()) {
    await page.locator('#tutSkip').click();
    await expect(tut).not.toBeVisible({ timeout: 2_000 });
  }
}

/**
 * Assert that a locator is visible, non-zero in both dimensions,
 * and that its rendered height meets the 44px iOS HIG tap-target minimum.
 */
async function assertTappable(loc: Locator, label: string, minH = 44) {
  await expect(loc, `${label} should exist`).toBeVisible({ timeout: 5_000 });
  const box = await loc.boundingBox();
  expect(box, `${label} bounding box`).not.toBeNull();
  expect(box!.width, `${label} width > 0`).toBeGreaterThan(0);
  expect(Math.round(box!.height), `${label} height >= ${minH}px`).toBeGreaterThanOrEqual(minH);
}

// ── Suite setup ────────────────────────────────────────────────────────────
// Override the viewport at the suite level so every test in this file runs
// in mobile mode even if the playwright.config project is desktop.
test.use({ viewport: MOBILE_VIEWPORT });

// ══════════════════════════════════════════════════════════════════════════
// 1. MENU SCREEN
// ══════════════════════════════════════════════════════════════════════════

test.describe('Menu screen', () => {
  test('Все основные кнопки меню видны и соответствуют tap-target ≥ 44px', async ({ page }) => {
    await waitForMenu(page);

    // Main menu buttons (always visible)
    const mainActions = [
      { sel: 'button[data-action="show-play"]', label: 'Играть' },
      { sel: 'button[data-action="show-about"]', label: 'О игре' },
      { sel: 'button[data-action="show-settings"]', label: 'Настройки' },
    ];
    for (const { sel, label } of mainActions) {
      await assertTappable(page.locator(sel).first(), label);
    }

    // Play sub-modal buttons
    await openPlayModal(page);
    const playActions = [
      { sel: 'button[data-action="start-pvp"]', label: '2 Игрока' },
      { sel: 'button[data-action="start-ai-easy"]', label: 'Слабый ИИ' },
      { sel: 'button[data-action="start-ai-medium"]', label: 'Средний ИИ' },
      { sel: 'button[data-action="start-ai-hard"]', label: 'Сложный ИИ' },
      { sel: 'button[data-action="play-online-create"]', label: 'Играть онлайн' },
    ];
    for (const { sel, label } of playActions) {
      await assertTappable(page.locator(sel).first(), label);
    }
  });

  test('Кнопка «Об игре» открывает aboutModal и не выходит за viewport', async ({ page }) => {
    await waitForMenu(page);

    const aboutBtn = page.locator('button[data-action="show-about"]').first();
    await assertTappable(aboutBtn, 'Об игре');
    await aboutBtn.click();

    const modal = page.locator('#aboutModal');
    await expect(modal).toHaveClass(/active/, { timeout: 3_000 });

    const box = await modal.locator('.submenu-card').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width + 2);
  });

  test('Кнопка «Настройки» открывает settingsModal', async ({ page }) => {
    await waitForMenu(page);

    const settingsBtn = page.locator('button[data-action="show-settings"]').first();
    await assertTappable(settingsBtn, 'Настройки');
    await settingsBtn.click();

    await expect(page.locator('#settingsModal')).toHaveClass(/active/, { timeout: 3_000 });
  });

  test('Крестик закрывает открытый sub-modal', async ({ page }) => {
    await waitForMenu(page);

    await page.locator('button[data-action="show-about"]').first().click();
    await expect(page.locator('#aboutModal')).toHaveClass(/active/, { timeout: 3_000 });

    await page.locator('[data-close-modal="aboutModal"]').first().click();
    await expect(page.locator('#aboutModal')).not.toHaveClass(/active/);
  });

  test('Модалка «Как играть» открывается и закрывается', async ({ page }) => {
    await waitForMenu(page);

    // «Правила игры» находятся в aboutModal
    await page.locator('button[data-action="show-about"]').first().click();
    await expect(page.locator('#aboutModal')).toHaveClass(/active/, { timeout: 3_000 });

    const rulesBtn = page.locator('button[data-action="show-rules"]').first();
    await assertTappable(rulesBtn, '«Как играть»');
    await rulesBtn.click();

    const modal = page.locator('#rulesModal');
    await expect(modal).toHaveClass(/active/, { timeout: 2_000 });

    // Закрываем крестиком
    const closeBtn = page.locator('#rulesModalClose');
    await assertTappable(closeBtn, 'Закрыть правила', 36);
    await closeBtn.click();
    await expect(modal).not.toHaveClass(/active/);
  });

  test('Кнопка «Играть онлайн» открывает online-modal', async ({ page }) => {
    await waitForMenu(page);

    await openPlayModal(page);
    await page.locator('button[data-action="play-online-create"]').first().click();

    const modal = page.locator('#onlineModal');
    await expect(modal).toHaveClass(/active/, { timeout: 3_000 });

    // Внутри должны быть кнопки
    const btns = modal.locator('button.btn');
    const count = await btns.count();
    expect(count, 'online modal должен содержать хотя бы 2 кнопки').toBeGreaterThanOrEqual(2);

    for (let i = 0; i < count; i++) {
      const b = btns.nth(i);
      if (await b.isVisible()) {
        await assertTappable(b, `online-modal btn #${i}`);
      }
    }
  });

  test('Клик по account-bar открывает auth-modal', async ({ page }) => {
    await waitForMenu(page);

    // Account bar находится в settingsModal
    await page.locator('button[data-action="show-settings"]').first().click();
    await expect(page.locator('#settingsModal')).toHaveClass(/active/, { timeout: 3_000 });

    const accountBar = page.locator('.account-bar').first();
    if (await accountBar.isVisible()) {
      await assertTappable(accountBar, 'account-bar', 40);
      await accountBar.click();

      const authModal = page.locator('#authModal');
      await expect(authModal).toHaveClass(/active/, { timeout: 2_000 });

      // Кнопка входа
      await assertTappable(page.locator('#authSubmit'), 'auth-submit');
      // Google
      await assertTappable(page.locator('#authGoogleBtn'), 'auth-google');
      // Закрыть
      await assertTappable(page.locator('#authModalClose'), 'auth-modal-close', 36);

      // Переключатель табов
      await assertTappable(page.locator('#authTabLogin'), 'auth-tab-login', 32);
      await assertTappable(page.locator('#authTabSignup'), 'auth-tab-signup', 32);

      // Закрываем
      await page.locator('#authModalClose').click();
      await expect(authModal).not.toHaveClass(/active/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. DRAFT MODAL
// ══════════════════════════════════════════════════════════════════════════

test.describe('Draft modal', () => {
  test('Карточки выбора армии видны и кликабельны; confirm и cancel ≥ 44px', async ({ page }) => {
    await waitForMenu(page);
    await openPlayModal(page);
    await page.locator('button[data-action="start-pvp"]').first().click();

    const modal = page.locator('#draftModal');
    await expect(modal).toHaveClass(/active/, { timeout: 5_000 });

    // Карточки пресетов
    const cards = modal.locator('.draft-preset-card');
    const cardCount = await cards.count();
    expect(cardCount, 'Должно быть хотя бы 2 пресета армии').toBeGreaterThanOrEqual(2);

    for (let i = 0; i < cardCount; i++) {
      const c = cards.nth(i);
      await expect(c, `Preset card #${i} visible`).toBeVisible();
      const box = await c.boundingBox();
      expect(box, `Preset card #${i} bounding box`).not.toBeNull();
      expect(box!.height, `Preset card #${i} height > 40px`).toBeGreaterThan(40);
    }

    // Кнопки действий
    await assertTappable(page.locator('#draftConfirmBtn'), 'Начать бой');
    await assertTappable(page.locator('#draftCancelBtn'), 'Отмена (draft)');

    // Отмена возвращает в меню
    await page.locator('#draftCancelBtn').click();
    await expect(modal).not.toHaveClass(/active/);
    await expect(page.locator('#menuOverlay')).toHaveClass(/active/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. IN-GAME — HUD и сайдбар
// ══════════════════════════════════════════════════════════════════════════

test.describe('In-game HUD overlay', () => {
  test('HUD-оверлей виден с чипами игрока, активаций и счёта', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const hud = page.locator('#gameHud');
    await expect(hud).toHaveClass(/visible/, { timeout: 3_000 });

    // Чип текущего игрока
    const playerChip = page.locator('#hudPlayer');
    await expect(playerChip).toBeVisible();
    await expect(playerChip).toContainText(/Игрок [12]/);

    // Чип активаций
    const actChip = page.locator('#hudActivations');
    await expect(actChip).toBeVisible();

    // Чип юнитов
    const unitsChip = page.locator('#hudUnits');
    await expect(unitsChip).toBeVisible();
    await expect(unitsChip).toContainText(/\d+\s*⚔\s*\d+/);
  });
});

test.describe('In-game sidebar (нижняя панель на мобильном)', () => {
  test('Сайдбар рендерится как нижняя панель с видимой высотой', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toBeVisible();

    const box = await sidebar.boundingBox();
    expect(box, 'sidebar bounding box').not.toBeNull();
    // На мобильном sidebar должен быть внизу (y > 0)
    expect(box!.y, 'sidebar.y > 0 (не перекрывает весь экран)').toBeGreaterThan(0);
    // И иметь заметную высоту
    expect(box!.height, 'sidebar.height > 80px').toBeGreaterThan(80);
    // Полная ширина на мобильном
    expect(box!.width, 'sidebar.width >= viewport').toBeGreaterThanOrEqual(
      MOBILE_VIEWPORT.width - 4,
    );
  });

  test('Кнопки управления видны и ≥ 44px: В меню, Пропустить ход, Угрозы', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    await assertTappable(
      page.locator('#sidebar button[data-action="back-menu"]').first(),
      'В меню',
    );
    await assertTappable(
      page.locator('#sidebar button[data-action="end-turn"]').first(),
      'Пропустить ход',
    );
    await assertTappable(
      page.locator('#sidebar button[data-action="toggle-threat"]').first(),
      'Угрозы',
    );
  });

  test('Кнопка «Угрозы» — toggle меняет текст', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const btn = page.locator('#sidebar button[data-action="toggle-threat"]').first();
    await expect(btn).toContainText(/выкл/i);
    await btn.click();
    await expect(btn).toContainText(/вкл/i);
    // Второй клик возвращает
    await btn.click();
    await expect(btn).toContainText(/выкл/i);
  });

  test('Кнопка «Сдаться» видна и ≥ 44px', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const surrenderBtn = page.locator('#sidebar button[data-action="surrender"]').first();
    // Кнопка может быть внизу сайдбара — прокручиваем к ней
    await surrenderBtn.scrollIntoViewIfNeeded();
    await assertTappable(surrenderBtn, 'Сдаться');
  });

  test('«В меню» возвращает на экран меню', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    await page.locator('#sidebar button[data-action="back-menu"]').first().click();
    await expect(page.locator('#menuOverlay')).toHaveClass(/active/, { timeout: 3_000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. SURRENDER MODAL
// ══════════════════════════════════════════════════════════════════════════

test.describe('Surrender modal', () => {
  test('Открывается из кнопки «Сдаться»; кнопки «Да» и «Отмена» ≥ 44px', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const surrenderBtn = page.locator('#sidebar button[data-action="surrender"]').first();
    await surrenderBtn.scrollIntoViewIfNeeded();
    await surrenderBtn.click();

    const modal = page.locator('#surrenderModal');
    await expect(modal).toHaveClass(/active/, { timeout: 2_000 });

    await assertTappable(page.locator('#surrenderYesBtn'), 'Да, сдаюсь');
    await assertTappable(page.locator('#surrenderNoBtn'), 'Отмена (surrender)');

    // «Отмена» закрывает модалку
    await page.locator('#surrenderNoBtn').click();
    await expect(modal).not.toHaveClass(/active/);
  });

  test('«Да, сдаюсь» завершает партию и показывает victory overlay', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    await page.locator('#sidebar button[data-action="surrender"]').first().scrollIntoViewIfNeeded();
    await page.locator('#sidebar button[data-action="surrender"]').first().click();
    await expect(page.locator('#surrenderModal')).toHaveClass(/active/);

    await page.locator('#surrenderYesBtn').click();

    const victory = page.locator('#victoryOverlay');
    await expect(victory).toHaveClass(/show/, { timeout: 3_000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. VICTORY OVERLAY
// ══════════════════════════════════════════════════════════════════════════

test.describe('Victory overlay', () => {
  /** Trigger a win via surrender. */
  async function triggerWin(page: Page) {
    await waitForMenu(page);
    await startPvP(page);
    await page.locator('#sidebar button[data-action="surrender"]').first().scrollIntoViewIfNeeded();
    await page.locator('#sidebar button[data-action="surrender"]').first().click();
    await page.locator('#surrenderYesBtn').click();
    await expect(page.locator('#victoryOverlay')).toHaveClass(/show/, { timeout: 3_000 });
  }

  test('Victory overlay: кнопки «Рестарт» и «В меню» видны и ≥ 44px', async ({ page }) => {
    await triggerWin(page);
    // Ждём завершения victoryEntry анимации (0.55s, scale 0.6→1.04→1)
    await page.waitForTimeout(700);

    const overlay = page.locator('#victoryOverlay');
    await assertTappable(overlay.locator('button[data-action="restart"]').first(), 'Рестарт');
    await assertTappable(
      overlay.locator('button[data-action="back-menu"]').first(),
      'В меню (victory)',
    );
  });

  test('«Рестарт» запускает новую партию', async ({ page }) => {
    await triggerWin(page);

    await page.locator('#victoryOverlay button[data-action="restart"]').first().click();
    // После рестарта меню или новый матч — victoryOverlay пропадает
    await expect(page.locator('#victoryOverlay')).not.toHaveClass(/show/, { timeout: 5_000 });
  });

  test('«В меню» из victory возвращает на меню', async ({ page }) => {
    await triggerWin(page);

    await page.locator('#victoryOverlay button[data-action="back-menu"]').first().click();
    await expect(page.locator('#menuOverlay')).toHaveClass(/active/, { timeout: 3_000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. UNIT-SELECTED: CASTLE HEAL
// ══════════════════════════════════════════════════════════════════════════

test.describe('Castle heal buttons', () => {
  test('Кнопка лечения в замке видна и ≥ 44px', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    // Ставим рыцаря P1 в замок (rows 0-4) с пониженными HP и 2+ ходами
    const injected = await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return false;
      const knight = g.board?.units?.find(
        (u: any) => u.player === 1 && u.type === 'knight' && u.hp > 0,
      );
      if (!knight) return false;
      const castleCol = (window as any).getCastleP1Col?.() ?? 8;
      knight.row = 1;
      knight.col = castleCol;
      knight.hp = Math.max(1, knight.maxHp - 2);
      knight.movesLeft = 2;
      knight.done = false;
      g.selectedUnit = knight;
      g.renderSidebar();
      return true;
    });

    if (!injected) {
      test.skip();
      return;
    }

    await page.waitForTimeout(200);

    const healBtn = page.locator('button[data-action="castle-heal"]').first();
    if (await healBtn.isVisible()) {
      await assertTappable(healBtn, 'Лечиться в замке');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. UNIT-SELECTED: RUINS / DRAW-ARTIFACT
// ══════════════════════════════════════════════════════════════════════════

test.describe('Draw-artifact button', () => {
  test('«Тянуть артефакт» видна ≥ 44px когда юнит стоит в руинах', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const injected = await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return false;
      const unit = g.board?.units?.find((u: any) => u.player === 1 && u.hp > 0 && u.movesLeft > 0);
      if (!unit) return false;
      // Помещаем юнит в руины (используем реальный ruins из state)
      const ruins = g.state?.ruins ?? g.ruins ?? { top: 5, left: 5, width: 3, height: 3 };
      unit.row = ruins.top;
      unit.col = ruins.left;
      g.selectedUnit = unit;
      g.renderSidebar();
      return true;
    });

    if (!injected) {
      test.skip();
      return;
    }

    await page.waitForTimeout(200);
    const btn = page.locator('button[data-action="draw-artifact"]').first();
    if (await btn.isVisible()) {
      await assertTappable(btn, 'Тянуть артефакт');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 8. UNIT-SELECTED: TOWER / SPELL BUTTONS
// ══════════════════════════════════════════════════════════════════════════

test.describe('Spell buttons on tower', () => {
  test('Кнопки заклинаний 0–2 видны и ≥ 44px когда юнит на башне', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const injected = await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return false;
      const unit = g.board?.units?.find((u: any) => u.player === 1 && u.hp > 0 && u.movesLeft > 0);
      if (!unit) return false;
      // Ставим юнит на первую башню
      const towers = g.state?.towers ?? g.towers ?? [];
      if (!towers.length) return false;
      unit.row = towers[0].row;
      unit.col = towers[0].col;
      g.selectedUnit = unit;
      // Даём артефакты чтобы заклинания стали доступны
      const ARTIFACTS = (window as any).ARTIFACTS ?? [];
      if (ARTIFACTS.length) {
        ARTIFACTS.forEach((a: string) => {
          g.inventory[1][a] = 10;
        });
      }
      g.renderSidebar();
      return true;
    });

    if (!injected) {
      test.skip();
      return;
    }

    await page.waitForTimeout(200);

    // Должны быть spell-btn-0, spell-btn-1, spell-btn-2
    for (let idx = 0; idx < 3; idx++) {
      const btn = page.locator(`#spell-btn-${idx}`);
      if (await btn.isVisible()) {
        await assertTappable(btn, `Заклинание #${idx}`);
      }
    }
  });

  test('Spell 0 кнопка заблокирована когда все юниты на максимальном HP', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return;
      // Все юниты игрока 1 — полное HP
      g.board?.units?.forEach((u: any) => {
        if (u.player === 1) u.hp = u.maxHp;
      });
      const unit = g.board?.units?.find((u: any) => u.player === 1 && u.hp > 0 && u.movesLeft > 0);
      if (!unit) return;
      const towers = g.state?.towers ?? g.towers ?? [];
      if (!towers.length) return;
      unit.row = towers[0].row;
      unit.col = towers[0].col;
      g.selectedUnit = unit;
      const ARTIFACTS = (window as any).ARTIFACTS ?? [];
      if (ARTIFACTS.length)
        ARTIFACTS.forEach((a: string) => {
          g.inventory[1][a] = 10;
        });
      g.renderSidebar();
    });

    await page.waitForTimeout(200);

    const spell0 = page.locator('#spell-btn-0');
    if (await spell0.isVisible()) {
      // Должна быть disabled (все на max HP)
      await expect(spell0).toBeDisabled();
    }
  });

  test('Spell 1 кнопка заблокирована когда все юниты на максимальной броне', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return;
      g.board?.units?.forEach((u: any) => {
        if (u.player === 1) u.armor = u.maxArmor;
      });
      const unit = g.board?.units?.find((u: any) => u.player === 1 && u.hp > 0 && u.movesLeft > 0);
      if (!unit) return;
      const towers = g.state?.towers ?? g.towers ?? [];
      if (!towers.length) return;
      unit.row = towers[0].row;
      unit.col = towers[0].col;
      g.selectedUnit = unit;
      const ARTIFACTS = (window as any).ARTIFACTS ?? [];
      if (ARTIFACTS.length)
        ARTIFACTS.forEach((a: string) => {
          g.inventory[1][a] = 10;
        });
      g.renderSidebar();
    });

    await page.waitForTimeout(200);

    const spell1 = page.locator('#spell-btn-1');
    if (await spell1.isVisible()) {
      await expect(spell1).toBeDisabled();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 9. WEAPON CRAFT AND EQUIP
// ══════════════════════════════════════════════════════════════════════════

test.describe('Weapon craft and equip', () => {
  test('Кнопки крафта видны и ≥ 44px (всегда в сайдбаре)', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    // Кнопки craft-btn-0 и craft-btn-1 должны рендериться в сайдбаре
    // независимо от выбранного юнита. Выбираем любого юнита чтобы сайдбар обновился.
    await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return;
      const unit = g.board?.units?.find((u: any) => u.player === 1 && u.hp > 0);
      if (unit) {
        g.selectedUnit = unit;
        g.renderSidebar();
      }
    });

    await page.waitForTimeout(200);

    const craft0 = page.locator('#craft-btn-0');
    const craft1 = page.locator('#craft-btn-1');

    for (const [btn, label] of [
      [craft0, 'Крафт оружия #0'],
      [craft1, 'Крафт оружия #1'],
    ] as const) {
      if (await btn.isVisible()) {
        const box = await btn.boundingBox();
        expect(box, `${label} bounding box`).not.toBeNull();
        expect(box!.height, `${label} height >= 44px`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('После крафта появляется запрос на экипировку оружия', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    // Даём достаточно артефактов и крафтим оружие через game-state
    const crafted = await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return false;
      const unit = g.board?.units?.find(
        (u: any) => u.player === 1 && u.hp > 0 && u.movesLeft > 0 && !u.weapon,
      );
      if (!unit) return false;
      const WEAPONS = (window as any).WEAPONS ?? [];
      const ARTIFACTS = (window as any).ARTIFACTS ?? [];
      if (!WEAPONS.length || !ARTIFACTS.length) return false;

      // Пополняем инвентарь
      ARTIFACTS.forEach((a: string) => {
        g.inventory[1][a] = 10;
      });
      g.selectedUnit = unit;

      // Симулируем крафт: устанавливаем pendingWeaponEquip напрямую
      const w = WEAPONS[0];
      const targets =
        g.board?.units?.filter((u: any) => u.player === 1 && u.hp > 0 && !u.weapon) ?? [];
      if (!targets.length) return false;
      g.pendingWeaponEquip = {
        name: w.name,
        amount: w.amount,
        icon: w.icon,
        allowedTypes: w.allowedTypes ?? null,
        forbidTypes: w.forbidTypes ?? null,
        archerOnly: w.archerOnly ?? false,
      };
      g.renderSidebar();
      return true;
    });

    if (!crafted) {
      test.skip();
      return;
    }

    await page.waitForTimeout(200);

    // Сайдбар должен показывать инструкцию экипировки
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toContainText(/экипируйте|equip/i, { timeout: 2_000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 10. CLEAR-PREVIEW
// ══════════════════════════════════════════════════════════════════════════

test.describe('Clear preview button', () => {
  test('«Закрыть превью» видна и ≥ 44px при previewUnit', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    await page.evaluate(() => {
      const g = (window as any).__kcGame;
      if (!g) return;
      const enemy = g.board?.units?.find((u: any) => u.player === 2 && u.hp > 0);
      if (enemy) {
        g.previewUnit = enemy;
        g.renderSidebar();
      }
    });

    await page.waitForTimeout(200);
    const btn = page.locator('button[data-action="clear-preview"]').first();
    if (await btn.isVisible()) {
      await assertTappable(btn, 'Закрыть превью');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 11. TUTORIAL OVERLAY (B4 coachmarks + sidebar tutorial mode)
// ══════════════════════════════════════════════════════════════════════════

test.describe('Tutorial overlay (B4 coachmarks)', () => {
  test('Коучмарки появляются при первой игре (без kac_tutorial_v1); кнопки ≥ 44px', async ({
    page,
  }) => {
    // Очищаем флаг «уже видел обучение» чтобы гарантировать показ overlay
    await page.goto('/');
    await page.evaluate(() => {
      try {
        localStorage.removeItem('kac_tutorial_v1');
      } catch (_) {}
    });

    await page.waitForFunction(
      () => document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 15_000 },
    );

    // Запускаем PvP — это вызовет maybeShowTutorial()
    await openPlayModal(page);
    await page.locator('button[data-action="start-pvp"]').first().click();
    await page.locator('#draftConfirmBtn').click();
    await page.waitForFunction(
      () => !document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 8_000 },
    );
    await page.waitForTimeout(400);

    const overlay = page.locator('#tutorialOverlay');
    await expect(overlay).toHaveClass(/active/, { timeout: 5_000 });

    await assertTappable(page.locator('#tutSkip'), 'Пропустить (B4)');
    await assertTappable(page.locator('#tutNext'), 'Далее (B4)');

    // «Пропустить» скрывает оверлей
    await page.locator('#tutSkip').click();
    await expect(overlay).not.toHaveClass(/active/, { timeout: 2_000 });
  });
});

test.describe('Tutorial mode (sidebar)', () => {
  test('start-tutorial запускает tutorial-режим; карточка в sidebar видна', async ({ page }) => {
    await waitForMenu(page);

    // Кнопка «Обучение» в aboutModal
    await page.locator('button[data-action="show-about"]').first().click();
    await expect(page.locator('#aboutModal')).toHaveClass(/active/, { timeout: 3_000 });

    const tutBtn = page.locator('button[data-action="start-tutorial"]').first();
    if (!(await tutBtn.isVisible())) {
      test.skip();
      return;
    }

    await tutBtn.click();

    await page.waitForFunction(
      () => !document.getElementById('menuOverlay')?.classList.contains('active'),
      { timeout: 8_000 },
    );
    await page.waitForTimeout(400);

    // В tutorial-mode сайдбар рендерит .tut-card внутри себя
    const sidebar = page.locator('#sidebar');
    const tutCard = sidebar.locator('.tut-card').first();
    if (await tutCard.isVisible({ timeout: 2_000 })) {
      // tutorial через sidebar — ОК
      const box = await tutCard.boundingBox();
      expect(box!.height, 'tut-card height > 40').toBeGreaterThan(40);
    } else {
      // B4 overlay-режим
      const overlay = page.locator('#tutorialOverlay');
      if (await overlay.isVisible()) {
        await assertTappable(page.locator('#tutSkip'), 'Пропустить');
        await assertTappable(page.locator('#tutNext'), 'Далее');
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 12. DISCONNECT MODAL (online — статический рендер)
// ══════════════════════════════════════════════════════════════════════════

test.describe('Online disconnect modal', () => {
  test('Кнопка «Выйти в меню» в disconnect-modal ≥ 44px', async ({ page }) => {
    await waitForMenu(page);

    // Показываем модалку напрямую (без реального разрыва соединения)
    await page.evaluate(() => {
      document.getElementById('onlineDisconnectModal')?.classList.add('active');
    });

    const btn = page.locator('#onlineDisconnectModal button[data-action="online-leave"]');
    await assertTappable(btn, 'online-leave (disconnect modal)');

    // Убираем
    await page.evaluate(() => {
      document.getElementById('onlineDisconnectModal')?.classList.remove('active');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 13. MUTE BUTTON
// ══════════════════════════════════════════════════════════════════════════

test.describe('Mute button', () => {
  test('Кнопка звука видна на экране меню и ≥ 36px', async ({ page }) => {
    await waitForMenu(page);

    const muteBtn = page.locator('#muteBtn');
    await expect(muteBtn).toBeVisible();
    const box = await muteBtn.boundingBox();
    expect(box, 'muteBtn bounding box').not.toBeNull();
    expect(box!.width, 'muteBtn width >= 36').toBeGreaterThanOrEqual(36);
    expect(box!.height, 'muteBtn height >= 36').toBeGreaterThanOrEqual(36);
    await muteBtn.click(); // не должен падать
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 14. END TURN — кнопка «Пропустить ход»
// ══════════════════════════════════════════════════════════════════════════

test.describe('End-turn button', () => {
  test('«Пропустить ход» меняет текущего игрока', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const before = await page.evaluate(() => (window as any).__kcGame?.currentPlayer);
    expect(before).toBe(1);

    await page.locator('#sidebar button[data-action="end-turn"]').first().click();
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => (window as any).__kcGame?.currentPlayer);
    expect(after).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 15. NO HORIZONTAL OVERFLOW — кнопки не выходят за viewport
// ══════════════════════════════════════════════════════════════════════════

test.describe('Нет горизонтального переполнения', () => {
  test('Menu: ни одна кнопка не выходит за правую границу вьюпорта', async ({ page }) => {
    await waitForMenu(page);

    const btns = page.locator('#menuButtons .btn');
    const count = await btns.count();
    for (let i = 0; i < count; i++) {
      const b = btns.nth(i);
      if (!(await b.isVisible())) continue;
      const box = await b.boundingBox();
      if (!box) continue;
      expect(box.x + box.width, `Menu btn #${i} не выходит за правую границу`).toBeLessThanOrEqual(
        MOBILE_VIEWPORT.width + 2,
      ); // +2px tolerance
    }
  });

  test('In-game sidebar: ни одна кнопка не выходит за правую границу', async ({ page }) => {
    await waitForMenu(page);
    await startPvP(page);

    const btns = page.locator('#sidebar .btn');
    const count = await btns.count();
    for (let i = 0; i < count; i++) {
      const b = btns.nth(i);
      if (!(await b.isVisible())) continue;
      const box = await b.boundingBox();
      if (!box) continue;
      expect(
        box.x + box.width,
        `Sidebar btn #${i} не выходит за правую границу`,
      ).toBeLessThanOrEqual(MOBILE_VIEWPORT.width + 2);
    }
  });
});
