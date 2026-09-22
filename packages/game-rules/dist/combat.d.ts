import type { CombatContext, UnitState } from './types.js';
/**
 * Damage multiplier for a ranged unit firing from a mage tower. The tower buys
 * ~1.5× range, and this is what it costs: shots hit for roughly two thirds.
 */
export declare const TOWER_DAMAGE_FACTOR = 0.65;
/**
 * Computes the damage *value* that an attacker would deliver, after buffs and
 * shields are applied but **before** armor absorption.
 *
 * Mirrors the buff/shield/archer-floor logic that exists in both
 * `computeDamage` and `performAttack` in the legacy index.html.
 */
export declare function attackDamage(attacker: UnitState, target: UnitState, ctx: CombatContext): number;
/**
 * Applies `damage` against `target` using the two-layer model:
 *   1. damage is absorbed by armor first;
 *   2. remainder spills into hp.
 *
 * Mutates `target` and returns details for animation / score code.
 */
export declare function applyDamageToTarget(target: UnitState, damage: number): {
    damageToHp: number;
    armorAbsorbed: number;
};
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
export declare function computeDamage(attacker: UnitState, target: UnitState, ctx: CombatContext): number;
//# sourceMappingURL=combat.d.ts.map