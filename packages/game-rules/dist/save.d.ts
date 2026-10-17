import type { Backpack, BridgeDurability, Construction, DroppedBackpack, HiddenPickup, EquippedGear, GameMode, GearSlot, Player, RuinsArea, TowerPosition, UnitTypeKey } from './types.js';
/**
 * Plain JSON-serialisable snapshot of an in-progress match.
 *
 * Phase 1 — FUNC-001 fix: now includes AI difficulty, current story task,
 * map theme, faction selection and session score so AI/story matches are
 * resumable after reload (legacy snapshot only worked for PvP).
 */
export interface GameSnapshot {
    version: number;
    screen: 'menu' | 'game';
    mode: GameMode;
    currentPlayer: Player;
    activatedCount: number;
    turnNumber: number;
    winner: Player | null;
    message: string;
    lastEvent: string;
    player1Bottom: boolean;
    castleP1Col: number;
    castleP2Col: number;
    /**
     * Phase 1.5 S6: snapshot v3 includes towers and ruins inline so a server
     * can reconstruct a GameState from a snapshot without touching world.ts
     * module state. v2 snapshots fall back to DEFAULT_TOWERS / DEFAULT_RUINS.
     */
    towers: TowerPosition[];
    ruins: RuinsArea;
    ruins2: RuinsArea;
    terrain: {
        row: number;
        col: number;
        type: string;
    }[];
    shieldTurns: Record<Player, number>;
    damageBuff: Record<Player, number>;
    pendingWeaponEquip: SerializedWeaponEquip | null;
    /** A dead unit's whole backpack (parts + weapon + armour), dropped as one
     * object on its death cell — see [[per-unit-backpack]]. */
    droppedBackpacks: DroppedBackpack[];
    /** Unfinished tower/bridge sites. Optional: older saves lack it. */
    constructions?: Construction[];
    /** Built bridges' remaining hit points, keyed "row,col". */
    bridgeDurability?: BridgeDurability;
    /** Buried loot not yet claimed — must survive a reload, or it re-scatters. */
    hiddenPickups?: HiddenPickup[];
    previewUnitId: number | null;
    selectedUnitId: number | null;
    units: SerializedUnit[];
    aiDifficulty: string | null;
    currentStoryTask: SerializedStoryTask | null;
    mapTheme: 'land' | 'sea';
    p1Faction: string;
    p2Faction: string;
    sessionWins: Record<Player, number>;
}
export interface SerializedWeaponEquip {
    name: string;
    amount: number;
    icon: string;
    allowedTypes: UnitTypeKey[] | null;
    forbidTypes: UnitTypeKey[] | null;
    archerOnly: boolean;
    /** Slot the pending item equips into. Absent ⇒ 'weapon' (back-compat). */
    slot?: GearSlot;
}
export interface SerializedUnit {
    id: number;
    player: Player;
    type: UnitTypeKey;
    row: number;
    col: number;
    maxHp: number;
    hp: number;
    startArmor: number;
    armor: number;
    maxArmor: number;
    damage: number;
    maxMoves: number;
    movesLeft: number;
    done: boolean;
    activated: boolean;
    visualRow: number | null;
    visualCol: number | null;
    dying: boolean;
    deathProgress: number;
    weapon: EquippedGear | null;
    /** Equipped armour piece (drop/pickup + restoration accounting). */
    armorGear: EquippedGear | null;
    /** This unit's own carry of weapon parts — no shared per-player pool any more. */
    backpack: Backpack;
    /** Mage only: current/max energy for its 4 abilities. Absent on every other type. */
    energy?: number;
    maxEnergy?: number;
    /** Mage only: unit ids this mage is currently warding (see mage-ward action). */
    warding?: number[];
    /**
     * Any unit (not just a mage): the id of the living mage currently shielding
     * it, if any. Set/cleared in bulk by mage-ward (multi-select toggle, 1 move
     * total regardless of how many units are toggled). A warded unit takes ZERO
     * damage from a hit — the hit is instead converted to
     * floor(damage / MAGE_WARD_ENERGY_PER_DAMAGE) energy drained from the
     * warding mage; if the mage doesn't have enough energy to cover it, the
     * MAGE dies (not the warded unit, and not a partial absorb).
     */
    wardedBy?: number | null;
}
export interface SerializedStoryTask {
    ci: number;
    gi: number;
    ti: number;
}
/**
 * Tampering ceiling for a unit's damage when restoring from localStorage.
 * Maximum allowed = base damage for the unit type + this cap.
 *
 * T25 (P1) — defends against a player editing localStorage to inflate damage,
 * which is otherwise possible because the save is fully client-controlled.
 * Real anti-cheat lands in Phase 4 (server-authoritative state).
 */
export declare const DESERIALIZED_DAMAGE_BUFF_CAP = 10;
export declare function validateSerializedUnit(raw: unknown): SerializedUnit | null;
export declare function validateSnapshot(raw: unknown): GameSnapshot | null;
/**
 * Phase 1.5 S6 adapter: lifts a fully-validated GameSnapshot into the
 * server-side GameState shape. Save metadata (story task, factions, UI
 * selection) is NOT carried over — the server doesn't need it.
 */
export declare function snapshotToState(snapshot: GameSnapshot): {
    castleP1Col: number;
    castleP2Col: number;
    towers: TowerPosition[];
    ruins: RuinsArea;
    ruins2: RuinsArea;
    currentPlayer: Player;
    turnNumber: number;
    activatedCount: number;
    winner: Player | null;
    mode: GameMode;
    shieldTurns: Record<Player, number>;
    damageBuff: Record<Player, number>;
    units: SerializedUnit[];
    droppedBackpacks: DroppedBackpack[];
};
/**
 * Returns true if the given snapshot is a partial match we can resume in
 * the menu. FUNC-001 fix: previously this was restricted to `mode === 'pvp'`
 * which orphaned every AI/story save.
 */
export declare function isContinuableSnapshot(snapshot: GameSnapshot | null): boolean;
//# sourceMappingURL=save.d.ts.map