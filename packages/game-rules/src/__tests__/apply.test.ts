import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState, endTurn, type ServerAction } from '../apply.js';
import { mulberry32 } from '../rng.js';
import type { SerializedUnit } from '../save.js';
import type { GameState } from '../state.js';
import {
  MAGE_DRAIN_ENERGY_PER_HP,
  MAGE_ENERGY_REGEN_PER_TURN,
  MAGE_MAX_ENERGY,
  MAGE_WARD_ENERGY_PER_DAMAGE,
  PARTS,
  UNIT_TYPES,
  emptyBackpack,
} from '../constants.js';

function mkUnit(
  over: Partial<SerializedUnit> & Pick<SerializedUnit, 'id' | 'player' | 'type'>,
): SerializedUnit {
  const t = UNIT_TYPES[over.type];
  const unit: SerializedUnit = {
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
  if (unit.type === 'mage' && unit.energy === undefined) {
    unit.maxEnergy = MAGE_MAX_ENERGY;
    unit.energy = MAGE_MAX_ENERGY;
    unit.warding = [];
  }
  return unit;
}

function startState(units: SerializedUnit[], seed = 1): GameState {
  return createInitialState({ mode: 'pvp', seed, units });
}

describe('createInitialState', () => {
  it('starts on player 1 turn at turn 1', () => {
    const s = createInitialState({ mode: 'pvp', seed: 1 });
    expect(s.currentPlayer).toBe(1);
    expect(s.turnNumber).toBe(1);
    expect(s.winner).toBeNull();
    expect(s.rngSeed).toBe(1);
    expect(s.rngCursor).toBe(0);
  });

  it('player1Starts=false flips to player 2', () => {
    const s = createInitialState({ mode: 'pvp', seed: 1, player1Starts: false });
    expect(s.currentPlayer).toBe(2);
  });

  it('every unit starts with an empty backpack', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight' })]);
    const totals = PARTS.reduce((sum, p) => sum + s.units[0]!.backpack[p], 0);
    expect(totals).toBe(0);
  });
});

describe('applyAction — move', () => {
  it('moves the unit and decrements movesLeft', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    const a: ServerAction = { kind: 'move', unitId: 1, row: 6, col: 5, cost: 1 };
    const res = applyAction(s, a, mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const u = res.value.units.find((x) => x.id === 1)!;
    expect(u.row).toBe(6);
    expect(u.col).toBe(5);
    expect(u.movesLeft).toBe(UNIT_TYPES.knight.moves - 1);
  });

  it('marks unit done when movesLeft hits 0', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', movesLeft: 1 })]);
    const a: ServerAction = { kind: 'move', unitId: 1, row: 1, col: 0, cost: 1 };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.units[0]!.done).toBe(true);
  });

  it('rejects when destination is occupied', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 6, col: 5 }),
    ]);
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 6, col: 5, cost: 1 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('illegal-move');
  });

  it('rejects when not unit owner turn', () => {
    const s = startState([mkUnit({ id: 1, player: 2, type: 'knight' })]);
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 0, col: 1, cost: 1 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('wrong-turn');
  });

  it('rejects when movesLeft < cost', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', movesLeft: 0 })]);
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 0, col: 1, cost: 1 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('no-moves-left');
  });
});

describe('applyAction — attack', () => {
  it('deals raw damage minus armor when damage exceeds armor', () => {
    // Knight (dmg=5) vs archer (hp=3, armor=1). Expected damageToHp = 5-1 = 4 → dies.
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 5, col: 6 }),
    ]);
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 2,
      targetRow: 5,
      targetCol: 6,
      landingRow: 5,
      landingCol: 5,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    // Archer (hp=3) dies from 4 hp damage; unit is removed.
    expect(res.value.units.find((u) => u.id === 2)).toBeUndefined();
  });

  it('damage absorbs into armor first', () => {
    // Knight (dmg=5) vs knight (armor=4, hp=3). damage 5 > armor 4 → 1 hp lost.
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'knight' }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 5 }),
    ]);
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 2,
      targetRow: 5,
      targetCol: 5,
      landingRow: 0,
      landingCol: 0,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    const target = res.value.units.find((u) => u.id === 2)!;
    expect(target.armor).toBe(0);
    expect(target.hp).toBe(UNIT_TYPES.knight.hp - 1);
  });

  it('damage <= armor: only armor decreases, hp unchanged', () => {
    // Archer (dmg=3) vs knight (armor=4, hp=3). 3 <= 4 → armor -= 3, hp unchanged.
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 4 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 5 }),
    ]);
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 1,
      targetRow: 5,
      targetCol: 5,
      landingRow: 5,
      landingCol: 4,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    const target = res.value.units.find((u) => u.id === 2)!;
    expect(target.armor).toBe(UNIT_TYPES.knight.armor - UNIT_TYPES.archer.damage);
    expect(target.hp).toBe(UNIT_TYPES.knight.hp);
  });

  it('damage buff +2 applies when active', () => {
    // Archer dmg 3 + buff 2 = 5 vs archer (armor=1, hp=3). damageToHp = 4 → dies.
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 4 }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 5, col: 5 }),
    ]);
    s.damageBuff[1] = 2;
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 1,
      targetRow: 5,
      targetCol: 5,
      landingRow: 5,
      landingCol: 4,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.units.find((u) => u.id === 2)).toBeUndefined();
  });

  it('a warded target takes zero damage — the ward absorbs the whole hit', () => {
    // See [[kc-mage-ward-mechanic]]: ward is per-unit (wardedBy), full
    // absorption, and drains the WARDING MAGE's energy, not a flat -2/hit.
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 4 }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 5, col: 5 }),
      mkUnit({ id: 3, player: 2, type: 'mage', row: 9, col: 9 }),
    ]);
    s.units.find((u) => u.id === 2)!.wardedBy = 3;
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 1,
      targetRow: 5,
      targetCol: 5,
      landingRow: 5,
      landingCol: 4,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    const target = res.value.units.find((u) => u.id === 2)!;
    const warder = res.value.units.find((u) => u.id === 3)!;
    // Archer dmg 3 fully absorbed — target untouched, warder pays 1-to-1: 3 energy.
    expect(target.armor).toBe(UNIT_TYPES.archer.armor);
    expect(target.hp).toBe(UNIT_TYPES.archer.hp);
    expect(warder.energy).toBe(MAGE_MAX_ENERGY - 3);
  });

  it('archer min-1 rule: archer always lands at least 1 damage', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'archer', damage: 0, row: 5, col: 4 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 5 }),
    ]);
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 1,
      targetRow: 5,
      targetCol: 5,
      landingRow: 5,
      landingCol: 4,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    const target = res.value.units.find((u) => u.id === 2)!;
    // 0 base damage would floor to 0 — archer min-1 rule only applies when
    // attacker.damage > 0, so with damage:0 the shot should deal 0.
    expect(target.armor).toBe(UNIT_TYPES.knight.armor);
  });

  it('a warded target overdrawing its mage kills the mage, not the target', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'catapult', row: 5, col: 4 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 8, col: 4, armor: 0 }),
      mkUnit({ id: 3, player: 2, type: 'mage', row: 9, col: 9, energy: 0 }),
    ]);
    s.units.find((u) => u.id === 2)!.wardedBy = 3;
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 1,
      targetRow: 8,
      targetCol: 4,
      landingRow: 5,
      landingCol: 4,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    // Catapult deals 7 — 1-to-1 needs 7 energy, mage has 0 → mage dies.
    expect(res.value.units.some((u) => u.id === 3)).toBe(false);
    // The warded target is untouched — the shield still fully absorbed the hit.
    const target = res.value.units.find((u) => u.id === 2)!;
    expect(target.hp).toBe(UNIT_TYPES.knight.hp);
    expect(target.armor).toBe(0);
  });

  it('jump/l-attack landing changes attacker position', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'cavalry', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 1, col: 0 }),
    ]);
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'jump',
      cost: 2,
      targetRow: 1,
      targetCol: 0,
      landingRow: 2,
      landingCol: 0,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    const attacker = res.value.units.find((u) => u.id === 1)!;
    expect(attacker.row).toBe(2);
    expect(attacker.col).toBe(0);
  });

  it('emits match-finished when P1 captures P2 castle undefended', () => {
    // P2 castle zone: rows 16-19, cols 8-11 (castleP2Col default = 8).
    // P1 cavalry moves into row 16 col 8 with no P2 unit defending the castle.
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'cavalry', row: 15, col: 8, movesLeft: 3 }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 0, col: 0 }),
    ]);
    const a: ServerAction = { kind: 'move', unitId: 1, row: 16, col: 8, cost: 1 };
    const res = applyAction(s, a, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.winner).toBe(1);
    expect(res.events.some((e) => e.kind === 'match-finished')).toBe(true);
  });

  it('rejects attacks against own units', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'knight' }),
      mkUnit({ id: 2, player: 1, type: 'archer', row: 5, col: 5 }),
    ]);
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 1,
      targetRow: 5,
      targetCol: 5,
      landingRow: 0,
      landingCol: 0,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('illegal-attack');
  });

  it('rejects when no target cell occupant', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight' })]);
    const a: ServerAction = {
      kind: 'attack',
      unitId: 1,
      mode: 'shot',
      cost: 1,
      targetRow: 19,
      targetCol: 9,
      landingRow: 0,
      landingCol: 0,
    };
    const res = applyAction(s, a, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('no-target');
  });
});

