/**
 * Phase 1.5 S5 — pure `applyAction(state, action, rng): Result` reducer.
 *
 * The server (Phase 3-4) drives matches by routing each player message
 * through `applyAction`. Every transition is deterministic given (state,
 * action, rng). Outcome is either:
 *   - `{ ok: true, value: nextState, events: [...] }` for valid actions
 *   - `{ ok: false, error: { code, message } }` for illegal ones
 *
 * Combat semantics are ported verbatim from main.ts:1754-1820 so
 * single-player and server-driven matches produce identical results
 * (modulo seeded vs Math.random for ruins loot).
 *
 * The legacy module-level setters in world.ts are NOT touched — this
 * reducer is fully state-passing.
 */
import { type Rng } from './rng.js';
import { type GameState } from './state.js';
import type { SerializedUnit } from './save.js';
import type { AttackMode, Backpack, BridgeDurability, Construction, GameMode, GearSlot, HiddenPickup, Player, Position, RuinsArea, TerrainCell, TowerPosition, UnitTypeKey } from './types.js';
export type ServerAction = {
    kind: 'move';
    unitId: number;
    row: number;
    col: number;
    cost: number;
} | {
    kind: 'attack';
    unitId: number;
    mode: AttackMode;
    cost: number;
    targetRow: number;
    targetCol: number;
    landingRow: number;
    landingCol: number;
    /** `mode: 'pierce'` only — see AttackAction.targets in types.ts. */
    targets?: Position[];
} | {
    kind: 'end-turn';
} | {
    kind: 'resign';
    player: Player;
} | {
    kind: 'craft';
    unitId: number;
    index: number;
} | {
    kind: 'craft-armor';
    unitId: number;
    index: number;
} | {
    kind: 'draw-part';
    unitId: number;
} | {
    kind: 'equip-weapon';
    unitId: number;
} | {
    kind: 'search-ruins';
    unitId: number;
} | {
    kind: 'castle-heal';
    unitId: number;
}
/**
 * Hand parts and/or a carried weapon/armour piece from one of your own
 * units to another standing adjacent (Chebyshev distance 1) — free, costs
 * no moves either side. `parts` may be a partial Backpack (only the counts
 * being moved); `weapon`/`armor` are true to transfer that slot's gear.
 */
 | {
    kind: 'transfer-items';
    fromUnitId: number;
    toUnitId: number;
    parts?: Partial<Backpack>;
    weapon?: boolean;
    armor?: boolean;
}
/**
 * `damage`: the player-chosen amount to deal (>=1) — mage-attack no longer
 * deals a fixed MAGE_ATTACK_DAMAGE. Costs `damage * 1 + distance *
 * MAGE_ATTACK_ENERGY_PER_CELL` energy — see [[kc-mage-ward-mechanic]].
 */
 | {
    kind: 'mage-attack';
    unitId: number;
    targetRow: number;
    targetCol: number;
    damage: number;
}
/**
 * Ward: multi-select toggle. Every id in `toggleUnitIds` flips its warded
 * state (unwarded→warded by this mage, warded-by-this-mage→unwarded).
 * Costs exactly 1 move total, however many ids are toggled — the whole
 * batch is one "Готово" confirm client-side. See applyMageWard.
 */
 | {
    kind: 'mage-ward';
    unitId: number;
    toggleUnitIds: number[];
} | {
    kind: 'mage-drain';
    unitId: number;
    targetUnitId: number;
} | {
    kind: 'mage-burn-bridge';
    unitId: number;
    row: number;
    col: number;
} | {
    kind: 'mage-heal';
    unitId: number;
    targetUnitId: number;
}
/**
 * Catapult boulder: 1 move, same manhattan range as its shot. An empty
 * legal cell becomes impassable `rock`; aiming at an existing rock shatters
 * it back to open ground. See rockTargetAllowed for the forbidden cells.
 */
 | {
    kind: 'throw-rock';
    unitId: number;
    row: number;
    col: number;
} | {
    kind: 'build-tower';
    unitId: number;
    row: number;
    col: number;
} | {
    kind: 'build-bridge';
    unitId: number;
    row: number;
    col: number;
};
export type ValidationCode = 'wrong-turn' | 'unit-not-found' | 'unit-not-owned' | 'unit-cannot-act' | 'illegal-move' | 'illegal-attack' | 'no-moves-left' | 'no-target' | 'game-over' | 'craft-unaffordable' | 'no-pending-weapon' | 'cannot-equip' | 'weapon-pending' | 'activation-limit' | 'unit-not-on-ruins' | 'unit-not-in-castle' | 'not-adjacent' | 'nothing-to-transfer' | 'not-a-mage' | 'no-energy' | 'no-warding-target' | 'no-heal-target' | 'already-full-hp' | 'no-bridge-here' | 'not-river-cell' | 'not-empty-cell' | 'cell-occupied' | 'already-built' | 'unknown-action';
export interface ValidationError {
    code: ValidationCode;
    message: string;
}
export interface GameEvent {
    /** Description of what happened — for UI animation triggers. */
    kind: 'unit-moved' | 'unit-attacked' | 'unit-killed' | 'turn-ended' | 'match-finished' | 'weapon-crafted' | 'weapon-equipped' | 'ruins-searched' | 'castle-healed' | 'items-transferred' | 'mage-attacked' | 'mage-warded' | 'mage-drained' | 'mage-healed' | 'mage-died-overdrawn' | 'bridge-burned' | 'tower-built' | 'bridge-built' | 'rock-thrown' | 'rock-shattered'
    /** A unit stepped onto a buried weapon part. */
     | 'part-found'
    /** A unit stepped onto buried gear it can't wear; an ally must equip it. */
     | 'weapon-found';
    data: Record<string, unknown>;
}
export type Result<T, E> = {
    ok: true;
    value: T;
    events: GameEvent[];
} | {
    ok: false;
    error: E;
};
export interface CreateInitialStateOpts {
    mode: GameMode;
    seed: number;
    player1Starts?: boolean;
    /** Optional pre-built unit roster; otherwise initialised from constants. */
    units?: SerializedUnit[];
    castleP1Col?: number;
    castleP2Col?: number;
    towers?: readonly TowerPosition[];
    ruins?: RuinsArea;
    ruins2?: RuinsArea;
    terrain?: readonly TerrainCell[];
    /** Hidden pickups buried across the board (see scatterHiddenPickups). */
    hiddenPickups?: readonly HiddenPickup[];
    constructions?: readonly Construction[];
    bridgeDurability?: BridgeDurability;
}
export declare function createInitialState(opts: CreateInitialStateOpts): GameState;
interface GearSpec {
    slot?: GearSlot;
    allowedTypes: UnitTypeKey[] | null;
    forbidTypes: UnitTypeKey[] | null;
    archerOnly: boolean;
}
/** True if a pending/looted/ dropped item may be equipped to `unit`: same
 * player, alive, the matching slot is free, and the unit type is allowed.
 * Mirrors the web client's canEquipWeaponToUnit. */
