import { afterEach, describe, it, expect } from 'vitest';
import { MAGE_ENERGY_REGEN_PER_TURN, setTerrain, setTowers } from '@kc/game-rules';
import { AI_DIFFICULTY } from '../ai-config.js';
import { makeSearcher, makeState, makeUnit, type Player } from './mcts-harness.js';

/**
 * The search's light-state simulator must honour mage wards the same way
 * apply.ts's absorbWithWard does, or the bot keeps "killing" shielded units in
 * its rollouts and wastes real attacks on them.
 */
describe('search simulation — mage ward', () => {
  const cfg = { ...AI_DIFFICULTY.hard, mctsTimeBudgetMs: 100, intelligence: 1 } as any;
  const attack = { type: 'attack', targetRow: 5, targetCol: 6, landingRow: 5, landingCol: 5, cost: 1, score: 0 };

  function setup(mageEnergy: number) {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'knight', row: 5, col: 5, hp: 3, armor: 0, damage: 5, maxMoves: 2 }),
        { ...makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 5, col: 6, hp: 1, armor: 0, damage: 5, maxMoves: 2 }), wardedBy: 3 },
        { ...makeUnit({ id: 3, player: 1 as Player, type: 'mage', row: 9, col: 9, hp: 2, armor: 0, damage: 0, maxMoves: 2 }), energy: mageEnergy },
      ],
      3,
    );
    return { state, ai: makeSearcher(2, cfg, state, true) as any };
  }

  it('a warded target survives and its mage pays the energy', () => {
    const { state, ai } = setup(20);
    const after = ai.applyActionToState(state, 1, attack);
    expect(after.units.find((u: any) => u.id === 2)?.hp).toBe(1);
    expect(after.units.find((u: any) => u.id === 3)?.energy).toBe(15);
  });

  it('an overdrawn mage dies, the target still survives and is no longer warded', () => {
    const { state, ai } = setup(2);
    const after = ai.applyActionToState(state, 1, attack);
    expect(after.units.some((u: any) => u.id === 3)).toBe(false);
    const target = after.units.find((u: any) => u.id === 2)!;
    expect(target.hp).toBe(1);
    expect(target.wardedBy).toBeNull();
  });
});

describe('search generator matches the real rules', () => {
  const cfg = { ...AI_DIFFICULTY.hard, mctsTimeBudgetMs: 100, intelligence: 1 } as any;

  it('a crossbow only fires pierce lines (cost 2), never an archer-style knight-offset shot', () => {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'crossbow', row: 5, col: 5, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 7, col: 5, hp: 3, armor: 0 }), // 2 down: on a line
        makeUnit({ id: 3, player: 1 as Player, type: 'knight', row: 6, col: 7, hp: 3, armor: 0 }), // knight offset: no line
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const attacks = ai.generateActionsForLightState(state, state.units[0]).filter((a: any) => a.type === 'attack');
    expect(attacks).toHaveLength(1);
    expect(attacks[0].cost).toBe(2);
    expect(attacks[0].pierce[0]).toEqual({ row: 6, col: 5 }); // keyed by the first cell, like the game
    expect(attacks[0].targetRow).toBe(7);
  });

  it('a crossbow skips a line that would hit its own unit', () => {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'crossbow', row: 5, col: 5, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 4, player: 2 as Player, type: 'knight', row: 6, col: 5 }),
        makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 7, col: 5 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const attacks = ai.generateActionsForLightState(state, state.units[0]).filter((a: any) => a.type === 'attack');
    expect(attacks).toHaveLength(0);
  });

  it('a pierce shot damages every unit on the line in the simulation', () => {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'crossbow', row: 5, col: 5, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 6, col: 5, hp: 3, armor: 0 }),
        makeUnit({ id: 3, player: 1 as Player, type: 'knight', row: 7, col: 5, hp: 3, armor: 0 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const shot = ai.generateActionsForLightState(state, state.units[0]).find((a: any) => a.type === 'attack');
    const after = ai.applyActionToState(state, 1, shot);
    expect(after.units.some((u: any) => u.id === 2 || u.id === 3)).toBe(false);
  });

  it('a mage gets no plain attack actions', () => {
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'mage', row: 5, col: 5, damage: 0, maxMoves: 2 }),
        makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 5, col: 6 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const acts = ai.generateActionsForLightState(state, state.units[0]);
    expect(acts.some((a: any) => a.type === 'attack')).toBe(false);
    expect(acts.some((a: any) => a.type === 'move')).toBe(true);
  });
});

describe('search simulation — towers, rivers, mage energy', () => {
  const cfg = { ...AI_DIFFICULTY.hard, mctsTimeBudgetMs: 100, intelligence: 1 } as any;
  afterEach(() => {
    setTowers([]);
    setTerrain([]);
  });

  it('an archer on a tower reaches 3 cells (and hits weaker), like the real game', () => {
    setTowers([{ row: 5, col: 5 }]);
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'archer', row: 5, col: 5, damage: 3, maxMoves: 3 }),
        makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 8, col: 5, hp: 3, armor: 0 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const shot = ai.generateActionsForLightState(state, state.units[0]).find((a: any) => a.type === 'attack');
    expect(shot).toBeTruthy();
    const after = ai.applyActionToState(state, 1, shot);
    expect(after.units.find((u: any) => u.id === 2)?.hp).toBe(1); // round(3 × 0.65) = 2 damage
  });

  it('cavalry can leap a one-cell river', () => {
    setTerrain([{ row: 5, col: 6, type: 'river' }]);
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'cavalry', row: 5, col: 5, maxMoves: 3 }),
        makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 15, col: 15 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const acts = ai.generateActionsForLightState(state, state.units[0]);
    expect(acts.some((a: any) => a.type === 'move' && a.row === 5 && a.col === 7 && a.cost === 2)).toBe(true);
  });

  it('mage energy regenerates when its side starts a simulated turn', () => {
    const state = makeState(
      [
        { ...makeUnit({ id: 1, player: 2 as Player, type: 'mage', row: 5, col: 5 }), energy: 3 },
        makeUnit({ id: 2, player: 1 as Player, type: 'knight', row: 15, col: 15 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, cfg, state, true);
    const after = ai.applyEndOfTurn(state, 1);
    expect(after.units.find((u: any) => u.id === 1)?.energy).toBe(3 + MAGE_ENERGY_REGEN_PER_TURN);
  });
});
