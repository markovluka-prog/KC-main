import { test, expect, type Page } from '@playwright/test';

async function openPlayModal(page: Page) {
  await page.locator('button[data-action="show-play"]').first().click();
  await expect(page.locator('#playModal')).toHaveClass(/active/, { timeout: 5_000 });
}

test('unit click selection works', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 10_000 },
  );
  await openPlayModal(page);
  await page.locator('button[data-action="start-pvp"]').first().click();
  await page.locator('#draftConfirmBtn').click();
  await page.waitForFunction(
    () => !document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 5_000 },
  );
  await page.waitForTimeout(600);

  // Get runtime board parameters from the game
  const state = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    const canvas = g?.canvas as HTMLCanvasElement;
    const rect = canvas?.getBoundingClientRect();
    // Derive WIDTH and HEIGHT from COLS/ROWS*CELL_SIZE — use boardOffsetX to confirm
    // boardOffsetX = round((WIDTH - WIDTH*boardScale)/2) => WIDTH = boardOffsetX*2 / (1-boardScale)
    // Actually: simply compute from COLS*CELL_SIZE constants via boardScale calculation
    // boardScale = (HEIGHT - FIELD_Y_OFFSET) / HEIGHT, FIELD_Y_OFFSET = round(CELL_SIZE*0.75) = 23
    // With COLS=40, ROWS=20, CELL_SIZE=30: WIDTH=1200, HEIGHT=600
    const COLS = (window as any).COLS ?? 20;
    const ROWS = (window as any).ROWS ?? 20;
    const CELL_SIZE = 30;
    const WIDTH = COLS * CELL_SIZE;
    const HEIGHT = ROWS * CELL_SIZE;
    const u = g?.board?.units?.find((u: any) => u.player === 1 && u.alive?.());
    return {
      WIDTH,
      HEIGHT,
      boardOffsetX: g?.boardOffsetX,
      boardOffsetY: g?.boardOffsetY,
      boardScale: g?.boardScale,
      rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
      unit: u ? { id: u.id, row: u.row, col: u.col, player: u.player } : null,
    };
  });
  console.log('State:', JSON.stringify(state, null, 2));

  const u = state.unit;
  const rect = state.rect;
  if (!u || !rect) throw new Error('no unit or rect');

  const { boardOffsetX, boardOffsetY, boardScale, WIDTH, HEIGHT } = state;
  const CELL_SIZE = 30;

  // Logical canvas position of unit center
  const logX = u.col * CELL_SIZE * boardScale + boardOffsetX + CELL_SIZE * boardScale * 0.5;
  const logY = u.row * CELL_SIZE * boardScale + boardOffsetY + CELL_SIZE * boardScale * 0.5;

  // CSS pixels from canvas top-left = logX * (rect.w / WIDTH)
  const cssX = (logX * rect.w) / WIDTH;
  const cssY = (logY * rect.h) / HEIGHT;

  console.log(
    `Unit at row=${u.row}, col=${u.col}: logX=${logX.toFixed(1)}, cssX=${cssX.toFixed(1)}`,
  );

  const bbox = await page.locator('canvas').boundingBox();
  if (!bbox) throw new Error('no bbox');

  await page.mouse.click(bbox.x + cssX, bbox.y + cssY);
  await page.waitForTimeout(300);

  const selected = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    return g?.selectedUnit
      ? { id: g.selectedUnit.id, row: g.selectedUnit.row, col: g.selectedUnit.col }
      : null;
  });
  console.log('Selected:', selected);
  expect(selected).not.toBeNull();
  expect(selected?.row).toBe(u.row);
  expect(selected?.col).toBe(u.col);

  await page.screenshot({ path: '/tmp/unit_selected.png' });
});