describe('applyAction — crossbow pierce shot', () => {
  function pierceAction(over: Partial<ServerAction & { kind: 'attack' }> = {}): ServerAction {
    return {
      kind: 'attack',
      unitId: 1,
      mode: 'pierce',
      cost: 2,
      targetRow: 5,
      targetCol: 6,
      landingRow: 5,
      landingCol: 5,
      targets: [
        { row: 5, col: 6 },
        { row: 5, col: 7 },
      ],
      ...over,
    };
  }

  it('hits a single enemy on the line for full damage and costs 2 moves', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'crossbow', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 6 }),
    ]);
    const res = applyAction(s, pierceAction(), mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const attacker = res.value.units.find((u) => u.id === 1)!;
    const target = res.value.units.find((u) => u.id === 2)!;
    expect(attacker.movesLeft).toBe(UNIT_TYPES.crossbow.moves - 2);
    // crossbow damage 5 vs knight armor 4 → 1 to hp.
    expect(target.hp).toBe(UNIT_TYPES.knight.hp - 1);
  });

  it('hits BOTH cells on the line, including a friendly unit on the second cell', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'crossbow', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 6 }),
      mkUnit({ id: 3, player: 1, type: 'knight', row: 5, col: 7 }),
    ]);
    const res = applyAction(s, pierceAction(), mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const enemy = res.value.units.find((u) => u.id === 2)!;
    const ally = res.value.units.find((u) => u.id === 3)!;
    // Both take the same crossbow-vs-knight-armor hit, friend or foe alike.
    expect(enemy.hp).toBe(UNIT_TYPES.knight.hp - 1);
    expect(ally.hp).toBe(UNIT_TYPES.knight.hp - 1);
  });

  it('kills and drops gear for a unit slain on the far cell', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'crossbow', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 5, col: 7, hp: 1, armor: 0 }),
    ]);
    const res = applyAction(s, pierceAction(), mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.units.some((u) => u.id === 2)).toBe(false);
  });

  it('rejects a diagonal-off-line target list', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'crossbow', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 6, col: 7 }),
    ]);
    const res = applyAction(
      s,
      pierceAction({
        targetRow: 6,
        targetCol: 7,
        targets: [
          { row: 5, col: 6 },
          { row: 6, col: 7 },
        ],
      }),
      mulberry32(1),
    );
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('illegal-attack');
  });

  it('rejects a non-crossbow unit firing a pierce shot', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 6 }),
    ]);
    const res = applyAction(s, pierceAction(), mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('illegal-attack');
  });

  it('rejects when nothing living stands anywhere on the line', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'crossbow', row: 5, col: 5 })]);
    const res = applyAction(s, pierceAction(), mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('no-target');
  });

  it('rejects a cost other than 2', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'crossbow', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 6 }),
    ]);
    const res = applyAction(s, pierceAction({ cost: 1 }), mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('illegal-attack');
  });
});

describe('endTurn / applyAction kind=end-turn', () => {
  it('flips currentPlayer and increments turnNumber', () => {
    const s = startState([]);
    const out = endTurn(s);
    expect(out.currentPlayer).toBe(2);
    expect(out.turnNumber).toBe(2);
  });

  it('refills movesLeft for the upcoming player', () => {
    const s = startState([mkUnit({ id: 1, player: 2, type: 'knight', done: true, movesLeft: 0 })]);
    const out = endTurn(s);
    const u = out.units.find((x) => x.id === 1)!;
    expect(u.done).toBe(false);
    expect(u.movesLeft).toBe(UNIT_TYPES.knight.moves);
  });

  it('decrements shield/buff for the ending player only', () => {
    const s = startState([]);
    s.shieldTurns[1] = 2;
    s.damageBuff[1] = 1;
    s.shieldTurns[2] = 1;
    const out = endTurn(s);
    expect(out.shieldTurns[1]).toBe(1);
    expect(out.damageBuff[1]).toBe(0);
    expect(out.shieldTurns[2]).toBe(1);
  });

  it('via applyAction kind=end-turn produces an event', () => {
    const s = startState([]);
    const res = applyAction(s, { kind: 'end-turn' }, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    expect(res.events.some((e) => e.kind === 'turn-ended')).toBe(true);
  });
});

describe('applyAction — resign', () => {
  it('sets winner to the opposite player and emits match-finished', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'knight' }),
      mkUnit({ id: 2, player: 2, type: 'archer', row: 5, col: 5 }),
    ]);
    const res = applyAction(s, { kind: 'resign', player: 1 }, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.winner).toBe(2);
    expect(res.events.some((e) => e.kind === 'match-finished')).toBe(true);
  });
});

describe('applyAction — search-ruins (RNG-determined)', () => {
  it('same seed produces same loot result deterministically', () => {
    const setup = (): GameState => {
      const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
      s.ruins = { top: 5, left: 5, width: 1, height: 1 };
      return s;
    };
    const r1 = applyAction(setup(), { kind: 'search-ruins', unitId: 1 }, mulberry32(42));
    const r2 = applyAction(setup(), { kind: 'search-ruins', unitId: 1 }, mulberry32(42));
    if (!r1.ok || !r2.ok) throw new Error('expected ok');
    expect(r1.events[0]!.data['loot']).toEqual(r2.events[0]!.data['loot']);
  });

  it('rejects when unit is not standing on the ruins area', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 0, col: 0 })]);
    s.ruins = { top: 5, left: 5, width: 1, height: 1 };
    const res = applyAction(s, { kind: 'search-ruins', unitId: 1 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('unit-not-on-ruins');
  });

  it('marks the searching unit as done', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    s.ruins = { top: 5, left: 5, width: 1, height: 1 };
    const res = applyAction(s, { kind: 'search-ruins', unitId: 1 }, mulberry32(1));
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.units[0]!.done).toBe(true);
    expect(res.value.rngCursor).toBeGreaterThan(0);
  });
});

