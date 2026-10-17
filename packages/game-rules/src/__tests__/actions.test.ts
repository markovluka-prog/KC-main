import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState } from '../apply.js';
import { actableUnitIds, generateActionsForPlayer, generateActionsForUnit } from '../actions.js';
import { mulberry32 } from '../rng.js';
import type { SerializedUnit } from '../save.js';
import type { GameState } from '../state.js';
import { UNIT_TYPES, emptyBackpack } from '../constants.js';

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
    backpack: emptyBackpack(),
    ...over,
  };
}

function startState(units: SerializedUnit[], seed = 1): GameState {
  return createInitialState({ mode: 'pvp', seed, units });
}

describe('generateActionsForUnit', () => {
  it('returns only move + build actions for an isolated knight with no targets/tower/ruins', () => {
    const knight = mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 });
    const state = startState([knight]);
    const actions = generateActionsForUnit(state, 1);
    expect(actions.length).toBeGreaterThan(0);
    // A knight with its full 2 movesLeft can also start building a tower on
    // any of its 4 orthogonally adjacent cells (see BUILD_COST_PER_TURN).
    expect(actions.every((a) => a.kind === 'move' || a.kind === 'build-tower')).toBe(true);
    expect(actions.filter((a) => a.kind === 'build-tower')).toHaveLength(4);
  });

  it('includes an attack action when an enemy is adjacent', () => {
    const knight = mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 });
    const enemy = mkUnit({ id: 2, player: 2, type: 'knight', row: 10, col: 11 });
    const state = startState([knight, enemy]);
    const actions = generateActionsForUnit(state, 1);
    const attacks = actions.filter((a) => a.kind === 'attack');
    expect(attacks.length).toBeGreaterThan(0);
  });

  it('returns [] for a done unit, a not-my-turn unit, or a dead unit', () => {
    const done = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5, done: true });
    const notMyTurn = mkUnit({ id: 2, player: 2, type: 'knight', row: 6, col: 6 });
    const dead = mkUnit({ id: 3, player: 1, type: 'knight', row: 7, col: 7, hp: 0 });
    const state = startState([done, notMyTurn, dead]);
    expect(generateActionsForUnit(state, 1)).toEqual([]);
    expect(generateActionsForUnit(state, 2)).toEqual([]);
    expect(generateActionsForUnit(state, 3)).toEqual([]);
  });

  it('offers ONLY equip-weapon while pendingWeaponEquip is set, to units that can wear it', () => {
    // Regression: the generator used to skip equip-weapon entirely (treated
    // as "forced, caller's job"), so once pendingWeaponEquip was set, every
    // unit's action list silently went to zero — discovered via a beam-vs-
    // greedy arena game stalling both sides forever after a hidden pickup.
    const archer = mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 });
    const knight = mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 6 });
    const state = startState([archer, knight]);
    state.pendingWeaponEquip = {
      name: 'Синий лук',
      amount: 2,
      icon: 'weapon_bow',
      allowedTypes: ['archer', 'crossbow'],
      forbidTypes: null,
      archerOnly: true,
      slot: 'weapon',
    };
    // The archer can wear it: exactly one action, equip-weapon.
    expect(generateActionsForUnit(state, 1)).toEqual([{ kind: 'equip-weapon', unitId: 1 }]);
    // The knight can't (archerOnly): no actions at all until it's resolved.
    expect(generateActionsForUnit(state, 2)).toEqual([]);
  });

  it('offers equip-weapon even for an already-done unit, since applyEquipWeapon ignores done/movesLeft', () => {
    const archer = mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5, done: true, movesLeft: 0 });
    const state = startState([archer]);
    state.pendingWeaponEquip = {
      name: 'Синий лук',
      amount: 2,
      icon: 'weapon_bow',
      allowedTypes: ['archer', 'crossbow'],
      forbidTypes: null,
      archerOnly: true,
      slot: 'weapon',
    };
    expect(generateActionsForUnit(state, 1)).toEqual([{ kind: 'equip-weapon', unitId: 1 }]);
  });

  it('offers castle-heal only when standing in own damaged castle', () => {
    const state0 = startState([]);
    const hurt = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: 0,
      col: state0.castleP1Col,
      hp: 1,
    });
    const state = startState([hurt]);
    const actions = generateActionsForUnit(state, 1);
    expect(actions.some((a) => a.kind === 'castle-heal')).toBe(true);
  });

  it('does not offer castle-heal when already at full hp/armor', () => {
    const state0 = startState([]);
    const full = mkUnit({ id: 1, player: 1, type: 'knight', row: 0, col: state0.castleP1Col });
    const state = startState([full]);
    const actions = generateActionsForUnit(state, 1);
    expect(actions.some((a) => a.kind === 'castle-heal')).toBe(false);
  });

  it('never offers search-ruins — ruins hold nothing (client parity)', () => {
    const inRuins = mkUnit({ id: 1, player: 1, type: 'knight', row: 9, col: 9 });
    const state = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [inRuins],
      ruins: { top: 9, left: 9, width: 2, height: 2 },
    });
    const actions = generateActionsForUnit(state, 1);
    expect(actions.some((a) => a.kind === 'search-ruins')).toBe(false);
  });

  it('offers craft-armor only once the unit holds enough parts (no tower needed — anyone can craft)', () => {
    const crafter = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 4 });
    const state = createInitialState({ mode: 'pvp', seed: 1, units: [crafter] });
    // No parts yet — unaffordable, so no craft-armor actions.
    expect(generateActionsForUnit(state, 1).some((a) => a.kind === 'craft-armor')).toBe(false);

    // Кольчуга (ARMORS[0]): Дерево×1, Стрелы×1.
    state.units[0]!.backpack['Дерево'] = 1;
    state.units[0]!.backpack['Стрелы'] = 1;
    expect(generateActionsForUnit(state, 1).some((a) => a.kind === 'craft-armor')).toBe(true);
  });
});

