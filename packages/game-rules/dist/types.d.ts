export type Player = 1 | 2;
/** Which way a unit looks — see facing.ts. `down` = toward higher rows. */
export type Facing = 'up' | 'down' | 'left' | 'right';
export type UnitTypeKey = 'knight' | 'cavalry' | 'archer' | 'catapult' | 'crossbow' | 'samurai' | 'mage';
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
/**
 * Weapon parts — the crafting currency. Replaced the old artifact set
 * (Трава С./Посох огня/etc, used by the now-removed common spells) one-for-one:
 * same scatter/ruins-drop system, just a different 5 names.
 */
export type PartName = 'Металл' | 'Амулет' | 'Рубин' | 'Дерево' | 'Стрелы';
export type CraftRecipe = Partial<Record<PartName, number>>;
/** Equipment slot a craftable/lootable item occupies on a unit. */
export type GearSlot = 'weapon' | 'armor';
export interface Weapon {
    name: string;
    recipe: CraftRecipe;
    desc: string;
    amount: number;
    icon: string;
    forbidTypes?: UnitTypeKey[];
    allowedTypes?: UnitTypeKey[];
    archerOnly: boolean;
    /** Which slot this item equips into. Defaults to 'weapon' (damage). */
    slot?: GearSlot;
}
export type LootEntry = {
    type: 'nothing';
    weight: number;
} | {
    type: 'part';
    name: PartName;
    weight: number;
} | {
    type: 'weapon';
    name: string;
    weight: number;
} | {
    type: 'armor';
    name: string;
    weight: number;
};
/** A unit's personal carry: weapon-part counts. Every unit has its own —
 * there is no shared per-player pool any more (see [[per-unit-backpack]]). */
export type Backpack = Record<PartName, number>;
/** A crafted weapon/armour piece as equipped on a unit — just enough to
 * render it and add its damage/armour bonus back in. */
export interface EquippedGear {
    name: string;
    icon: string;
    amount: number;
}
/** A crafted weapon/armour piece in transit — dropped on the board or handed
 * between units — carrying the type-restriction fields needed to check
 * whether a given recipient may equip it (see canEquipGear). */
export interface GearItem extends EquippedGear {
    allowedTypes: UnitTypeKey[] | null;
    forbidTypes: UnitTypeKey[] | null;
    archerOnly: boolean;
}
/**
 * A dead unit's whole backpack, dropped on the board as ONE object on its
 * death cell — its weapon-part counts plus its equipped weapon/armour, if
 * any. Any of the killed unit's allies that later moves onto (row,col) picks
 * up everything at once: every part, and any gear it can legally equip.
 * Fully deterministic, so it stays in lockstep between the offline client,
 * the optimistic online client, and the authoritative server reducer.
 */
export interface DroppedBackpack {
    row: number;
    col: number;
    parts: Backpack;
    weapon: GearItem | null;
    armorGear: GearItem | null;
}
export interface TowerPosition {
    row: number;
    col: number;
}
/**
 * A hidden pickup buried on the board at match setup — a weapon part, a
 * craftable weapon or a piece of armour. Scattered once per match (never
 * respawns), invisible to both players, and claimed by the first unit that
 * steps onto (row,col).
 *
 * `kind: 'part'` goes straight into the finder's own backpack. Weapons and
 * armour are equipped like ruins loot: onto the finder when it can wear them,
 * otherwise the player picks a compatible ally (pendingWeaponEquip).
 */
export interface HiddenPickup {
    row: number;
    col: number;
    kind: 'part' | 'weapon' | 'armor';
    /** PartName for kind 'part', otherwise a WEAPONS/ARMORS entry name. */
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
/**
 * `rock` is a boulder hurled by a catapult onto an empty cell — permanent,
 * impassable cover created mid-match (see the 'throw-rock' action).
 */
export type TerrainType = 'river' | 'mountain' | 'bridge' | 'rock';
export interface TerrainCell {
    row: number;
    col: number;
    type: TerrainType;
}
/**
 * An in-progress tower or bridge, being built by a knight over 2 of the
 * player's own turns (4 "work" units total — 2 movesLeft spent per turn, see
 * BUILD_WORK_TOTAL). Lives at a board cell until `progress` reaches the
 * total, at which point it's promoted into a real TowerPosition (tower) or
 * TerrainCell{type:'bridge'} (bridge, replacing the river cell there) and
 * removed from `constructions`. If the building knight dies or leaves
 * mid-build, the site just sits there — any other knight can walk up and
 * keep adding work.
 */
export interface Construction {
    row: number;
    col: number;
    kind: 'tower' | 'bridge';
    progress: number;
}
/** A built bridge's remaining structural hit points — 2 to start, catapult
 * hits for 1, the mage's burn-bridge ability drops it to 0 outright. Absent
 * (or 0) means no bridge there any more. Keyed "row,col". */
export type BridgeDurability = Record<string, number>;
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
    /** See facing.ts; absent = the player's default (P1 down, P2 up). */
    facing?: Facing;
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
    /**
     * True when (row,col) is a river cell (a bridge is NOT a river — it's the
     * crossing). Optional: when absent, cavalry simply can't river-jump.
     */
    isRiver?(row: number, col: number): boolean;
    /**
     * True when (row,col) is a built bridge. Optional: when absent, a catapult
     * simply can't target a bridge for demolition.
     */
    isBridge?(row: number, col: number): boolean;
}
export type AttackMode = 'shot' | 'jump' | 'l-attack' | 'pierce';
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
    /**
     * `mode: 'pierce'` only: every cell the bolt passes through, in flight
     * order (1st = adjacent cell, 2nd = the far cell), regardless of whether it
     * holds a unit — `applyAttack` hits whichever of these cells has a living
     * unit on it, friend or foe. `targetRow`/`targetCol` duplicate the first
     * entry so every other mode's "single target" reading of those two fields
     * keeps working unchanged.
     */
    targets?: Position[];
}
export type Action = MoveAction | AttackAction;
/**
 * Context required by combat calculations beyond the attacker/target units.
 * Maps each player to current active buff/shield turn counts.
 */
export interface CombatContext {
    damageBuff: Record<Player, number>;
    shieldTurns: Record<Player, number>;
    /**
     * True when the attacker is firing from a mage tower. Ranged attackers trade
     * damage for the tower's extended range (see TOWER_DAMAGE_FACTOR). Optional so
     * existing callers keep compiling — absent means "not on a tower".
     */
    attackerOnTower?: boolean;
}
//# sourceMappingURL=types.d.ts.map