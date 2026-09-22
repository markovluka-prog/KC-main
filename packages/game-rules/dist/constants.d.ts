import type { LootEntry, PartName, RuinsArea, StartPosition, TowerPosition, UnitTypes, Weapon } from './types.js';
export declare const COLS = 20;
export declare const ROWS = 20;
/** Half-side of the archer's square attack zone. 2 → 5×5 grid, 1 → 3×3 grid. */
export declare const ARCHER_SQUARE_RADIUS = 2;
/**
 * Ranged units (archer, crossbow, catapult) standing on a mage tower shoot
 * roughly 1.5× further — high ground. Applied to ARCHER_SQUARE_RADIUS and to
 * CATAPULT_MAX_RANGE, rounded so the bonus is always a whole cell.
 */
export declare const TOWER_RANGE_MULTIPLIER = 1.5;
/** Archer/crossbow square radius when shooting from a tower (2 → 3). */
export declare const ARCHER_SQUARE_RADIUS_TOWER: number;
export declare const SAVE_KEY = "knights_and_castles_save_v1";
export declare const SAVE_VERSION = 4;
/**
 * Mage energy — its own resource, separate from movesLeft. Every one of its
 * 4 abilities (attack/ward/burn-bridge/heal) costs exactly 1 move but ALSO an
 * energy amount that scales with what it's doing (see apply.ts's mage-*
 * actions). Regenerates +5 at the start of the mage's own turn.
 */
export declare const MAGE_MAX_ENERGY = 20;
export declare const MAGE_ENERGY_REGEN_PER_TURN = 5;
/**
 * Mage attack: the player picks how much damage to deal (>=1) — no longer a
 * fixed amount. Cost = chosenDamage * MAGE_ATTACK_ENERGY_PER_HP + distance *
 * MAGE_ATTACK_ENERGY_PER_CELL, same "1 energy per point, plus distance"
 * shape as mage-heal. MAGE_ATTACK_DAMAGE is kept only as a UI default.
 */
export declare const MAGE_ATTACK_DAMAGE = 5;
export declare const MAGE_ATTACK_ENERGY_PER_HP = 1;
export declare const MAGE_ATTACK_ENERGY_PER_CELL = 1;
/**
 * Ward: 1-to-1 — absorbing a hit costs the warding mage exactly that many
 * energy points (5 damage absorbed → 5 energy spent). See
 * [[kc-mage-ward-mechanic]] and apply.ts's absorbWithWard.
 */
export declare const MAGE_WARD_ENERGY_PER_DAMAGE = 1;
/** Draining an ally/unwarded enemy standing adjacent: 1 HP taken → this much energy gained. */
export declare const MAGE_DRAIN_ENERGY_PER_HP = 5;
/** Burning a bridge: energy cost = Chebyshev distance × this factor. Any distance, one shot destroys it outright. */
export declare const MAGE_BURN_BRIDGE_ENERGY_PER_CELL = 2;
/**
 * Heal: restores HP to one unit (self or an ally) at any Chebyshev distance.
 * Base cost is 1 energy per HP restored (1 HP = 1 energy); range then adds
 * its own cost on top, same shape as mage-attack/mage-burn-bridge — 1 energy
 * per cell of Chebyshev distance to the target. A mage standing next to its
 * target (distance 1) pays only the HP cost; healing from across the board
 * costs steadily more on top of that, so distance always matters.
 */
export declare const MAGE_HEAL_ENERGY_PER_HP = 1;
export declare const MAGE_HEAL_ENERGY_PER_CELL = 1;
/**
 * Building a tower or bridge: a knight stands still and spends ALL its
 * movesLeft on the site each of its own turns. Total work needed to finish
 * ("4 work units, 2 turns of a 2-move knight") — see BUILD_COST_PER_TURN,
 * the per-activation cost this action deducts.
 */
export declare const BUILD_WORK_TOTAL = 4;
/** Building a knight's own moves cost per turn — matches UNIT_TYPES.knight.moves. */
export declare const BUILD_COST_PER_TURN = 2;
/** A freshly built (or map-generated, if any ever are) bridge's starting durability. */
export declare const BRIDGE_MAX_DURABILITY = 2;
/** Weapon parts — the crafting currency, replacing the old artifact set. */
export declare const PARTS: readonly PartName[];
export declare const PART_COLORS: Record<PartName, string>;
export declare const PART_IMAGES: Record<PartName, string>;
/** A fresh, all-zero backpack — every unit starts carrying no parts. */
export declare function emptyBackpack(): Record<PartName, number>;
/**
 * Hidden-pickup scatter. Replaces the old searchable ruins: at match setup each
 * entry is buried on its own share of the board's cells (rarer things cover
 * fewer cells). `percent` is a percentage of all ROWS×COLS cells — ~1.9% of the
 * board carries something, of which gear is only ~1%.
 *
 * Nothing respawns and nothing is visible: a unit that steps on the cell simply
 * collects it. Cells occupied by starting knights, castles and towers are
 * excluded at scatter time (see setup.ts).
 */
export interface PickupSpawnEntry {
    kind: 'part' | 'weapon' | 'armor';
    name: string;
    percent: number;
}
export declare const HIDDEN_PICKUP_SPAWN: readonly PickupSpawnEntry[];
export declare const RUINS_LOOT_TABLE: readonly LootEntry[];
export declare const UNIT_TYPES: UnitTypes;
/**
 * Craftable weapons/armour. Recipes are written in weapon parts (see
 * PartName) — the old common-spell system (Дождь защиты/Сталь свободы/Небо
 * огня) is gone entirely; only the mage's own 4 abilities exist now (see
 * apply.ts's mage-* actions). Recipes below mirror the old artifact-costed
 * ones 1:1, remapped: Трава С.→Дерево, Посох огня→Металл, Волшебная
 * палочка→Амулет, Солнечные часы→Рубин, Вода серебряных трав→Стрелы.
 */
export declare const WEAPONS: readonly Weapon[];
/**
 * Craftable / lootable armour. Equipping raises both the unit's current armour
 * and its max armour by `amount` (so castle restoration accounts for it).
 * Like weapons it occupies a single slot per unit — a unit can carry one
 * weapon and one piece of armour.
 */
export declare const ARMORS: readonly Weapon[];
/**
 * Mage towers no longer exist as a fixed match-start feature — towers are
 * now an ordinary structure knights build themselves (see BUILD_WORK_TOTAL).
 * Kept as an empty array (not deleted) purely as the fallback default for
 * `world.ts`/`save.ts` callers that expect a TowerPosition[] to exist.
 */
export declare const DEFAULT_TOWERS: readonly TowerPosition[];
export declare const DEFAULT_RUINS: RuinsArea;
export declare const DEFAULT_CASTLE_P1_COL = 8;
export declare const DEFAULT_CASTLE_P2_COL = 8;
export declare const START_POSITIONS_P1: readonly StartPosition[];
//# sourceMappingURL=constants.d.ts.map