describe('applyAction — activation cap (3 units/turn)', () => {
  function fourUnits(): GameState {
    return startState([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 1, col: 0 }),
      mkUnit({ id: 3, player: 1, type: 'knight', row: 2, col: 0 }),
      mkUnit({ id: 4, player: 1, type: 'knight', row: 3, col: 0 }),
    ]);
  }

  it('lets three distinct units act but rejects a fourth', () => {
    let s = fourUnits();
    for (const id of [1, 2, 3]) {
      const res = applyAction(
        s,
        { kind: 'move', unitId: id, row: id - 1, col: 1, cost: 1 },
        mulberry32(1),
      );
      if (!res.ok) throw new Error(`unit ${id} should move, got ${res.error.code}`);
      s = res.value;
    }
    expect(s.activatedCount).toBe(3);
    const fourth = applyAction(
      s,
      { kind: 'move', unitId: 4, row: 3, col: 1, cost: 1 },
      mulberry32(1),
    );
    if (fourth.ok) throw new Error('expected fourth activation to be rejected');
    expect(fourth.error.code).toBe('activation-limit');
  });

  it('an already-activated unit can keep acting (move twice) without consuming a new slot', () => {
    let s = startState([
      mkUnit({ id: 1, player: 1, type: 'cavalry', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 0 }),
      mkUnit({ id: 3, player: 1, type: 'knight', row: 6, col: 0 }),
    ]);
    // cavalry moves once (activates), then again — still 1 activation.
    let res = applyAction(s, { kind: 'move', unitId: 1, row: 1, col: 0, cost: 1 }, mulberry32(1));
    if (!res.ok) throw new Error('move 1 failed');
    s = res.value;
    res = applyAction(s, { kind: 'move', unitId: 1, row: 2, col: 0, cost: 1 }, mulberry32(1));
    if (!res.ok) throw new Error('move 2 failed');
    s = res.value;
    expect(s.activatedCount).toBe(1);
  });

  it('resets activation counters on end-turn', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 0, col: 0 })]);
    const moved = applyAction(
      s,
      { kind: 'move', unitId: 1, row: 1, col: 0, cost: 1 },
      mulberry32(1),
    );
    if (!moved.ok) throw new Error('move failed');
    expect(moved.value.activatedCount).toBe(1);
    const ended = endTurn(moved.value);
    expect(ended.activatedCount).toBe(0);
    expect(ended.units.find((u) => u.id === 1)!.activated).toBe(false);
  });
});

describe('applyAction — craft + equip', () => {
  // Солнечный меч (index 0): Металл×2, Амулет×1, Рубин×1.
  function swordReady(units: SerializedUnit[]): GameState {
    const s = startState(units);
    s.units.forEach((u) => {
      if (u.player !== 1) return;
      u.backpack['Металл'] = 2;
      u.backpack['Амулет'] = 1;
      u.backpack['Рубин'] = 1;
    });
    return s;
  }

  it('crafting deducts the recipe from the crafter, spends a move, and equips the crafter (it can wear a sword)', () => {
    const s = swordReady([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    const res = applyAction(s, { kind: 'craft', unitId: 1, index: 0 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const u = res.value.units[0]!;
    expect(u.backpack['Металл']).toBe(0);
    expect(u.backpack['Рубин']).toBe(0);
    expect(u.movesLeft).toBe(UNIT_TYPES.knight.moves - 1);
    expect(u.weapon).not.toBeNull();
    expect(u.weapon!.name).toBe('Солнечный меч');
    expect(res.value.pendingWeaponEquip).toBeNull();
    expect(res.events.some((e) => e.kind === 'weapon-crafted')).toBe(true);
  });

  it('rejects crafting when parts are insufficient', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    const res = applyAction(s, { kind: 'craft', unitId: 1, index: 0 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('craft-unaffordable');
  });

  it('leaves the sword on the crafter\'s cell when the crafter already carries a weapon', () => {
    const s = swordReady([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5, weapon: { name: 'x', icon: '', amount: 1 } }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 5 }),
    ]);
    const crafted = applyAction(s, { kind: 'craft', unitId: 1, index: 0 }, mulberry32(1));
    if (!crafted.ok) throw new Error('craft failed');
    // No forced equip step — the client drops it, so the engine must too.
    expect(crafted.value.pendingWeaponEquip).toBeNull();
    expect(crafted.value.droppedBackpacks).toHaveLength(1);
    expect(crafted.value.droppedBackpacks[0]).toMatchObject({ row: 5, col: 5 });
    expect(crafted.value.droppedBackpacks[0]!.weapon!.name).toBe('Солнечный меч');
  });

  it('an ally stepping onto the dropped sword picks it up', () => {
    const s = swordReady([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5, weapon: { name: 'x', icon: '', amount: 1 } }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 5 }),
    ]);
    const crafted = applyAction(s, { kind: 'craft', unitId: 1, index: 0 }, mulberry32(1));
    if (!crafted.ok) throw new Error('craft failed');
    const away = applyAction(crafted.value, { kind: 'move', unitId: 1, row: 4, col: 5, cost: 1 }, mulberry32(1));
    if (!away.ok) throw new Error(`move failed: ${away.error.code}`);
    const picked = applyAction(away.value, { kind: 'move', unitId: 2, row: 5, col: 5, cost: 1 }, mulberry32(1));
    if (!picked.ok) throw new Error(`pickup failed: ${picked.error.code}`);
    const u = picked.value.units.find((x) => x.id === 2)!;
    expect(u.weapon?.name).toBe('Солнечный меч');
    expect(u.damage).toBe(UNIT_TYPES.knight.damage + 3);
    expect(picked.value.droppedBackpacks).toHaveLength(0);
  });

  // pendingWeaponEquip survives only for the legacy ruins-search path; the
  // equip gate itself must still hold whenever it is set.
  function withPendingSword(units: SerializedUnit[]): GameState {
    const s = startState(units);
    s.pendingWeaponEquip = {
      name: 'Солнечный меч',
      amount: 3,
      icon: 'weapon_sword',
      allowedTypes: null,
      forbidTypes: ['archer', 'catapult', 'crossbow'],
      archerOnly: false,
      slot: 'weapon',
    };
    return s;
  }

  it('blocks every other action until a pending weapon is equipped', () => {
    const s = withPendingSword([mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 5 })]);
    const blocked = applyAction(s, { kind: 'move', unitId: 2, row: 7, col: 5, cost: 1 }, mulberry32(1));
    if (blocked.ok) throw new Error('expected the move to be blocked');
    expect(blocked.error.code).toBe('weapon-pending');
  });

  it('equipping a pending weapon binds it: +damage, weapon set, pending cleared', () => {
    const s = withPendingSword([mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 5 })]);
    const equipped = applyAction(s, { kind: 'equip-weapon', unitId: 2 }, mulberry32(1));
    if (!equipped.ok) throw new Error(`equip failed: ${equipped.error.code}`);
    const u = equipped.value.units.find((x) => x.id === 2)!;
    expect(u.damage).toBe(UNIT_TYPES.knight.damage + 3);
    expect(u.weapon!.name).toBe('Солнечный меч');
    expect(equipped.value.pendingWeaponEquip).toBeNull();
  });

  it('rejects equipping the sword to an archer (forbidden type)', () => {
    const s = withPendingSword([
      mkUnit({ id: 2, player: 1, type: 'archer', row: 6, col: 5 }),
      mkUnit({ id: 3, player: 1, type: 'knight', row: 7, col: 5 }),
    ]);
    const res = applyAction(s, { kind: 'equip-weapon', unitId: 2 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('cannot-equip');
  });

  it('drops the weapon (no pending) when no eligible recipient exists', () => {
    // Only an archer present; sword forbids archers → nobody can take it.
    const s = swordReady([mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 })]);
    const res = applyAction(s, { kind: 'craft', unitId: 1, index: 0 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.pendingWeaponEquip).toBeNull();
    const ev = res.events.find((e) => e.kind === 'weapon-crafted')!;
    expect(ev.data['dropped']).toBe(true);
  });

  it('rejects equip when nothing is pending', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    const res = applyAction(s, { kind: 'equip-weapon', unitId: 1 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('no-pending-weapon');
  });
});