describe('generateActionsForUnit output is always applyAction-legal', () => {
  it('every generated action succeeds against applyAction, for every unit, across a played-out sequence of turns', () => {
    const rng = mulberry32(42);
    const p1 = [
      mkUnit({ id: 1, player: 1, type: 'knight', row: 1, col: 1 }),
      mkUnit({ id: 2, player: 1, type: 'archer', row: 1, col: 2 }),
      mkUnit({ id: 3, player: 1, type: 'cavalry', row: 1, col: 3 }),
    ];
    const p2 = [
      mkUnit({ id: 4, player: 2, type: 'knight', row: 3, col: 1 }),
      mkUnit({ id: 5, player: 2, type: 'archer', row: 3, col: 2 }),
      mkUnit({ id: 6, player: 2, type: 'catapult', row: 3, col: 3 }),
    ];
    let state = startState([...p1, ...p2]);

    for (let turn = 0; turn < 20 && state.winner === null; turn++) {
      const player = state.currentPlayer;
      let progressed = false;
      for (const id of actableUnitIds(state, player)) {
        const actions = generateActionsForUnit(state, id);
        if (actions.length === 0) continue;
        const action = actions[0]!;
        const result = applyAction(state, action, rng);
        expect(result.ok, `action ${JSON.stringify(action)} should be legal`).toBe(true);
        if (result.ok) {
          state = result.value;
          progressed = true;
        }
      }
      if (!progressed) {
        const endResult = applyAction(state, { kind: 'end-turn' }, rng);
        expect(endResult.ok).toBe(true);
        if (endResult.ok) state = endResult.value;
      }
    }
  });
});

