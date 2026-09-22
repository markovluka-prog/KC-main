import type {
  LootEntry,
  PartName,
  RuinsArea,
  StartPosition,
  TowerPosition,
  UnitTypes,
  Weapon,
} from './types.js';

export const COLS = 20;
export const ROWS = 20;

/** Half-side of the archer's square attack zone. 2 → 5×5 grid, 1 → 3×3 grid. */
export const ARCHER_SQUARE_RADIUS = 2;

/**
 * Ranged units (archer, crossbow, catapult) standing on a mage tower shoot
 * roughly 1.5× further — high ground. Applied to ARCHER_SQUARE_RADIUS and to
 * CATAPULT_MAX_RANGE, rounded so the bonus is always a whole cell.
 */
export const TOWER_RANGE_MULTIPLIER = 1.5;

/** Archer/crossbow square radius when shooting from a tower (2 → 3). */
export const ARCHER_SQUARE_RADIUS_TOWER = Math.round(
  ARCHER_SQUARE_RADIUS * TOWER_RANGE_MULTIPLIER,
);

export const SAVE_KEY = 'knights_and_castles_save_v1';
// v4: per-unit backpacks replace the shared artifact inventory, common spells
// are gone, and the mage's energy/warding fields appear on SerializedUnit.
export const SAVE_VERSION = 4;

/**
 * Mage energy — its own resource, separate from movesLeft. Every one of its
 * 4 abilities (attack/ward/burn-bridge/heal) costs exactly 1 move but ALSO an
 * energy amount that scales with what it's doing (see apply.ts's mage-*
 * actions). Regenerates +5 at the start of the mage's own turn.
 */
export const MAGE_MAX_ENERGY = 20;
export const MAGE_ENERGY_REGEN_PER_TURN = 5;
/**
 * Mage attack: the player picks how much damage to deal (>=1) — no longer a
 * fixed amount. Cost = chosenDamage * MAGE_ATTACK_ENERGY_PER_HP + distance *
 * MAGE_ATTACK_ENERGY_PER_CELL, same "1 energy per point, plus distance"
 * shape as mage-heal. MAGE_ATTACK_DAMAGE is kept only as a UI default.
 */
export const MAGE_ATTACK_DAMAGE = 5;
export const MAGE_ATTACK_ENERGY_PER_HP = 1;
export const MAGE_ATTACK_ENERGY_PER_CELL = 1;
/**
 * Ward: 1-to-1 — absorbing a hit costs the warding mage exactly that many
 * energy points (5 damage absorbed → 5 energy spent). See
 * [[kc-mage-ward-mechanic]] and apply.ts's absorbWithWard.
 */
export const MAGE_WARD_ENERGY_PER_DAMAGE = 1;
/** Draining an ally/unwarded enemy standing adjacent: 1 HP taken → this much energy gained. */
export const MAGE_DRAIN_ENERGY_PER_HP = 5;
/** Burning a bridge: energy cost = Chebyshev distance × this factor. Any distance, one shot destroys it outright. */
export const MAGE_BURN_BRIDGE_ENERGY_PER_CELL = 2;
/**
 * Heal: restores HP to one unit (self or an ally) at any Chebyshev distance.
 * Base cost is 1 energy per HP restored (1 HP = 1 energy); range then adds
 * its own cost on top, same shape as mage-attack/mage-burn-bridge — 1 energy
 * per cell of Chebyshev distance to the target. A mage standing next to its
 * target (distance 1) pays only the HP cost; healing from across the board
 * costs steadily more on top of that, so distance always matters.
 */
export const MAGE_HEAL_ENERGY_PER_HP = 1;
export const MAGE_HEAL_ENERGY_PER_CELL = 1;

/**
 * Building a tower or bridge: a knight stands still and spends ALL its
 * movesLeft on the site each of its own turns. Total work needed to finish
 * ("4 work units, 2 turns of a 2-move knight") — see BUILD_COST_PER_TURN,
 * the per-activation cost this action deducts.
 */
export const BUILD_WORK_TOTAL = 4;
/** Building a knight's own moves cost per turn — matches UNIT_TYPES.knight.moves. */
export const BUILD_COST_PER_TURN = 2;
/** A freshly built (or map-generated, if any ever are) bridge's starting durability. */
export const BRIDGE_MAX_DURABILITY = 2;