describe('Validation guards', () => {
  it('rejects all actions when match is finished', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight' })]);
    s.winner = 1;
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 1, col: 0, cost: 1 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('game-over');
  });

  it('does not mutate input state on success', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 0, col: 0 })]);
    const before = JSON.stringify(s);
    applyAction(s, { kind: 'move', unitId: 1, row: 1, col: 0, cost: 1 }, mulberry32(1));
    expect(JSON.stringify(s)).toBe(before);
  });

  it('does not mutate input state on failure', () => {
    const s = startState([mkUnit({ id: 1, player: 2, type: 'knight' })]);
    const before = JSON.stringify(s);
    applyAction(s, { kind: 'move', unitId: 1, row: 0, col: 1, cost: 1 }, mulberry32(1));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('gear — armour craft + equip', () => {
  // Кольчуга (ARMORS[0]): Дерево×1, Стрелы×1.
  function mailReady(units: SerializedUnit[]): GameState {
    const s = startState(units);
    s.units.forEach((u) => {
      if (u.player !== 1) return;
      u.backpack['Дерево'] = 1;
      u.backpack['Стрелы'] = 1;
    });
    return s;
  }

  it('craft-armor equips the crafter directly (no armor-slot conflict) and deducts parts', () => {
    const s = mailReady([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    const res = applyAction(s, { kind: 'craft-armor', unitId: 1, index: 0 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.pendingWeaponEquip).toBeNull();
    expect(res.value.units[0]!.armorGear).not.toBeNull();
    expect(res.value.units[0]!.backpack['Дерево']).toBe(0);
  });

  it('leaves crafted armour on the ground when the crafter already wears armour', () => {
    const knight = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: 5,
      col: 5,
      armorGear: { name: 'Латы', icon: '', amount: 4 },
    });
    const s = mailReady([knight]);
    const armorBefore = s.units[0]!.armor;
    const maxBefore = s.units[0]!.maxArmor;
    const crafted = applyAction(s, { kind: 'craft-armor', unitId: 1, index: 0 }, mulberry32(1));
    if (!crafted.ok) throw new Error('craft-armor failed');
    expect(crafted.value.pendingWeaponEquip).toBeNull();
    // The crafter's armour slot is taken, so the mail is left on its cell.
    expect(crafted.value.droppedBackpacks[0]!.armorGear!.name).toBe('Кольчуга');
    expect(crafted.value.units[0]!.armor).toBe(armorBefore);
    expect(crafted.value.units[0]!.maxArmor).toBe(maxBefore);
  });

  it('equipping a pending armour piece raises current and max armour and fills the slot', () => {
    const s = startState([mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 5 })]);
    s.pendingWeaponEquip = {
      name: 'Кольчуга',
      amount: 2,
      icon: 'armor_mail',
      allowedTypes: null,
      forbidTypes: null,
      archerOnly: false,
      slot: 'armor',
    };
    const armorBefore = s.units[0]!.armor;
    const maxBefore = s.units[0]!.maxArmor;
    const equipped = applyAction(s, { kind: 'equip-weapon', unitId: 2 }, mulberry32(1));
    if (!equipped.ok) throw new Error(`equip failed: ${equipped.error.code}`);
    const u = equipped.value.units.find((x) => x.id === 2)!;
    expect(u.armor).toBe(armorBefore + 2);
    expect(u.maxArmor).toBe(maxBefore + 2);
    expect(u.armorGear).not.toBeNull();
    expect(equipped.value.pendingWeaponEquip).toBeNull();
  });

  it('a unit may carry both a weapon and armour (separate slots)', () => {
    const knight = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: 5,
      col: 5,
      weapon: { name: 'Солнечный меч', icon: 'weapon_sword', amount: 3 },
    });
    const s = mailReady([knight]);
    const crafted = applyAction(s, { kind: 'craft-armor', unitId: 1, index: 0 }, mulberry32(1));
    if (!crafted.ok) throw new Error('craft-armor failed');
    const u = crafted.value.units[0]!;
    expect(u.weapon).not.toBeNull();
    expect(u.armorGear).not.toBeNull();
  });
});

describe('gear — drop on death + pickup on move', () => {
  it('a slain armed unit drops its whole backpack, which an ally picks up by stepping on the cell', () => {
    const attacker = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 });
    // Victim carries a sword and some parts, and is one hit from death (knight dmg 5 > armor 0).
    const victim = mkUnit({
      id: 2,
      player: 2,
      type: 'archer',
      row: 5,
      col: 6,
      hp: 1,
      armor: 0,
      weapon: { name: 'Солнечный меч', icon: 'weapon_sword', amount: 3 },
    });
    victim.backpack['Рубин'] = 2;
    const picker = mkUnit({ id: 3, player: 1, type: 'knight', row: 4, col: 6 });
    const s = startState([attacker, victim, picker]);

    const killed = applyAction(
      s,
      { kind: 'attack', unitId: 1, mode: 'shot', cost: 1, targetRow: 5, targetCol: 6, landingRow: 5, landingCol: 5 },
      mulberry32(1),
    );
    if (!killed.ok) throw new Error('attack failed');
    expect(killed.value.units.find((u) => u.id === 2)).toBeUndefined();
    expect(killed.value.droppedBackpacks).toHaveLength(1);
    expect(killed.value.droppedBackpacks[0]!.weapon!.name).toBe('Солнечный меч');
    expect(killed.value.droppedBackpacks[0]!.parts['Рубин']).toBe(2);

    const baseDamage = picker.damage;
    const moved = applyAction(
      killed.value,
      { kind: 'move', unitId: 3, row: 5, col: 6, cost: 1 },
      mulberry32(1),
    );
    if (!moved.ok) throw new Error(`move failed: ${moved.error.code}`);
    const grabber = moved.value.units.find((u) => u.id === 3)!;
    expect(grabber.weapon).not.toBeNull();
    expect(grabber.damage).toBe(baseDamage + 3);
    expect(grabber.backpack['Рубин']).toBe(2);
    expect(moved.value.droppedBackpacks).toHaveLength(0);
  });

  it('an incompatible unit walks over a drop without taking the weapon, but still takes the parts', () => {
    // Archer cannot wield the sword (forbidTypes) — the weapon stays put, parts don't.
    const s = startState([mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 })]);
    s.droppedBackpacks.push({
      row: 5,
      col: 6,
      parts: { ...s.units[0]!.backpack, 'Рубин': 1 },
      weapon: {
        name: 'Солнечный меч',
        amount: 3,
        icon: 'weapon_sword',
        allowedTypes: null,
        forbidTypes: ['archer', 'catapult', 'crossbow'],
        archerOnly: false,
      },
      armorGear: null,
    });
    const moved = applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 }, mulberry32(1));
    if (!moved.ok) throw new Error('move failed');
    expect(moved.value.units[0]!.weapon).toBeNull();
    expect(moved.value.units[0]!.backpack['Рубин']).toBe(1);
    expect(moved.value.droppedBackpacks).toHaveLength(1);
    expect(moved.value.droppedBackpacks[0]!.weapon).not.toBeNull();
    // Parts were fully collected — the leftover backpack carries none.
    expect(Object.values(moved.value.droppedBackpacks[0]!.parts).every((n) => n === 0)).toBe(true);
  });
});

describe('hidden pickups', () => {
  it('a unit that steps onto a buried weapon part collects it into its own backpack', () => {
    const knight = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 });
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [knight, mkUnit({ id: 2, player: 2, type: 'knight', row: 15, col: 15 })],
      hiddenPickups: [{ row: 5, col: 6, kind: 'part', name: 'Металл' }],
    });
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 }, mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.units.find((u) => u.id === 1)!.backpack['Металл']).toBe(1);
    // Nothing respawns: the cell is empty afterwards.
    expect(res.value.hiddenPickups).toHaveLength(0);
    expect(res.events.some((e) => e.kind === 'part-found')).toBe(true);
  });

  it('the finder wears buried gear it can equip', () => {
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [
        mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 }),
        mkUnit({ id: 2, player: 2, type: 'knight', row: 15, col: 15 }),
      ],
      hiddenPickups: [{ row: 5, col: 6, kind: 'weapon', name: 'Солнечный меч' }],
    });
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 }, mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.units.find((u) => u.id === 1)?.weapon?.name).toBe('Солнечный меч');
    expect(res.value.hiddenPickups).toHaveLength(0);
  });

  it('gear the finder cannot wear is left on the cell even if an ally could wear it', () => {
    // An archer cannot hold the sword, but the allied knight can.
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [
        mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 }),
        mkUnit({ id: 3, player: 1, type: 'knight', row: 7, col: 7 }),
        mkUnit({ id: 2, player: 2, type: 'knight', row: 15, col: 15 }),
      ],
      hiddenPickups: [{ row: 5, col: 6, kind: 'weapon', name: 'Солнечный меч' }],
    });
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 }, mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.units.find((u) => u.id === 1)?.weapon).toBeNull();
    expect(res.value.pendingWeaponEquip).toBeNull();
    expect(res.value.droppedBackpacks[0]!.weapon!.name).toBe('Солнечный меч');
    expect(res.value.hiddenPickups).toHaveLength(0);
  });

  it('gear nobody can wear is left lying on the cell', () => {
    // Only archers are present; none of them may hold the sword.
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [
        mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 }),
        mkUnit({ id: 2, player: 2, type: 'knight', row: 15, col: 15 }),
      ],
      hiddenPickups: [{ row: 5, col: 6, kind: 'weapon', name: 'Солнечный меч' }],
    });
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 }, mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.pendingWeaponEquip).toBeNull();
    expect(res.value.droppedBackpacks).toHaveLength(1);
    expect(res.value.droppedBackpacks[0]).toMatchObject({ row: 5, col: 6 });
    expect(res.value.droppedBackpacks[0]!.weapon!.name).toBe('Солнечный меч');
  });

  it('walking past a cell with nothing buried changes nothing', () => {
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [
        mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 }),
        mkUnit({ id: 2, player: 2, type: 'knight', row: 15, col: 15 }),
      ],
      hiddenPickups: [{ row: 9, col: 9, kind: 'part', name: 'Дерево' }],
    });
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 }, mulberry32(1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hiddenPickups).toHaveLength(1);
    expect(res.value.units.find((u) => u.id === 1)!.backpack['Дерево']).toBe(0);
  });
});