describe('generateActionsForUnit — mage', () => {
  it('offers mage-heal for a hurt ally within energy range, and every offered action is legal', () => {
    const mage = mkUnit({ id: 1, player: 1, type: 'mage', row: 5, col: 5, energy: 20, maxEnergy: 20, warding: [] });
    const hurtAlly = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 6, hp: 1 });
    const enemy = mkUnit({ id: 3, player: 2, type: 'knight', row: 5, col: 7 });
    const state = startState([mage, hurtAlly, enemy]);
    const actions = generateActionsForUnit(state, 1);

    const heals = actions.filter((a) => a.kind === 'mage-heal');
    expect(heals).toHaveLength(1);
    expect(heals[0]).toMatchObject({ kind: 'mage-heal', unitId: 1, targetUnitId: 2 });

    // Every action this generator offers must actually succeed.
    for (const action of actions) {
      const res = applyAction(state, action, mulberry32(1));
      expect(res.ok, `action ${JSON.stringify(action)} should be legal`).toBe(true);
    }
  });

  it('does not offer mage-heal for a full-hp ally or for an enemy', () => {
    const mage = mkUnit({ id: 1, player: 1, type: 'mage', row: 5, col: 5, energy: 20, maxEnergy: 20, warding: [] });
    const fullAlly = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 6 });
    const hurtEnemy = mkUnit({ id: 3, player: 2, type: 'knight', row: 5, col: 4, hp: 1 });
    const state = startState([mage, fullAlly, hurtEnemy]);
    const actions = generateActionsForUnit(state, 1);
    expect(actions.some((a) => a.kind === 'mage-heal')).toBe(false);
  });

  it('withholds mage-heal when energy is too low for the distance + missing hp', () => {
    const mage = mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0, energy: 1, maxEnergy: 20, warding: [] });
    const hurtAlly = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 5, hp: 1 });
    const state = startState([mage, hurtAlly]);
    const actions = generateActionsForUnit(state, 1);
    expect(actions.some((a) => a.kind === 'mage-heal')).toBe(false);
  });

  it('offers mage-attack/mage-ward/mage-burn-bridge/mage-drain when affordable', () => {
    const mage = mkUnit({ id: 1, player: 1, type: 'mage', row: 5, col: 5, energy: 20, maxEnergy: 20, warding: [] });
    const enemyAdjacent = mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 6, hp: 5 });
    const state = startState([mage, enemyAdjacent]);
    state.terrain = [{ row: 5, col: 8, type: 'bridge' }];
    state.bridgeDurability = { '5,8': 2 };
    const actions = generateActionsForUnit(state, 1);

    expect(actions.some((a) => a.kind === 'mage-attack' && a.targetRow === 5 && a.targetCol === 6)).toBe(true);
    expect(actions.some((a) => a.kind === 'mage-drain' && a.targetUnitId === 2)).toBe(true);
    expect(actions.some((a) => a.kind === 'mage-ward')).toBe(true);
    expect(actions.some((a) => a.kind === 'mage-burn-bridge' && a.row === 5 && a.col === 8)).toBe(true);

    for (const action of actions) {
      const res = applyAction(state, action, mulberry32(1));
      expect(res.ok, `action ${JSON.stringify(action)} should be legal`).toBe(true);
    }
  });
});

describe('generateActionsForPlayer', () => {
  it('flat-maps generateActionsForUnit over every actable unit of the given player', () => {
    const a = mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 });
    const b = mkUnit({ id: 2, player: 1, type: 'archer', row: 12, col: 12 });
    const enemy = mkUnit({ id: 3, player: 2, type: 'knight', row: 15, col: 15 });
    const state = startState([a, b, enemy]);
    const combined = generateActionsForPlayer(state, 1);
    const separately = [
      ...generateActionsForUnit(state, 1),
      ...generateActionsForUnit(state, 2),
    ];
    expect(combined).toEqual(separately);
    expect(generateActionsForPlayer(state, 1).some((act) => 'unitId' in act && act.unitId === 3)).toBe(
      false,
    );
  });
});
