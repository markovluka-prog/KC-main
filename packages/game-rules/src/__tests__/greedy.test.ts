import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState } from '../apply.js';
import { greedyStep, greedyTurn } from '../greedy.js';
import type { SerializedUnit } from '../save.js';
import type { GameState } from '../state.js';
import { UNIT_TYPES } from '../constants.js';

function mkUnit(
  over: Partial<SerializedUnit> & Pick<SerializedUnit, 'id' | 'player' | 'type'>,
): SerializedUnit {
  const t = UNIT_TYPES[over.type];
  return {
    row: 0,
    col: 0,
    maxHp: t.hp,
    hp: t.hp,
    startArmor: t.armor,
    armor: t.armor,
    maxArmor: t.armor,
    damage: t.damage,
    maxMoves: t.moves,
    movesLeft: t.moves,
    done: false,
    activated: false,
    visualRow: null,
    visualCol: null,
    dying: false,
    deathProgress: 0,
    weapon: null,
    armorGear: null,
    ...over,
  };
}

function startState(units: SerializedUnit[], seed = 1): GameState {
  return createInitialState({ mode: 'pvp', seed, units });
}

describe('greedyStep', () => {
  it('returns null when the player has no actable units', () => {
    const done = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5, done: true });
    const state = startState([done]);
    expect(greedyStep(state, 1)).toBeNull();
  });

  it('takes an obvious free kill in one step', () => {
    const attacker = mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10, damage: 5 });
    const victim = mkUnit({ id: 2, player: 2, type: 'knight', row: 10, col: 11, hp: 3, maxHp: 3 });
    const state = startState([attacker, victim]);
    const step = greedyStep(state, 1);
    expect(step).not.toBeNull();
    expect(step!.action.kind).toBe('attack');
  });
});

describe('greedyTurn', () => {
  it('respects the activation cap and never ends the turn itself', () => {
    const units = [
      mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 }),
      mkUnit({ id: 2, player: 1, type: 'archer', row: 11, col: 10 }),
      mkUnit({ id: 3, player: 1, type: 'cavalry', row: 12, col: 10 }),
      mkUnit({ id: 4, player: 2, type: 'knight', row: 10, col: 15 }),
    ];
    const state = startState(units);
    const final = greedyTurn(state, 1);
    expect(final.currentPlayer).toBe(1); // greedyTurn doesn't end the turn itself
    expect(final.activatedCount).toBeLessThanOrEqual(3);
  });

  it('terminates for a lone unit with nothing to attack (pure movement loop)', () => {
    const single = mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 });
    const state = startState([single]);
    const final = greedyTurn(state, 1);
    expect(final.units.length).toBe(1);
  });
});