describe('applyAction — transfer-items', () => {
  it('hands parts from one adjacent ally to another for free (no move/activation cost)', () => {
    const giver = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5, movesLeft: 0, done: true });
    giver.backpack['Металл'] = 3;
    const taker = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 6 });
    const s = startState([giver, taker]);
    const res = applyAction(
      s,
      { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, parts: { 'Металл': 2 } },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const g = res.value.units.find((u) => u.id === 1)!;
    const t = res.value.units.find((u) => u.id === 2)!;
    expect(g.backpack['Металл']).toBe(1);
    expect(t.backpack['Металл']).toBe(2);
    // Free: the giver was already done/0 moves and stays that way — the
    // transfer didn't touch movesLeft/done/activatedCount on either side.
    expect(g.done).toBe(true);
    expect(g.movesLeft).toBe(0);
    expect(t.movesLeft).toBe(UNIT_TYPES.knight.moves);
    expect(res.value.activatedCount).toBe(0);
  });

  it('hands over a carried weapon, moving its damage bonus with it', () => {
    const giver = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: 5,
      col: 5,
      damage: UNIT_TYPES.knight.damage + 3, // already-equipped sword's bonus baked in, as applyCraft would leave it
      weapon: { name: 'Солнечный меч', icon: 'weapon_sword', amount: 3 },
    });
    const taker = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 6 });
    const s = startState([giver, taker]);
    const res = applyAction(s, { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, weapon: true }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const g = res.value.units.find((u) => u.id === 1)!;
    const t = res.value.units.find((u) => u.id === 2)!;
    expect(g.weapon).toBeNull();
    expect(g.damage).toBe(UNIT_TYPES.knight.damage);
    expect(t.weapon!.name).toBe('Солнечный меч');
    expect(t.damage).toBe(UNIT_TYPES.knight.damage + 3);
  });

  it('rejects when the units are not adjacent', () => {
    const giver = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 });
    giver.backpack['Металл'] = 1;
    const taker = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 9 });
    const s = startState([giver, taker]);
    const res = applyAction(
      s,
      { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, parts: { 'Металл': 1 } },
      mulberry32(1),
    );
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('not-adjacent');
  });

  it('rejects handing a weapon to a unit type that cannot wear it', () => {
    const giver = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: 5,
      col: 5,
      weapon: { name: 'Солнечный меч', icon: 'weapon_sword', amount: 3 },
    });
    const taker = mkUnit({ id: 2, player: 1, type: 'archer', row: 5, col: 6 });
    const s = startState([giver, taker]);
    const res = applyAction(s, { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, weapon: true }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('cannot-equip');
  });

  it('rejects transferring to/from an enemy unit', () => {
    const giver = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 });
    giver.backpack['Металл'] = 1;
    const enemy = mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 6 });
    const s = startState([giver, enemy]);
    const res = applyAction(
      s,
      { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, parts: { 'Металл': 1 } },
      mulberry32(1),
    );
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('wrong-turn');
  });

  it('rejects a transfer with nothing selected', () => {
    const giver = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 });
    const taker = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 6 });
    const s = startState([giver, taker]);
    const res = applyAction(s, { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('nothing-to-transfer');
  });

  it('a partial selection (checkbox picker: some parts + not the weapon/armour) moves only what was ticked', () => {
    // Giver carries several DIFFERENT kinds of items — multiple part types
    // plus a weapon and armour — mirroring the sidebar's checkbox picker
    // where each item is its own toggle. Only 'Металл' and the weapon are
    // ticked; 'Рубин' and the armour must stay behind untouched.
    const giver = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: 5,
      col: 5,
      damage: UNIT_TYPES.knight.damage + 3,
      armor: UNIT_TYPES.knight.armor + 2,
      maxArmor: UNIT_TYPES.knight.armor + 2,
      weapon: { name: 'Солнечный меч', icon: 'weapon_sword', amount: 3 },
      armorGear: { name: 'Кольчуга', icon: 'armor_mail', amount: 2 },
    });
    giver.backpack['Металл'] = 4;
    giver.backpack['Рубин'] = 2;
    const taker = mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 6 });
    const s = startState([giver, taker]);

    const res = applyAction(
      s,
      { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, parts: { 'Металл': 4 }, weapon: true },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const g = res.value.units.find((u) => u.id === 1)!;
    const t = res.value.units.find((u) => u.id === 2)!;

    // Ticked: all the Металл, and the weapon — both moved.
    expect(g.backpack['Металл']).toBe(0);
    expect(t.backpack['Металл']).toBe(4);
    expect(g.weapon).toBeNull();
    expect(t.weapon!.name).toBe('Солнечный меч');
    expect(t.damage).toBe(UNIT_TYPES.knight.damage + 3);

    // NOT ticked: Рубин and the armour stay with the giver untouched.
    expect(g.backpack['Рубин']).toBe(2);
    expect(t.backpack['Рубин']).toBe(0);
    expect(g.armorGear!.name).toBe('Кольчуга');
    expect(t.armorGear).toBeNull();
    expect(g.armor).toBe(UNIT_TYPES.knight.armor + 2);
  });

  it('a lone partial part transfer leaves the un-ticked remainder with the giver', () => {
    const giver = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 });
    giver.backpack['Дерево'] = 5;
    const taker = mkUnit({ id: 2, player: 1, type: 'archer', row: 5, col: 6 });
    const s = startState([giver, taker]);
    const res = applyAction(
      s,
      { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, parts: { 'Дерево': 2 } },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const g = res.value.units.find((u) => u.id === 1)!;
    const t = res.value.units.find((u) => u.id === 2)!;
    expect(g.backpack['Дерево']).toBe(3); // 5 - 2 ticked
    expect(t.backpack['Дерево']).toBe(2);
  });
});