/** Weapon parts — the crafting currency, replacing the old artifact set. */
export const PARTS: readonly PartName[] = ['Металл', 'Амулет', 'Рубин', 'Дерево', 'Стрелы'] as const;

export const PART_COLORS: Record<PartName, string> = {
  'Металл': '#b9c2cc',
  'Амулет': '#dfb2ff',
  'Рубин': '#ff5f6d',
  'Дерево': '#a9784a',
  'Стрелы': '#8fdd7f',
};

export const PART_IMAGES: Record<PartName, string> = {
  'Металл': 'part_metal',
  'Амулет': 'part_amulet',
  'Рубин': 'part_ruby',
  'Дерево': 'part_wood',
  'Стрелы': 'part_arrows',
};

/** A fresh, all-zero backpack — every unit starts carrying no parts. */
export function emptyBackpack(): Record<PartName, number> {
  const b = {} as Record<PartName, number>;
  for (const p of PARTS) b[p] = 0;
  return b;
}

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

export const HIDDEN_PICKUP_SPAWN: readonly PickupSpawnEntry[] = [
  // Weapon parts — ~1.5% of the board, split by rarity.
  { kind: 'part', name: 'Дерево', percent: 0.45 },
  { kind: 'part', name: 'Металл', percent: 0.3 },
  { kind: 'part', name: 'Амулет', percent: 0.3 },
  { kind: 'part', name: 'Рубин', percent: 0.2 },
  { kind: 'part', name: 'Стрелы', percent: 0.2 },
  // Gear — 1 of each per match. Anything below 0.25% rounds to zero cells on a
  // 20×20 board, which would remove gear from the game entirely.
  { kind: 'weapon', name: 'Солнечный меч', percent: 0.25 },
  { kind: 'weapon', name: 'Синий лук', percent: 0.25 },
  { kind: 'armor', name: 'Кольчуга', percent: 0.25 },
  { kind: 'armor', name: 'Латы', percent: 0.25 },
];

// Loot odds (weights sum to 100): nothing 40%, parts 15%, weapon 15%,
// armour 30%.
export const RUINS_LOOT_TABLE: readonly LootEntry[] = [
  { type: 'nothing', weight: 40 },
  // Weapon parts — 15% total, split by rarity.
  { type: 'part', name: 'Дерево', weight: 5 },
  { type: 'part', name: 'Металл', weight: 3 },
  { type: 'part', name: 'Амулет', weight: 3 },
  { type: 'part', name: 'Рубин', weight: 2 },
  { type: 'part', name: 'Стрелы', weight: 2 },
  // Weapons — 15% total.
  { type: 'weapon', name: 'Солнечный меч', weight: 8 },
  { type: 'weapon', name: 'Синий лук', weight: 7 },
  // Armour — 30% total (lighter mail more common than heavy plate).
  { type: 'armor', name: 'Кольчуга', weight: 20 },
  { type: 'armor', name: 'Латы', weight: 10 },
];

export const UNIT_TYPES: UnitTypes = {
  knight: {
    name: 'Рыцарь',
    hp: 3,
    damage: 5,
    armor: 4,
    moves: 2,
    frame: 192,
    letter: 'K',
  },
  cavalry: {
    name: 'Конный',
    hp: 5,
    damage: 6,
    armor: 3,
    moves: 3,
    frame: 320,
    letter: 'L',
  },
  archer: {
    name: 'Лучник',
    hp: 3,
    // D1 (Phase 1 plan): archer damage is the canonical value; UI rules text in
    // index.html уже исправлен в T13 на «⚔ 3».
    damage: 3,
    armor: 1,
    moves: 3,
    frame: 192,
    letter: 'A',
  },
  catapult: {
    name: 'Катапульта',
    hp: 2,
    damage: 7,
    armor: 1,
    moves: 2,
    frame: 192,
    letter: 'P',
  },
  crossbow: {
    name: 'Арбалетчик',
    hp: 3,
    damage: 5,
    armor: 2,
    moves: 2,
    frame: 192,
    letter: 'X',
  },
  samurai: {
    name: 'Самурай',
    hp: 2,
    damage: 5,
    armor: 1,
    moves: 3,
    frame: 192,
    letter: 'S',
  },
  mage: {
    name: 'Боевой маг',
    hp: 2,
    damage: 0, // damage comes entirely from the energy-costed 'mage-attack' action, not a plain melee/ranged hit
    armor: 0,
    moves: 2,
    frame: 192,
    letter: 'M',
  },
};

