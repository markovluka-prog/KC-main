import { describe, it, expect } from 'vitest';
import { AI_DIFFICULTY } from '../ai-config.js';
import { makeSearcher, makeState, makeUnit, type Player } from './mcts-harness.js';

/**
 * The MCTS action generator used to emit only move/attack/skip. Ruins-searching
 * ("draw"), spells and crafting existed solely in the real-game scorer and in
 * applyStrategicOverlay — and `hard` sets trustSearch, which keeps the search
 * plan as-is and only fills in units the search left idle. Since the search
 * assigns nearly every unit, the economy was effectively off at the highest
 * difficulty: the bot never searched ruins.
 *
 * Default ruins are rows 9-10, cols 9-10 (DEFAULT_RUINS).
 */
describe('economy in the search', () => {
  const cfg = { ...AI_DIFFICULTY.hard, mctsTimeBudgetMs: 300, intelligence: 1 } as any;

  it('generates a ruins-search action for a unit standing in ruins', () => {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'knight', row: 9, col: 9, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 9, player: 1 as Player, type: 'knight', row: 1, col: 1, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const unit = state.units.find((u: any) => u.id === 1)!;
    const raw = ai.generateActionsForLightState(state, unit);
    expect(raw.some((a: any) => a.type === 'draw')).toBe(true);
  });

  it('does not offer a ruins search outside the ruins', () => {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'knight', row: 5, col: 5, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 9, player: 1 as Player, type: 'knight', row: 1, col: 1, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const unit = state.units.find((u: any) => u.id === 1)!;
    const raw = ai.generateActionsForLightState(state, unit);
    expect(raw.some((a: any) => a.type === 'draw')).toBe(false);
  });

  it('prefers farming ruins over shuffling when no enemy is near', () => {
    // Lone unit in the ruins, enemy far away: nothing tactical to do, so
    // searching the ruins should be the top-scored action.
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'knight', row: 9, col: 9, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 9, player: 1 as Player, type: 'knight', row: 1, col: 1, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const unit = state.units.find((u: any) => u.id === 1)!;
    const raw = ai.generateActionsForLightState(state, unit);
    const scored = ai.scoreLightActions(state, unit, raw, 2);
    expect(scored[0].type).toBe('draw');
  });

  // Common spells (Дождь защиты/Сталь свободы/Небо огня) were removed from the
  // game entirely — only the mage's own abilities exist now, and the search
  // never learned about those (out of scope for that change). The 3 tests
  // that used to live here (tower-spell affordability, damage-buff casting,
  // no-recast-while-active) tested a mechanic that no longer exists in the
  // game and were removed along with it.

  it('the worker stub reports the real tower layout and matches Board on ruins', async () => {
    // In the browser the search runs INSIDE ai-worker.ts, whose stub board once
    // hardcoded isTower/inRuins to false. That silently disabled every economy
    // action in real games while all the tests (which use their own harness
    // stub) still passed. Towers must still read the live layout.
    //
    // Ruins are the opposite case now: artifacts are scattered invisibly across
    // the board and claimed by walking onto them, so nothing is searchable and
    // Board.inRuins returns false. The stub has to agree, or the worker plans
    // ruins-camping turns the real game refuses to execute.
    const read = (name: string) =>
      import('node:fs/promises').then((fs) =>
        fs.readFile(new URL(name, import.meta.url), 'utf8'),
      );
    const src = await read('../ai-worker.ts');
    expect(src).not.toMatch(/isTower:\s*\(\)\s*=>\s*false/);
    expect(src).toMatch(/getTowers\(\)/);
    expect(src).toMatch(/inRuins:\s*\(\)\s*=>\s*false/);

    // Both sides of the mismatch that bit us before must stay in lockstep.
    const board = await read('../Board.ts');
    expect(board).toMatch(/inRuins\([^)]*\):\s*boolean\s*\{\s*return false;/);
  });

  it('consumes the whole turn when searching ruins', () => {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'knight', row: 9, col: 9, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 9, player: 1 as Player, type: 'knight', row: 1, col: 1, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const after = ai.applyActionToState(state, 1, { type: 'draw', cost: 2, score: 0 });
    const unit = after.units.find((u: any) => u.id === 1)!;
    expect(unit.movesLeft).toBe(0);
    expect(unit.done).toBe(true);
  });
});