describe('applyAction — build-tower / build-bridge', () => {
  it('a tower takes 2 turns (4 work units) — half-built after the first', () => {
    const knight = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 });
    const s = startState([knight]);
    const res = applyAction(s, { kind: 'build-tower', unitId: 1, row: 4, col: 5 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.towers).toHaveLength(0);
    const site = res.value.constructions.find((c) => c.row === 4 && c.col === 5);
    expect(site).toBeDefined();
    expect(site!.progress).toBe(2);
    expect(site!.kind).toBe('tower');
    const builder = res.value.units.find((u) => u.id === 1)!;
    expect(builder.movesLeft).toBe(0);
    expect(builder.done).toBe(true);
  });

  it('a second turn of work finishes the tower and it disappears from constructions', () => {
    let s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    const first = applyAction(s, { kind: 'build-tower', unitId: 1, row: 4, col: 5 }, mulberry32(1));
    if (!first.ok) throw new Error('first build failed');
    s = endTurn(first.value);
    s = endTurn(s); // back to player 1 with movesLeft refilled
    const second = applyAction(s, { kind: 'build-tower', unitId: 1, row: 4, col: 5 }, mulberry32(1));
    if (!second.ok) throw new Error(`second build failed: ${second.error.code}`);
    expect(second.value.constructions).toHaveLength(0);
    expect(second.value.towers).toContainEqual({ row: 4, col: 5 });
  });

  it('any other knight can continue an in-progress site another knight started', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 3, col: 5 }),
    ]);
    const first = applyAction(s, { kind: 'build-tower', unitId: 1, row: 4, col: 5 }, mulberry32(1));
    if (!first.ok) throw new Error('first build failed');
    const second = applyAction(first.value, { kind: 'build-tower', unitId: 2, row: 4, col: 5 }, mulberry32(1));
    if (!second.ok) throw new Error(`second build failed: ${second.error.code}`);
    expect(second.value.constructions).toHaveLength(0);
    expect(second.value.towers).toContainEqual({ row: 4, col: 5 });
  });

  it('rejects building with fewer than the full 2 moves', () => {
    const knight = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5, movesLeft: 1 });
    const s = startState([knight]);
    const res = applyAction(s, { kind: 'build-tower', unitId: 1, row: 4, col: 5 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('no-moves-left');
  });

  it('rejects a non-knight trying to build', () => {
    const archer = mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 });
    const s = startState([archer]);
    const res = applyAction(s, { kind: 'build-tower', unitId: 1, row: 4, col: 5 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('unit-cannot-act');
  });

  it('an unfinished tower site blocks movement, like a mountain', () => {
    const s0 = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })]);
    const built = applyAction(s0, { kind: 'build-tower', unitId: 1, row: 4, col: 5 }, mulberry32(1));
    if (!built.ok) throw new Error('build failed');
    const s = endTurn(built.value);
    const mover = mkUnit({ id: 9, player: 2, type: 'knight', row: 3, col: 5 });
    const s2: GameState = { ...s, units: [...s.units, mover] };
    const res = applyAction(s2, { kind: 'move', unitId: 9, row: 4, col: 5, cost: 1 }, mulberry32(1));
    if (res.ok) throw new Error('expected fail');
    expect(res.error.code).toBe('illegal-move');
  });

  it('a bridge can only be built on a river cell, and needs the target cell empty', () => {
    const knight = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 4 });
    const s = startState([knight]);
    s.terrain = [{ row: 5, col: 5, type: 'river' }];
    const res = applyAction(s, { kind: 'build-bridge', unitId: 1, row: 5, col: 5 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const site = res.value.constructions.find((c) => c.row === 5 && c.col === 5);
    expect(site!.kind).toBe('bridge');

    const s2 = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 4 })]);
    const badRes = applyAction(s2, { kind: 'build-bridge', unitId: 1, row: 5, col: 5 }, mulberry32(1));
    if (badRes.ok) throw new Error('expected fail');
    expect(badRes.error.code).toBe('not-river-cell');
  });

  it('a finished bridge gets BRIDGE_MAX_DURABILITY hit points and replaces the river cell', () => {
    let s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 4 })]);
    s.terrain = [{ row: 5, col: 5, type: 'river' }];
    const first = applyAction(s, { kind: 'build-bridge', unitId: 1, row: 5, col: 5 }, mulberry32(1));
    if (!first.ok) throw new Error('first build failed');
    s = endTurn(first.value);
    s = endTurn(s);
    const second = applyAction(s, { kind: 'build-bridge', unitId: 1, row: 5, col: 5 }, mulberry32(1));
    if (!second.ok) throw new Error(`second build failed: ${second.error.code}`);
    expect(second.value.terrain).toContainEqual({ row: 5, col: 5, type: 'bridge' });
    expect(second.value.bridgeDurability['5,5']).toBe(2);
  });
});

describe('applyAction — catapult vs bridge', () => {
  function bridgeState(): GameState {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'catapult', row: 5, col: 5 })]);
    s.terrain = [{ row: 5, col: 9, type: 'bridge' }];
    s.bridgeDurability = { '5,9': 2 };
    return s;
  }

  it('one hit knocks the bridge down to 1 hit point, still standing', () => {
    const s = bridgeState();
    const res = applyAction(
      s,
      { kind: 'attack', unitId: 1, mode: 'shot', cost: 1, targetRow: 5, targetCol: 9, landingRow: 5, landingCol: 5 },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.bridgeDurability['5,9']).toBe(1);
    expect(res.value.terrain).toContainEqual({ row: 5, col: 9, type: 'bridge' });
  });

  it('a second hit destroys the bridge — reverts to plain river', () => {
    let s = bridgeState();
    const first = applyAction(
      s,
      { kind: 'attack', unitId: 1, mode: 'shot', cost: 1, targetRow: 5, targetCol: 9, landingRow: 5, landingCol: 5 },
      mulberry32(1),
    );
    if (!first.ok) throw new Error('first hit failed');
    s = endTurn(first.value);
    s = endTurn(s);
    const second = applyAction(
      s,
      { kind: 'attack', unitId: 1, mode: 'shot', cost: 1, targetRow: 5, targetCol: 9, landingRow: 5, landingCol: 5 },
      mulberry32(1),
    );
    if (!second.ok) throw new Error(`second hit failed: ${second.error.code}`);
    expect(second.value.bridgeDurability['5,9']).toBeUndefined();
    expect(second.value.terrain).toContainEqual({ row: 5, col: 9, type: 'river' });
    expect(second.value.terrain).not.toContainEqual({ row: 5, col: 9, type: 'bridge' });
  });
});

describe('applyAction — mage-attack', () => {
  it('player-chosen damage: costs damage*1 + distance*1 energy', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 2, type: 'cavalry', row: 3, col: 4, hp: 10, maxHp: 10, armor: 0 }),
    ]);
    const res = applyAction(
      s,
      { kind: 'mage-attack', unitId: 1, targetRow: 3, targetCol: 4, damage: 6 },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const mage = res.value.units.find((u) => u.id === 1)!;
    const target = res.value.units.find((u) => u.id === 2)!;
    // Chebyshev distance from (0,0) to (3,4) is 4. cost = 6*1 + 4*1 = 10.
    expect(mage.energy).toBe(MAGE_MAX_ENERGY - 10);
    expect(target.hp).toBe(10 - 6);
    expect(mage.movesLeft).toBe(UNIT_TYPES.mage.moves - 1);
  });

  it('rejects when energy is insufficient for damage+distance', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0, energy: 2 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 10, col: 10 }),
    ]);
    const res = applyAction(
      s,
      { kind: 'mage-attack', unitId: 1, targetRow: 10, targetCol: 10, damage: 5 },
      mulberry32(1),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('no-energy');
  });

  it('rejects a non-positive damage amount', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 0, col: 1 }),
    ]);
    const res = applyAction(
      s,
      { kind: 'mage-attack', unitId: 1, targetRow: 0, targetCol: 1, damage: 0 },
      mulberry32(1),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('illegal-attack');
  });

  it('rejects attacking your own unit', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 1 }),
    ]);
    const res = applyAction(
      s,
      { kind: 'mage-attack', unitId: 1, targetRow: 0, targetCol: 1, damage: 5 },
      mulberry32(1),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('illegal-attack');
  });
});