/**
 * Craftable weapons/armour. Recipes are written in weapon parts (see
 * PartName) — the old common-spell system (Дождь защиты/Сталь свободы/Небо
 * огня) is gone entirely; only the mage's own 4 abilities exist now (see
 * apply.ts's mage-* actions). Recipes below mirror the old artifact-costed
 * ones 1:1, remapped: Трава С.→Дерево, Посох огня→Металл, Волшебная
 * палочка→Амулет, Солнечные часы→Рубин, Вода серебряных трав→Стрелы.
 */
export const WEAPONS: readonly Weapon[] = [
  {
    name: 'Солнечный меч',
    recipe: {
      'Металл': 2,
      'Амулет': 1,
      'Рубин': 1,
    },
    desc: '+3 урона выбранному юниту',
    amount: 3,
    icon: 'weapon_sword',
    forbidTypes: ['archer', 'catapult', 'crossbow'],
    archerOnly: false,
    slot: 'weapon',
  },
  {
    name: 'Синий лук',
    recipe: {
      'Стрелы': 2,
      'Дерево': 2,
      'Металл': 1,
      'Амулет': 1,
    },
    desc: '+2 урона лучнику',
    amount: 2,
    icon: 'weapon_bow',
    allowedTypes: ['archer', 'crossbow'],
    archerOnly: true,
    slot: 'weapon',
  },
];

/**
 * Craftable / lootable armour. Equipping raises both the unit's current armour
 * and its max armour by `amount` (so castle restoration accounts for it).
 * Like weapons it occupies a single slot per unit — a unit can carry one
 * weapon and one piece of armour.
 */
export const ARMORS: readonly Weapon[] = [
  {
    name: 'Кольчуга',
    recipe: {
      'Дерево': 1,
      'Стрелы': 1,
    },
    desc: '+2 брони выбранному юниту',
    amount: 2,
    icon: 'armor_mail',
    archerOnly: false,
    slot: 'armor',
  },
  {
    name: 'Латы',
    recipe: {
      'Металл': 1,
      'Рубин': 1,
      'Стрелы': 1,
    },
    desc: '+4 брони выбранному юниту',
    amount: 4,
    icon: 'armor_plate',
    // Heavy plate is too cumbersome for ranged units.
    forbidTypes: ['archer', 'crossbow', 'catapult'],
    archerOnly: false,
    slot: 'armor',
  },
];

/**
 * Mage towers no longer exist as a fixed match-start feature — towers are
 * now an ordinary structure knights build themselves (see BUILD_WORK_TOTAL).
 * Kept as an empty array (not deleted) purely as the fallback default for
 * `world.ts`/`save.ts` callers that expect a TowerPosition[] to exist.
 */
export const DEFAULT_TOWERS: readonly TowerPosition[] = [];

export const DEFAULT_RUINS: RuinsArea = {
  top: 9,
  left: 9,
  width: 2,
  height: 2,
};

export const DEFAULT_CASTLE_P1_COL = 8;
export const DEFAULT_CASTLE_P2_COL = 8;

export const START_POSITIONS_P1: readonly StartPosition[] = [
  { type: 'cavalry', row: 3, col: 1 },
  { type: 'cavalry', row: 3, col: 2 },
  { type: 'knight', row: 1, col: 0 },
  { type: 'knight', row: 1, col: 3 },
  { type: 'knight', row: 2, col: 0 },
  { type: 'knight', row: 2, col: 3 },
  { type: 'knight', row: 0, col: 0 },
  { type: 'archer', row: 0, col: 1 },
  { type: 'archer', row: 0, col: 2 },
  { type: 'knight', row: 0, col: 3 },
  // The mage is a base roster unit now, same footing as knight/archer/
  // cavalry — not an exotic pick reserved for one faction preset.
  { type: 'mage', row: 2, col: 1 },
];
