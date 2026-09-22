// AUTO-VENDORED from packages/game-rules/src/constants.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
import type {
  ArtifactName,
  LootEntry,
  RuinsArea,
  Spell,
  StartPosition,
  TowerPosition,
  UnitTypes,
  Weapon,
} from './types.ts';

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
export const SAVE_VERSION = 3;

export const ARTIFACTS: readonly ArtifactName[] = [
  'Трава С.',
  'Посох огня',
  'Волшебная палочка',
  'Солнечные часы',
  'Вода серебряных трав',
] as const;

export const ARTIFACT_COLORS: Record<ArtifactName, string> = {
  'Трава С.': '#8fdd7f',
  'Посох огня': '#ff8d62',
  'Волшебная палочка': '#dfb2ff',
  'Солнечные часы': '#ffe281',
  'Вода серебряных трав': '#85c9ff',
};

export const ARTIFACT_IMAGES: Record<ArtifactName, string> = {
  'Трава С.': 'artifact_grass',
  'Посох огня': 'artifact_fire_staff',
  'Волшебная палочка': 'artifact_wand',
  'Солнечные часы': 'artifact_sundial',
  'Вода серебряных трав': 'artifact_silver_water',
};

/**
 * Hidden-pickup scatter. Replaces the old searchable ruins: at match setup each
 * entry is buried on its own share of the board's cells (rarer things cover
 * fewer cells). `percent` is a percentage of all ROWS×COLS cells — ~14% of the
 * board carries something, of which gear is only ~3%.
 *
 * Nothing respawns and nothing is visible: a unit that steps on the cell simply
 * collects it. Cells occupied by starting knights, castles and towers are
 * excluded at scatter time (see setup.ts).
 */
export interface PickupSpawnEntry {
  kind: 'artifact' | 'weapon' | 'armor';
  name: string;
  percent: number;
}

export const HIDDEN_PICKUP_SPAWN: readonly PickupSpawnEntry[] = [
  // Artifacts — ~11.5% of the board, split by rarity.
  { kind: 'artifact', name: 'Трава С.', percent: 3.5 },
  { kind: 'artifact', name: 'Посох огня', percent: 2.5 },
  { kind: 'artifact', name: 'Волшебная палочка', percent: 2.5 },
  { kind: 'artifact', name: 'Солнечные часы', percent: 1.5 },
  { kind: 'artifact', name: 'Вода серебряных трав', percent: 1.5 },
  // Gear — ~3.1% total, so finding a sword stays an event.
  { kind: 'weapon', name: 'Солнечный меч', percent: 0.8 },
  { kind: 'weapon', name: 'Синий лук', percent: 0.8 },
  { kind: 'armor', name: 'Кольчуга', percent: 1.0 },
  { kind: 'armor', name: 'Латы', percent: 0.5 },
];

// Loot odds (weights sum to 100): nothing 40%, artifacts 15%, weapon 15%,
// armour 30%.
export const RUINS_LOOT_TABLE: readonly LootEntry[] = [
  { type: 'nothing', weight: 40 },
  // Artifacts — 15% total, split by rarity.
  { type: 'artifact', name: 'Трава С.', weight: 5 },
  { type: 'artifact', name: 'Посох огня', weight: 3 },
  { type: 'artifact', name: 'Волшебная палочка', weight: 3 },
  { type: 'artifact', name: 'Солнечные часы', weight: 2 },
  { type: 'artifact', name: 'Вода серебряных трав', weight: 2 },
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
};

export const SPELLS: readonly Spell[] = [
  {
    name: 'Дождь защиты',
    recipe: {
      'Вода серебряных трав': 2,
      'Волшебная палочка': 1,
      'Трава С.': 1,
    },
    desc: '+2 HP всем своим',
    icon: 'spell_rain',
  },
  {
    name: 'Сталь свободы',
    recipe: {
      'Посох огня': 1,
      'Вода серебряных трав': 1,
      'Волшебная палочка': 1,
    },
    desc: 'Восстанавливает до +2 защиты, но не выше стартовой',
    icon: 'spell_steel',
  },
  {
    name: 'Небо огня',
    recipe: {
      'Трава С.': 3,
      'Волшебная палочка': 1,
      'Солнечные часы': 1,
    },
    desc: '+2 урона всем союзникам на 2 хода (этот + следующий)',
    icon: 'spell_fire_sky',
  },
];

export const WEAPONS: readonly Weapon[] = [
  {
    name: 'Солнечный меч',
    // Harder to craft now: two fire staves plus the rarer reagents.
    recipe: {
      'Посох огня': 2,
      'Волшебная палочка': 1,
      'Солнечные часы': 1,
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
      'Вода серебряных трав': 2,
      'Трава С.': 2,
      'Посох огня': 1,
      'Волшебная палочка': 1,
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
 * and its max armour by `amount` (so castle/spell restoration accounts for it).
 * Like weapons it occupies a single slot per unit — a unit can carry one
 * weapon and one piece of armour.
 */
export const ARMORS: readonly Weapon[] = [
  {
    name: 'Кольчуга',
    recipe: {
      'Трава С.': 1,
      'Вода серебряных трав': 1,
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
      'Посох огня': 1,
      'Солнечные часы': 1,
      'Вода серебряных трав': 1,
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

export const DEFAULT_TOWERS: readonly TowerPosition[] = [
  { row: 5, col: 4 },
  { row: 5, col: 15 },
  { row: 14, col: 4 },
  { row: 14, col: 15 },
];

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
];