describe('applyAction — mage-heal', () => {
  it('1 HP = 1 energy, plus 1 energy per cell of distance', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 2, col: 2, hp: 1 }), // missing 2 hp, distance 2
    ]);
    const res = applyAction(s, { kind: 'mage-heal', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const mage = res.value.units.find((u) => u.id === 1)!;
    const target = res.value.units.find((u) => u.id === 2)!;
    expect(target.hp).toBe(UNIT_TYPES.knight.hp);
    // cost = missingHp(2) * 1 + distance(2) * 1 = 4
    expect(mage.energy).toBe(MAGE_MAX_ENERGY - 4);
    expect(mage.movesLeft).toBe(UNIT_TYPES.mage.moves - 1);
  });

  it('costs more energy to heal the same amount from farther away', () => {
    const near = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 1, hp: 1 }),
    ]);
    const far = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 5, hp: 1 }),
    ]);
    const resNear = applyAction(near, { kind: 'mage-heal', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    const resFar = applyAction(far, { kind: 'mage-heal', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    if (!resNear.ok || !resFar.ok) throw new Error('expected both ok');
    const energyNear = resNear.value.units.find((u) => u.id === 1)!.energy!;
    const energyFar = resFar.value.units.find((u) => u.id === 1)!.energy!;
    expect(energyFar).toBeLessThan(energyNear);
  });

  it('can heal itself', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0, hp: 1 })]);
    const res = applyAction(s, { kind: 'mage-heal', unitId: 1, targetUnitId: 1 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const mage = res.value.units.find((u) => u.id === 1)!;
    expect(mage.hp).toBe(UNIT_TYPES.mage.hp);
  });

  it('rejects healing an enemy', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 0, col: 1, hp: 1 }),
    ]);
    const res = applyAction(s, { kind: 'mage-heal', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('no-heal-target');
  });

  it('rejects healing a target already at full hp', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 1 }),
    ]);
    const res = applyAction(s, { kind: 'mage-heal', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('already-full-hp');
  });

  it('rejects when energy is insufficient', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0, energy: 1 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 5, hp: 1 }),
    ]);
    const res = applyAction(s, { kind: 'mage-heal', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('no-energy');
  });

  it('non-mage units cannot use mage-heal', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 1, hp: 1 }),
    ]);
    const res = applyAction(s, { kind: 'mage-heal', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not-a-mage');
  });
});

describe('applyAction — mage-ward', () => {
  it('toggling an unwarded ally wards it, costs 1 move, costs NO energy up front', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 1 }),
    ]);
    const res = applyAction(s, { kind: 'mage-ward', unitId: 1, toggleUnitIds: [2] }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const mage = res.value.units.find((u) => u.id === 1)!;
    const knight = res.value.units.find((u) => u.id === 2)!;
    expect(knight.wardedBy).toBe(1);
    expect(mage.energy).toBe(MAGE_MAX_ENERGY); // no upfront cost
    expect(mage.movesLeft).toBe(UNIT_TYPES.mage.moves - 1);
  });

  it('toggling an already-warded ally removes its ward', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 1 }),
    ]);
    s.units.find((u) => u.id === 2)!.wardedBy = 1;
    const res = applyAction(s, { kind: 'mage-ward', unitId: 1, toggleUnitIds: [2] }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const knight = res.value.units.find((u) => u.id === 2)!;
    expect(knight.wardedBy).toBeNull();
  });

  it('one action can toggle several units at once, still costing exactly 1 move total', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 1 }),
      mkUnit({ id: 3, player: 1, type: 'archer', row: 0, col: 2 }),
    ]);
    const res = applyAction(s, { kind: 'mage-ward', unitId: 1, toggleUnitIds: [2, 3] }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.units.find((u) => u.id === 2)!.wardedBy).toBe(1);
    expect(res.value.units.find((u) => u.id === 3)!.wardedBy).toBe(1);
    expect(res.value.units.find((u) => u.id === 1)!.movesLeft).toBe(UNIT_TYPES.mage.moves - 1);
  });
});

describe('applyAction — mage-drain', () => {
  it('takes 1 hp from an adjacent unit and converts it to energy', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0, energy: 0 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 0, col: 1, armor: 0 }),
    ]);
    const res = applyAction(s, { kind: 'mage-drain', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const mage = res.value.units.find((u) => u.id === 1)!;
    const target = res.value.units.find((u) => u.id === 2)!;
    expect(target.hp).toBe(UNIT_TYPES.knight.hp - 1);
    expect(mage.energy).toBe(MAGE_DRAIN_ENERGY_PER_HP);
  });

  it('rejects draining a non-adjacent unit', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 5, col: 5 }),
    ]);
    const res = applyAction(s, { kind: 'mage-drain', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not-adjacent');
  });

  it('rejects draining a unit warded by a different mage', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 0, col: 1 }),
      mkUnit({ id: 3, player: 2, type: 'mage', row: 9, col: 9 }),
    ]);
    s.units.find((u) => u.id === 2)!.wardedBy = 3;
    const res = applyAction(s, { kind: 'mage-drain', unitId: 1, targetUnitId: 2 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('illegal-attack');
  });
});

describe('applyAction — mage-burn-bridge', () => {
  it('destroys a bridge outright at any distance, cost scales with distance', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 })]);
    s.terrain = [{ row: 4, col: 3, type: 'bridge' }];
    s.bridgeDurability = { '4,3': 2 };
    const res = applyAction(s, { kind: 'mage-burn-bridge', unitId: 1, row: 4, col: 3 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.bridgeDurability['4,3']).toBeUndefined();
    expect(res.value.terrain).toContainEqual({ row: 4, col: 3, type: 'river' });
    const mage = res.value.units.find((u) => u.id === 1)!;
    // Chebyshev distance 4 * MAGE_BURN_BRIDGE_ENERGY_PER_CELL(2) = 8
    expect(mage.energy).toBe(MAGE_MAX_ENERGY - 8);
  });

  it('rejects when there is no bridge at the given cell', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0 })]);
    const res = applyAction(s, { kind: 'mage-burn-bridge', unitId: 1, row: 4, col: 3 }, mulberry32(1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('no-bridge-here');
  });
});

describe('mage energy regenerates on its own turn', () => {
  it('endTurn adds MAGE_ENERGY_REGEN_PER_TURN, capped at maxEnergy', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 0, col: 0, energy: MAGE_MAX_ENERGY - 2 }),
      mkUnit({ id: 2, player: 2, type: 'mage', row: 10, col: 10, energy: 0 }),
    ]);
    // End player 1's turn (nothing regenerates for player 1 yet) then player 2's
    // turn ends and it becomes player 1's turn again — that's when player 1's
    // mage regenerates.
    let next = endTurn(s); // -> player 2's turn; player 2 regenerates now
    expect(next.units.find((u) => u.id === 2)!.energy).toBe(MAGE_ENERGY_REGEN_PER_TURN);
    next = endTurn(next); // -> player 1's turn; player 1 regenerates, capped at max
    expect(next.units.find((u) => u.id === 1)!.energy).toBe(MAGE_MAX_ENERGY);
  });
});

describe('throw-rock', () => {
  // Castles sit at col 8 by default, so col 0..7 mid-board is open ground.
  it('drops a boulder on an empty cell in range and spends a move', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 2 })]);
    const res = applyAction(s, { kind: 'throw-rock', unitId: 1, row: 10, col: 5 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.terrain.some((t) => t.row === 10 && t.col === 5 && t.type === 'rock')).toBe(true);
    expect(res.value.units[0]!.movesLeft).toBe(UNIT_TYPES.catapult.moves - 1);
  });

  it('shatters an existing boulder back to open ground', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 2 })]);
    s.terrain = [{ row: 10, col: 5, type: 'rock' }];
    const res = applyAction(s, { kind: 'throw-rock', unitId: 1, row: 10, col: 5 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.terrain).toHaveLength(0);
  });

  it('rejects the dead zone, castle approach, and non-catapults', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 2 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 12, col: 2 }),
    ]);
    const near = applyAction(s, { kind: 'throw-rock', unitId: 1, row: 10, col: 3 }, mulberry32(1));
    expect(near.ok).toBe(false);
    const gate = startState([mkUnit({ id: 1, player: 1, type: 'catapult', row: 2, col: 4 })]);
    const atGate = applyAction(gate, { kind: 'throw-rock', unitId: 1, row: 5, col: 8 }, mulberry32(1));
    expect(atGate.ok).toBe(false);
    const knight = applyAction(s, { kind: 'throw-rock', unitId: 2, row: 12, col: 6 }, mulberry32(1));
    expect(knight.ok).toBe(false);
  });

  it('cannot bury a construction site or dropped loot', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 2 })]);
    s.constructions = [{ row: 10, col: 5, kind: 'tower', progress: 2 }];
    s.droppedBackpacks = [
      { row: 11, col: 5, parts: { ...s.units[0]!.backpack, 'Дерево': 1 }, weapon: null, armorGear: null },
    ];
    expect(applyAction(s, { kind: 'throw-rock', unitId: 1, row: 10, col: 5 }, mulberry32(1)).ok).toBe(false);
    expect(applyAction(s, { kind: 'throw-rock', unitId: 1, row: 11, col: 5 }, mulberry32(1)).ok).toBe(false);
  });
});

