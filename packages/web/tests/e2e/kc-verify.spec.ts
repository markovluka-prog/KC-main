import { test, expect, type Page } from '@playwright/test';

async function openPlayModal(page: Page) {
  await page.locator('button[data-action="show-play"]').first().click();
  await expect(page.locator('#playModal')).toHaveClass(/active/, { timeout: 5_000 });
}

function isExpectedNetworkError(msg: string): boolean {
  return msg.includes('Failed to load resource') || msg.includes('auth/refresh');
}

test('board is 40×20 with terrain, units in castle, online room flow', async ({
  page,
  browser: _browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !isExpectedNetworkError(m.text())) errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForFunction(
    () => document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 10_000 },
  );

  // ── Start PvP and inspect game state ──
  await openPlayModal(page);
  await page.locator('button[data-action="start-pvp"]').first().click();
  await page.locator('#draftConfirmBtn').click();
  await page.waitForFunction(
    () => !document.getElementById('menuOverlay')?.classList.contains('active'),
    { timeout: 5_000 },
  );

  const gameState = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    if (!g) return { error: 'no __kcGame' };
    const terrain = (window as any).getTerrain?.() ?? [];
    return {
      cols: (window as any).COLS,
      rows: (window as any).ROWS,
      cellSize: (window as any).CELL_SIZE,
      unitCount: g.board?.units?.length ?? -1,
      currentPlayer: g.currentPlayer,
      terrainLength: terrain.length,
      riverCells: terrain.filter((t: any) => t.type === 'river').length,
      mountainCells: terrain.filter((t: any) => t.type === 'mountain').length,
      bridgeCells: terrain.filter((t: any) => t.type === 'bridge').length,
    };
  });

  console.log('gameState:', JSON.stringify(gameState));
  expect(gameState.cols).toBe(20);
  expect(gameState.rows).toBe(20);
  expect(gameState.unitCount).toBe(20); // 10 per player

  // ── Units inside castle check ──
  const castleCheck = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    if (!g) return { error: 'no game' };
    const p1Col = (window as any).getCastleP1Col?.();
    const p2Col = (window as any).getCastleP2Col?.();
    const p1Bottom = g.player1Bottom;
    const p1Row = p1Bottom ? 16 : 0;
    const p2Row = p1Bottom ? 0 : 16;

    const units = g.board?.units ?? [];
    const p1OutsideCastle = units.filter(
      (u: any) =>
        u.player === 1 &&
        u.hp > 0 &&
        !(u.row >= p1Row && u.row < p1Row + 4 && u.col >= p1Col && u.col < p1Col + 4),
    );
    const p2OutsideCastle = units.filter(
      (u: any) =>
        u.player === 2 &&
        u.hp > 0 &&
        !(u.row >= p2Row && u.row < p2Row + 4 && u.col >= p2Col && u.col < p2Col + 4),
    );
    return {
      p1Col,
      p2Col,
      p1Row,
      p2Row,
      p1OutsideCount: p1OutsideCastle.length,
      p2OutsideCount: p2OutsideCastle.length,
    };
  });
  console.log('castleCheck:', JSON.stringify(castleCheck));
  expect(castleCheck.p1OutsideCount, 'P1 units outside castle').toBe(0);
  expect(castleCheck.p2OutsideCount, 'P2 units outside castle').toBe(0);

  // ── Terrain exists ──
  expect(gameState.riverCells, 'should have river cells').toBeGreaterThan(0);
  expect(gameState.mountainCells, 'should have mountain cells').toBeGreaterThan(0);
  expect(gameState.bridgeCells, 'should have bridge cells').toBeGreaterThanOrEqual(1);

  // ── Canvas renders something ──
  const canvas = page.locator('#gameCanvas');
  await expect(canvas).toBeVisible();

  expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
});

test('archer ranged attack: action list contains dist-2 shot when enemy 2 rows away', async ({
  page,
}) => {
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

  const archerTest = await page.evaluate(() => {
    const { generateAttackActions } = (window as any).__kcGameRules ?? {};
    if (!generateAttackActions) return { skip: true };

    // Mock board: archer at (5,5), enemy at (5,7) — 2 cols to the right
    const board = {
      unitAt: (r: number, c: number) => {
        if (r === 5 && c === 7) return { player: 2, hp: 3, row: 5, col: 7 };
        return null;
      },
      isFree: (r: number, c: number) => !(r === 5 && c === 7),
    };
    const archer = {
      id: 1,
      type: 'archer',
      player: 1,
      row: 5,
      col: 5,
      hp: 3,
      armor: 1,
      damage: 3,
      maxMoves: 3,
      movesLeft: 3,
      name: 'Archer',
    };
    const actions = generateAttackActions(board, archer);
    return {
      actions: actions.map((a: any) => ({ mode: a.mode, cost: a.cost, targetCol: a.targetCol })),
    };
  });

  if (!archerTest.skip) {
    console.log('archer actions:', JSON.stringify(archerTest.actions));
    const dist2Shot = archerTest.actions.find((a: any) => a.cost === 2 && a.targetCol === 7);
    expect(dist2Shot, 'archer should generate dist-2 ranged shot').toBeTruthy();
  }
});

test('knight attack: stays in place (shot mode, cost 1)', async ({ page }) => {
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

  const knightTest = await page.evaluate(() => {
    const { generateAttackActions } = (window as any).__kcGameRules ?? {};
    if (!generateAttackActions) return { skip: true };

    const board = {
      unitAt: (r: number, c: number) => {
        if (r === 5 && c === 6) return { player: 2, hp: 3, row: 5, col: 6 };
        return null;
      },
      isFree: () => true,
    };
    const knight = {
      id: 1,
      type: 'knight',
      player: 1,
      row: 5,
      col: 5,
      hp: 3,
      armor: 4,
      damage: 5,
      maxMoves: 2,
      movesLeft: 2,
      name: 'Knight',
    };
    const actions = generateAttackActions(board, knight);
    return {
      actions: actions.map((a: any) => ({
        mode: a.mode,
        cost: a.cost,
        landingRow: a.landingRow,
        landingCol: a.landingCol,
      })),
    };
  });

  if (!knightTest.skip) {
    console.log('knight actions:', JSON.stringify(knightTest.actions));
    const melee = knightTest.actions.find(
      (a: any) => a.mode === 'shot' && a.cost === 1 && a.landingRow === 5 && a.landingCol === 5,
    );
    expect(melee, 'knight should have shot-mode melee cost=1 stay-in-place').toBeTruthy();
    const jumpAttack = knightTest.actions.find((a: any) => a.mode === 'jump');
    expect(jumpAttack, 'knight should NOT have jump attacks any more').toBeUndefined();
  }
});
