// AUTO-VENDORED from packages/game-rules/src/types.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
export type Player = 1 | 2;

export type UnitTypeKey = 'knight' | 'cavalry' | 'archer' | 'catapult' | 'crossbow' | 'samurai';

export interface UnitStats {
  name: string;
  hp: number;
  damage: number;
  armor: number;
  moves: number;
  frame: number;
  letter: string;
}

export type UnitTypes = Record<UnitTypeKey, UnitStats>;

export type ArtifactName =
  | 'Трава С.'
  | 'Посох огня'
  | 'Волшебная палочка'
  | 'Солнечные часы'
  | 'Вода серебряных трав';

export type SpellRecipe = Partial<Record<ArtifactName, number>>;

export interface Spell {
  name: string;
  recipe: SpellRecipe;
  desc: string;
  icon: string;
}

/** Equipment slot a craftable/lootable item occupies on a unit. */
export type GearSlot = 'weapon' | 'armor';

export interface Weapon {
  name: string;
  recipe: SpellRecipe;
  desc: string;
  amount: number;
  icon: string;
  forbidTypes?: UnitTypeKey[];
  allowedTypes?: UnitTypeKey[];
  archerOnly: boolean;
  /** Which slot this item equips into. Defaults to 'weapon' (damage). */
  slot?: GearSlot;
}

export type LootEntry =
  | { type: 'nothing'; weight: number }
  | { type: 'artifact'; name: ArtifactName; weight: number }
  | { type: 'weapon'; name: string; weight: number }
  | { type: 'armor'; name: string; weight: number };

/**
 * A piece of gear lying on the board after its bearer was killed. Any unit that
 * later moves onto (row,col) and can equip the gear (matching slot + type rules)
 * picks it up automatically. Drop/pickup is fully deterministic so it stays in
 * lockstep between the offline client, the optimistic online client, and the
 * authoritative server reducer.
 */
export interface DroppedItem {
  row: number;
  col: number;
  slot: GearSlot;
  name: string;
  amount: number;
  icon: string;
  allowedTypes: UnitTypeKey[] | null;
  forbidTypes: UnitTypeKey[] | null;
  archerOnly: boolean;
}

export interface TowerPosition {
  row: number;
  col: number;
}

/**
 * A hidden pickup buried on the board at match setup — an artifact, a weapon or
 * a piece of armour. Scattered once per match (never respawns), invisible to
 * both players, and claimed by the first unit that steps onto (row,col).
 *
 * `kind: 'artifact'` goes straight into the finder's inventory. Weapons and
 * armour are equipped like ruins loot: onto the finder when it can wear them,
 * otherwise the player picks a compatible ally (pendingWeaponEquip).
 */
export interface HiddenPickup {
  row: number;
  col: number;
  kind: 'artifact' | 'weapon' | 'armor';
  /** ArtifactName for kind 'artifact', otherwise a WEAPONS/ARMORS entry name. */
  name: string;
}

export interface RuinsArea {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface StartPosition {
  type: UnitTypeKey;
  row: number;
  col: number;
}

export interface Position {
  row: number;
  col: number;
}

export type TerrainType = 'river' | 'mountain' | 'bridge';

export interface TerrainCell {
  row: number;
  col: number;
  type: TerrainType;
}

export type GameMode = 'pvp' | 'ai' | 'story';

/**
 * Minimal contract for a unit usable by pure game-rules functions.
 * The web client's Unit class implements this (and adds animation state etc).
 */
export interface UnitState {
  id: number;
  type: UnitTypeKey;
  player: Player;
  row: number;
  col: number;
  hp: number;
  armor: number;
  damage: number;
  maxMoves: number;
  movesLeft: number;
  name: string;
}

/**
 * Minimal contract for board queries used by pure game-rules functions.
 */
export interface BoardLike {
  unitAt(row: number, col: number): UnitState | null;
  isFree(row: number, col: number): boolean;
  /**
   * True when (row,col) is a mage tower. Optional so older BoardLike
   * implementations keep working — when absent the tower range bonus for
   * archers/catapults simply doesn't apply.
   */
  isTower?(row: number, col: number): boolean;
}

export type AttackMode = 'shot' | 'jump' | 'l-attack';

export interface MoveAction {
  kind: 'move';
  row: number;
  col: number;
  cost: number;
}

export interface AttackAction {
  kind: 'attack';
  mode: AttackMode;
  row: number;
  col: number;
  cost: number;
  targetRow: number;
  targetCol: number;
  landingRow: number;
  landingCol: number;
}

export type Action = MoveAction | AttackAction;

/**
 * Context required by combat calculations beyond the attacker/target units.
 * Maps each player to current active buff/shield turn counts.
 */
export interface CombatContext {
  damageBuff: Record<Player, number>;
  shieldTurns: Record<Player, number>;
}
