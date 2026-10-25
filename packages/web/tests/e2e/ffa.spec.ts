import { expect, test, type Page } from '@playwright/test';

/**
 * 3–4 player free-for-all (mode 'ffa'): corner 3×3 castles, clockwise turns,
 * win by holding every castle, and a captured nation defects except its top
 * 30% killers. Drives the real client through window.__kcGame.
 */
async function startFfa(page: Page, n: 3 | 4) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('kac_tutorial_v1', '1');
    } catch {
      /* private mode */
    }
  });
  await page.goto('/');
  await page.waitForFunction(() => document.getElementById('menuOverlay')?.classList.contains('active'), { timeout: 10_000 });
  await page.locator('button[data-action="show-play"]').first().click();
  await page.locator(`button[data-action="start-ffa-${n}"]`).first().click();
  await page.waitForFunction(() => !document.getElementById('menuOverlay')?.classList.contains('active'), { timeout: 5_000 });
}

test('4 players: corner castles, 6 units each, clockwise turns', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await startFfa(page, 4);
  const info = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    const per = [1, 2, 3, 4].map((p) => g.ownUnits(p).length);
    const inOwnCastle = g.board.units.every((u: any) => g.ffaCastleAt(u.row, u.col) === u.player - 1);
    const order = [g.currentPlayer];
    for (let k = 0; k < 4; k += 1) {
      g.forceEndTurn();
      order.push(g.currentPlayer);
    }
    return { per, owners: g.ffaOwners, inOwnCastle, order };
  });
  expect(info.per).toEqual([6, 6, 6, 6]);
  expect(info.owners).toEqual([1, 2, 3, 4]);
  expect(info.inOwnCastle).toBe(true);
  expect(info.order).toEqual([1, 2, 3, 4, 1]);
  await expect(page.locator('#sidebar')).toContainText(/захватите все замки/);
  expect(errors).toEqual([]);
});

test('taking a home castle: the top 30% by kills stay, the rest defect', async ({ page }) => {
  await startFfa(page, 4);
  const r = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    const p2 = g.ownUnits(2);
    p2.forEach((u: any, i: number) => {
      u.kills = [0, 5, 0, 3, 0, 0][i];
      u.row = 10 + Math.floor(i / 3); // walk everyone out of the castle
      u.col = 14 + (i % 3);
    });
    const knight = g.ownUnits(1)[0];
    knight.row = 1; // into player 2's castle (top-right)
    knight.col = 18;
    g.checkWinner();
    return {
      owner: g.ffaOwners[1],
      p1: g.ownUnits(1).length,
      p2Kills: g.ownUnits(2).map((u: any) => u.kills).sort(),
      winner: g.winner,
    };
  });
  expect(r.owner).toBe(1);
  expect(r.p2Kills).toEqual([3, 5]); // ceil(6 × 0.3) = 2 loyal: the top two killers
  expect(r.p1).toBe(10);
  expect(r.winner).toBeNull();
});

test('holding every castle wins; with 3 players the fourth starts free', async ({ page }) => {
  await startFfa(page, 3);
  const r = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    const start = g.ffaOwners.slice();
    // Clear the castles, then put one of player 1's units alone in each.
    g.board.units.forEach((u: any, i: number) => {
      u.row = 8 + (i % 4);
      u.col = 5 + Math.floor(i / 4);
    });
    const mine = g.ownUnits(1);
    [[1, 1], [1, 18], [18, 18], [18, 1]].forEach(([row, col], i) => {
      mine[i].row = row;
      mine[i].col = col;
    });
    g.checkWinner();
    return { start, winner: g.winner };
  });
  expect(r.start).toEqual([1, 2, 3, null]);
  expect(r.winner).toBe(1);
});

test('three give up: the last one plays on for the castles; all give up: a draw', async ({ page }) => {
  await startFfa(page, 4);
  const r = await page.evaluate(() => {
    const g = (window as any).__kcGame;
    for (let k = 0; k < 3; k += 1) g.surrender(); // players 1, 2, 3 in turn
    const afterThree = { winner: g.winner, current: g.currentPlayer, left: g.ownUnits(4).length };
    g.surrender(); // the last one too
    const overlay = document.getElementById('victoryOverlay')?.textContent ?? '';
    return { afterThree, winner: g.winner, overlay };
  });
  expect(r.afterThree).toEqual({ winner: null, current: 4, left: 6 });
  expect(r.winner).toBe(0);
  expect(r.overlay).toMatch(/Ничья/);
});
