// AUTO-VENDORED from packages/game-rules/src/combat.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
import { applyFacingDamage } from './facing.ts';
import type { CombatContext, UnitState, UnitTypeKey } from './types.ts';

/**
 * Damage multiplier for a ranged unit firing from a mage tower. The tower buys
 * ~1.5× range, and this is what it costs: shots hit for roughly two thirds.
 */
export const TOWER_DAMAGE_FACTOR = 0.65;

function isRangedType(type: UnitTypeKey): boolean {
  return type === 'archer' || type === 'crossbow' || type === 'catapult';
}

/**
 * Computes the damage *value* that an attacker would deliver, after buffs and
 * shields are applied but **before** armor absorption.
 *
 * Mirrors the buff/shield/archer-floor logic that exists in both
 * `computeDamage` and `performAttack` in the legacy index.html.
 */
export function attackDamage(attacker: UnitState, target: UnitState, ctx: CombatContext): number {
  let damage = attacker.damage;

  // Tower trade-off: a ranged unit on a mage tower shoots ~1.5× further, so its
  // shots land weaker. Applied before buffs so the penalty can't be multiplied
  // away, and floored at 1 so a tower never makes an attack useless.
  if (ctx.attackerOnTower && isRangedType(attacker.type)) {
    damage = Math.max(1, Math.round(damage * TOWER_DAMAGE_FACTOR));
  }

  if (ctx.damageBuff[attacker.player] > 0) {
    damage += 2;
  }

  if (ctx.shieldTurns[target.player] > 0) {
    damage = Math.max(0, damage - 2);
  }

  // From the target's back ×2, side ×1.25 (facing.ts), measured from where
  // the attacker strikes.
  damage = applyFacingDamage(damage, target, attacker.row, attacker.col);

  // Archers always deliver at least 1 damage if their base damage > 0
  // (arrows pierce armor).
  if (
    (attacker.type === 'archer' || attacker.type === 'crossbow') &&
    damage === 0 &&
    attacker.damage > 0
  ) {
    damage = 1;
  }

  return damage;
}

/**
 * Applies `damage` against `target` using the two-layer model:
 *   1. damage is absorbed by armor first;
 *   2. remainder spills into hp.
 *
 * Mutates `target` and returns details for animation / score code.
 */
export function applyDamageToTarget(
  target: UnitState,
  damage: number,
): { damageToHp: number; armorAbsorbed: number } {
  let damageToHp = 0;
  let armorAbsorbed = 0;

  if (damage > target.armor) {
    armorAbsorbed = target.armor;
    damageToHp = damage - target.armor;
    target.armor = 0;
  } else {
    armorAbsorbed = damage;
    target.armor -= damage;
  }

  target.hp -= damageToHp;
  return { damageToHp, armorAbsorbed };
}

/**
 * Legacy `computeDamage` contract for use by AI heuristics:
 * returns the same number that the original code returned — equal to the raw
 * damage if the attack pierces armor, otherwise 0.
 *
 * Note: this value is **not** the HP loss; it is the heuristic used by the AI
 * to compare candidate moves. The original implementation has a quirk where
 * this returns `damage` (not `damage - armor`) when piercing — preserved here
 * to avoid silently shifting AI behaviour.
 */
export function computeDamage(attacker: UnitState, target: UnitState, ctx: CombatContext): number {
  const damage = attackDamage(attacker, target, ctx);
  if (damage > target.armor) {
    return damage;
  }
  return 0;
}