describe('build — activation cap', () => {
  it('building uses one of the turn\'s activations', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 2 })]);
    const res = applyAction(s, { kind: 'build-tower', unitId: 1, row: 10, col: 3 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.activatedCount).toBe(1);
  });
});

describe('move validation', () => {
  it('rejects a teleport the move generator would never offer', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 0, col: 0 })]);
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 10, col: 5, cost: 1 }, mulberry32(1));
    if (res.ok) throw new Error('expected the teleport to be rejected');
    expect(res.error.code).toBe('illegal-move');
  });

  it('rejects a legal destination claimed at the wrong cost', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 })]);
    expect(applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 8, cost: 1 }, mulberry32(1)).ok).toBe(false);
    expect(applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 8, cost: 3 }, mulberry32(1)).ok).toBe(true);
  });

  it('cannot step off the bottom edge of the board', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 19, col: 5 })]);
    expect(applyAction(s, { kind: 'move', unitId: 1, row: 20, col: 5, cost: 1 }, mulberry32(1)).ok).toBe(false);
  });
});

describe('ward drops when its mage dies', () => {
  it('a mage killed in combat un-wards everyone it shielded', () => {
    const s = startState([
      mkUnit({ id: 1, player: 2, type: 'knight', row: 5, col: 4 }),
      mkUnit({ id: 2, player: 1, type: 'mage', row: 5, col: 5 }),
      mkUnit({ id: 3, player: 1, type: 'knight', row: 9, col: 9 }),
    ]);
    s.currentPlayer = 2;
    s.units.find((u) => u.id === 3)!.wardedBy = 2;
    const res = applyAction(
      s,
      { kind: 'attack', unitId: 1, mode: 'shot', cost: 1, targetRow: 5, targetCol: 5, landingRow: 5, landingCol: 4 },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.units.some((u) => u.id === 2)).toBe(false);
    expect(res.value.units.find((u) => u.id === 3)!.wardedBy).toBeNull();
  });

  it('a mage dying of ward overdraw un-wards every other unit too', () => {
    const s = startState([
      mkUnit({ id: 1, player: 2, type: 'knight', row: 5, col: 4 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 5, col: 5 }),
      mkUnit({ id: 3, player: 1, type: 'mage', row: 9, col: 9 }),
      mkUnit({ id: 4, player: 1, type: 'archer', row: 12, col: 12 }),
    ]);
    s.currentPlayer = 2;
    s.units.find((u) => u.id === 3)!.energy = 1; // can't cover a 5-damage hit
    s.units.find((u) => u.id === 2)!.wardedBy = 3;
    s.units.find((u) => u.id === 4)!.wardedBy = 3;
    const res = applyAction(
      s,
      { kind: 'attack', unitId: 1, mode: 'shot', cost: 1, targetRow: 5, targetCol: 5, landingRow: 5, landingCol: 4 },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.units.some((u) => u.id === 3)).toBe(false); // mage died
    const knight = res.value.units.find((u) => u.id === 2)!;
    expect(knight.hp).toBe(UNIT_TYPES.knight.hp); // hit still absorbed
    expect(knight.wardedBy).toBeNull();
    expect(res.value.units.find((u) => u.id === 4)!.wardedBy).toBeNull();
  });
});

describe('ward overdraw inside a pierce line', () => {
  it('a mage that died of overdraw is not hit again by the same bolt (no duplicate loot)', () => {
    // Crossbow (P2) at row 5 fires down: row 6 = warded P1 knight, row 7 = its mage.
    const s = startState([
      mkUnit({ id: 1, player: 2, type: 'crossbow', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 5 }),
      mkUnit({ id: 3, player: 1, type: 'mage', row: 7, col: 5 }),
    ]);
    s.currentPlayer = 2;
    const mage = s.units.find((u) => u.id === 3)!;
    mage.energy = 1;
    mage.backpack['Рубин'] = 1;
    s.units.find((u) => u.id === 2)!.wardedBy = 3;
    const res = applyAction(
      s,
      {
        kind: 'attack', unitId: 1, mode: 'pierce', cost: 2, targetRow: 6, targetCol: 5, landingRow: 5, landingCol: 5,
        targets: [{ row: 6, col: 5 }, { row: 7, col: 5 }],
      },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const kills = res.events.filter((e) => e.kind === 'unit-killed' && e.data['unitId'] === 3);
    expect(kills).toHaveLength(1);
    const rubies = res.value.droppedBackpacks.reduce((n, d) => n + (d.parts['Рубин'] ?? 0), 0);
    expect(rubies).toBe(1);
  });
});

describe('state left consistent after terrain/loot changes', () => {
  it('a cavalry jump claims loot buried on its landing cell (client parity)', () => {
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [
        mkUnit({ id: 1, player: 1, type: 'cavalry', row: 5, col: 5 }),
        mkUnit({ id: 2, player: 2, type: 'knight', row: 6, col: 5, hp: 9, armor: 9 }),
      ],
      hiddenPickups: [{ row: 7, col: 5, kind: 'part', name: 'Дерево' }],
    });
    const res = applyAction(
      s,
      { kind: 'attack', unitId: 1, mode: 'jump', cost: 2, targetRow: 6, targetCol: 5, landingRow: 7, landingCol: 5 },
      mulberry32(1),
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.units.find((u) => u.id === 1)!.backpack['Дерево']).toBe(1);
    expect(res.value.hiddenPickups).toHaveLength(0);
  });

  it('a mage cannot burn a bridge out from under a unit', () => {
    const s = startState([
      mkUnit({ id: 1, player: 1, type: 'mage', row: 2, col: 2 }),
      mkUnit({ id: 2, player: 2, type: 'knight', row: 4, col: 4 }),
    ]);
    s.terrain = [{ row: 4, col: 4, type: 'bridge' }];
    const res = applyAction(s, { kind: 'mage-burn-bridge', unitId: 1, row: 4, col: 4 }, mulberry32(1));
    if (res.ok) throw new Error('expected rejection');
    expect(res.error.code).toBe('cell-occupied');
  });
});

describe('destroyed bridge', () => {
  it('loot lying on a burned bridge sinks with it', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'mage', row: 2, col: 2 })]);
    s.terrain = [{ row: 4, col: 4, type: 'bridge' }];
    s.droppedBackpacks = [
      { row: 4, col: 4, parts: { ...s.units[0]!.backpack, 'Дерево': 2 }, weapon: null, armorGear: null },
    ];
    const res = applyAction(s, { kind: 'mage-burn-bridge', unitId: 1, row: 4, col: 4 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    expect(res.value.droppedBackpacks).toHaveLength(0);
    expect(res.value.terrain).toEqual([{ row: 4, col: 4, type: 'river' }]);
  });
});

describe('found gear goes into the right slot', () => {
  it('buried armour is worn as armour, not as a weapon', () => {
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [
        mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 }),
        mkUnit({ id: 2, player: 2, type: 'knight', row: 15, col: 15 }),
      ],
      hiddenPickups: [{ row: 5, col: 6, kind: 'armor', name: 'Кольчуга' }],
    });
    const res = applyAction(s, { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 }, mulberry32(1));
    if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
    const u = res.value.units.find((x) => x.id === 1)!;
    expect(u.armorGear?.name).toBe('Кольчуга');
    expect(u.weapon).toBeNull();
    expect(u.damage).toBe(UNIT_TYPES.knight.damage);
    expect(u.maxArmor).toBe(UNIT_TYPES.knight.armor + 2);
  });
});

describe('finished match', () => {
  it('end-turn after the winning move leaves the final state untouched', () => {
    const s = startState([mkUnit({ id: 1, player: 1, type: 'knight' })]);
    s.winner = 1;
    const res = applyAction(s, { kind: 'end-turn' }, mulberry32(1));
    if (!res.ok) throw new Error('end-turn should still be accepted');
    expect(res.value.currentPlayer).toBe(s.currentPlayer);
    expect(res.value.turnNumber).toBe(s.turnNumber);
  });
});
