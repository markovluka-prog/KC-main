import { describe, expect, it } from 'vitest';
import { applyDamageToTarget, attackDamage, computeDamage } from '../combat.js';
import { UNIT_TYPES } from '../constants.js';
import type { CombatContext, Player, UnitState, UnitTypeKey } from '../types.js';

function makeUnit(player: Player, type: UnitTypeKey, hp?: number, armor?: number): UnitState {
  const t = UNIT_TYPES[type];
  return {
    id: 1,
    player,
    type,
    row: 0,
    col: 0,
    hp: hp ?? t.hp,
    armor: armor ?? t.armor,
    damage: t.damage,
    maxMoves: t.moves,
    movesLeft: t.moves,
    name: t.name,
  };
}

function defaultCtx(): CombatContext {
  return {
    damageBuff: { 1: 0, 2: 0 },
    shieldTurns: { 1: 0, 2: 0 },
  };
}

describe('UNIT_TYPES (FUNC-004)', () => {
  it('archer damage canonical value is 3 (UI rules text was synced to match)', () => {
    expect(UNIT_TYPES.archer.damage).toBe(3);
  });

  it('archer / knight / cavalry have the expected baseline stats', () => {
    expect(UNIT_TYPES.knight).toMatchObject({ hp: 3, damage: 5, armor: 4, moves: 2 });
    expect(UNIT_TYPES.cavalry).toMatchObject({ hp: 5, damage: 6, armor: 3, moves: 3 });
    expect(UNIT_TYPES.archer).toMatchObject({ hp: 3, damage: 3, armor: 1, moves: 3 });
  });
});

describe('attackDamage', () => {
  it('uses raw attacker damage with no buffs/shields', () => {
    const att = makeUnit(1, 'knight');
    const def = makeUnit(2, 'archer');
    expect(attackDamage(att, def, defaultCtx())).toBe(UNIT_TYPES.knight.damage);
  });

  it('applies +2 damage buff (Небо огня) when active', () => {
    const ctx = defaultCtx();
    ctx.damageBuff[1] = 1;
    const att = makeUnit(1, 'knight');
    const def = makeUnit(2, 'archer');
    expect(attackDamage(att, def, ctx)).toBe(UNIT_TYPES.knight.damage + 2);
  });

  it('subtracts 2 when defender has active shield', () => {
    const ctx = defaultCtx();
    ctx.shieldTurns[2] = 1;
    const att = makeUnit(1, 'cavalry');
    const def = makeUnit(2, 'knight');
    expect(attackDamage(att, def, ctx)).toBe(UNIT_TYPES.cavalry.damage - 2);
  });

  it('archer always lands at least 1 damage when base damage > 0', () => {
    const ctx = defaultCtx();
    ctx.shieldTurns[2] = 1;
    // archer base damage 3 - shield 2 = 1 (still positive). Make a stronger
    // shield scenario by also stacking with a contrived case where computed
    // damage would otherwise hit 0.
    const att = { ...makeUnit(1, 'archer'), damage: 2 };
    const def = makeUnit(2, 'knight');
    // 2 - 2 (shield) = 0 → archer minimum kicks in to 1.
    expect(attackDamage(att, def, ctx)).toBe(1);
  });
});

describe('applyDamageToTarget', () => {
  it('absorbs damage entirely in armor when damage <= armor', () => {
    const target = makeUnit(2, 'knight'); // armor 4
    const { damageToHp, armorAbsorbed } = applyDamageToTarget(target, 3);
    expect(damageToHp).toBe(0);
    expect(armorAbsorbed).toBe(3);
    expect(target.armor).toBe(1);
    expect(target.hp).toBe(UNIT_TYPES.knight.hp);
  });

  it('splits damage across armor and hp when damage > armor', () => {
    const target = makeUnit(2, 'cavalry'); // armor 3, hp 5
    const { damageToHp, armorAbsorbed } = applyDamageToTarget(target, 7);
    expect(armorAbsorbed).toBe(3);
    expect(damageToHp).toBe(4);
    expect(target.armor).toBe(0);
    expect(target.hp).toBe(1);
  });

  it('kills target when damage exceeds armor + hp', () => {
    const target = makeUnit(2, 'archer'); // armor 1, hp 3
    applyDamageToTarget(target, 100);
    expect(target.hp).toBeLessThanOrEqual(0);
  });
});

describe('computeDamage (legacy AI heuristic contract)', () => {
  it('returns full damage value when attack pierces armor', () => {
    const att = makeUnit(1, 'cavalry'); // damage 6
    const def = makeUnit(2, 'archer'); // armor 1
    expect(computeDamage(att, def, defaultCtx())).toBe(UNIT_TYPES.cavalry.damage);
  });

  it('returns 0 when armor absorbs everything', () => {
    const att = makeUnit(1, 'archer'); // damage 3
    const def = makeUnit(2, 'knight'); // armor 4
    expect(computeDamage(att, def, defaultCtx())).toBe(0);
  });
});