/** Exported so callers outside apply.ts (the action generator, search code)
 * can check equip eligibility for a pending/dropped item without
 * reimplementing the slot/type rules. */
export declare function canEquipGear(spec: GearSpec, unit: SerializedUnit, player: Player): boolean;
/**
 * Apply a single action to the current state. Pure (returns a fresh state).
 * The RNG cursor on the returned state will reflect any random draws so
 * replay determinism holds.
 */
export declare function applyAction(state: GameState, action: ServerAction, rng: Rng): Result<GameState, ValidationError>;
/**
 * True when (row,col) falls inside a 4×4 castle footprint anchored at
 * (castleRow, castleCol). Exported so callers outside apply.ts (the AI's
 * evaluate()/beam search) can reuse the exact same zone rule instead of
 * reimplementing it — see castleRowFor/castleColFor below for the canonical
 * per-player anchor.
 */
export declare function inCastleZone(u: {
    row: number;
    col: number;
}, castleRow: number, castleCol: number): boolean;
/** Row of `player`'s own castle footprint (top-left anchor row). */
export declare function castleRowFor(player: Player): number;
/** Column of `player`'s own castle footprint (top-left anchor col), from state. */
export declare function castleColFor(state: GameState, player: Player): number;
/** True if `player` has a living unit standing inside its own castle zone. */
export declare function defendsOwnCastle(state: GameState, player: Player): boolean;
/** True if `player` has a living unit standing inside the OTHER player's castle zone. */
export declare function occupiesEnemyCastle(state: GameState, player: Player): boolean;
/**
 * End the current turn. Resets done/movesLeft for the next player, decrements
 * shield/buff timers for the ending player, advances turnNumber.
 * Symmetric with `AIPlayer.applyEndOfTurn` in packages/web/src/game/ai.ts.
 */
export declare function endTurn(state: GameState): GameState;
/**
 * True when (row,col) lies in a castle footprint or the approach strip in
 * front of its gate — the band where a catapult may not drop a boulder.
 * Orientation-free (both ends of the board are covered), so the client can
 * use it on its physical board unchanged.
 */
export declare function isRockForbiddenZone(row: number, col: number, castleCols: readonly number[]): boolean;
/**
 * Whether a catapult may aim a boulder at (row,col): empty ground (or an
 * existing rock, which it shatters), never a unit, tower, river, bridge,
 * mountain, construction site, dropped loot, or the castle approach zone.
 */
export declare function rockTargetAllowed(state: GameState, row: number, col: number): boolean;
export {};
//# sourceMappingURL=apply.d.ts.map