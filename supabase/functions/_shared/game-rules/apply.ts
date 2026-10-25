// AUTO-VENDORED from packages/game-rules/src/apply.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
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

import {
  ARMORS,
  BRIDGE_MAX_DURABILITY,
  BUILD_COST_PER_TURN,
  BUILD_WORK_TOTAL,
  DEFAULT_CASTLE_P1_COL,
  DEFAULT_CASTLE_P2_COL,
  MAGE_ATTACK_ENERGY_PER_CELL,
  MAGE_ATTACK_ENERGY_PER_HP,
  MAGE_BURN_BRIDGE_ENERGY_PER_CELL,
  MAGE_DRAIN_ENERGY_PER_HP,
  MAGE_ENERGY_REGEN_PER_TURN,
  MAGE_HEAL_ENERGY_PER_CELL,
  MAGE_HEAL_ENERGY_PER_HP,
  MAGE_MAX_ENERGY,
  MAGE_WARD_ENERGY_PER_DAMAGE,
  PARTS,
  ROWS,
  RUINS_LOOT_TABLE,
  UNIT_TYPES,
  WEAPONS,
  emptyBackpack,
} from './constants.ts';
import { applyFacingDamage, facingOf, facingToward, turnCost } from './facing.ts';
import { type Rng, weightedChoiceWith } from './rng.ts';
import { TOWER_DAMAGE_FACTOR } from './combat.ts';
import { insideBoard } from './board.ts';
import {
  ALL8_DIRS,
  CATAPULT_MIN_RANGE,
  CAVALRY_RIVER_JUMP_COST,
  CROSSBOW_PIERCE_COST,
  CROSSBOW_PIERCE_RANGE,
  archerRadiusFor,
  catapultMaxRangeFor,
} from './moves.ts';
import { type GameState, MAX_ACTIVATIONS_PER_TURN, RULES_VERSION } from './state.ts';
import type { SerializedUnit, SerializedWeaponEquip } from './save.ts';
import type {
  AttackMode,
  Backpack,
  BridgeDurability,
  Construction,
  DroppedBackpack,
  GameMode,
  GearItem,
  GearSlot,
  HiddenPickup,
  LootEntry,
  PartName,
  Player,
  Position,
  RuinsArea,
  TerrainCell,
  TowerPosition,
  UnitTypeKey,
  Weapon,
} from './types.ts';

export type ServerAction =
  | { kind: 'move'; unitId: number; row: number; col: number; cost: number }
  | {
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
    }
  | { kind: 'end-turn' }
  | { kind: 'resign'; player: Player }
  | { kind: 'craft'; unitId: number; index: number }
  | { kind: 'craft-armor'; unitId: number; index: number }
  | { kind: 'draw-part'; unitId: number }
  | { kind: 'equip-weapon'; unitId: number }
  | { kind: 'search-ruins'; unitId: number }
  | { kind: 'castle-heal'; unitId: number }
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
  | { kind: 'mage-attack'; unitId: number; targetRow: number; targetCol: number; damage: number }
  /**
   * Ward: multi-select toggle. Every id in `toggleUnitIds` flips its warded
   * state (unwarded→warded by this mage, warded-by-this-mage→unwarded).
   * Costs exactly 1 move total, however many ids are toggled — the whole
   * batch is one "Готово" confirm client-side. See applyMageWard.
   */
  | { kind: 'mage-ward'; unitId: number; toggleUnitIds: number[] }
  | { kind: 'mage-drain'; unitId: number; targetUnitId: number }
  | { kind: 'mage-burn-bridge'; unitId: number; row: number; col: number }
  | { kind: 'mage-heal'; unitId: number; targetUnitId: number }
  /**
   * Catapult boulder: 1 move, same manhattan range as its shot. An empty
   * legal cell becomes impassable `rock`; aiming at an existing rock shatters
   * it back to open ground. See rockTargetAllowed for the forbidden cells.
   */
  | { kind: 'throw-rock'; unitId: number; row: number; col: number }
  | { kind: 'build-tower'; unitId: number; row: number; col: number }
  | { kind: 'build-bridge'; unitId: number; row: number; col: number };

export type ValidationCode =
  | 'wrong-turn'
  | 'unit-not-found'
  | 'unit-not-owned'
  | 'unit-cannot-act'
  | 'illegal-move'
  | 'illegal-attack'
  | 'no-moves-left'
  | 'no-target'
  | 'game-over'
  | 'craft-unaffordable'
  | 'no-pending-weapon'
  | 'cannot-equip'
  | 'weapon-pending'
  | 'activation-limit'
  | 'unit-not-on-ruins'
  | 'unit-not-in-castle'
  | 'not-adjacent'
  | 'nothing-to-transfer'
  | 'not-a-mage'
  | 'no-energy'
  | 'no-warding-target'
  | 'no-heal-target'
  | 'already-full-hp'
  | 'no-bridge-here'
  | 'not-river-cell'
  | 'not-empty-cell'
  | 'cell-occupied'
  | 'already-built'
  | 'unknown-action';

export interface ValidationError {
  code: ValidationCode;
  message: string;
}

export interface GameEvent {
  /** Description of what happened — for UI animation triggers. */
  kind:
    | 'unit-moved'
    | 'unit-attacked'
    | 'unit-killed'
    | 'turn-ended'
    | 'match-finished'
    | 'weapon-crafted'
    | 'weapon-equipped'
    | 'ruins-searched'
    | 'castle-healed'
    | 'items-transferred'
    | 'mage-attacked'
    | 'mage-warded'
    | 'mage-drained'
    | 'mage-healed'
    | 'mage-died-overdrawn'
    | 'bridge-burned'
    | 'tower-built'
    | 'bridge-built'
    | 'rock-thrown'
    | 'rock-shattered'
    /** A unit stepped onto a buried weapon part. */
    | 'part-found'
    /** A unit stepped onto buried gear it can't wear; an ally must equip it. */
    | 'weapon-found';
  data: Record<string, unknown>;
}

export type Result<T, E> = { ok: true; value: T; events: GameEvent[] } | { ok: false; error: E };

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

/** True if (row,col) falls inside a (non-zero-size) ruins rectangle. */
function inRuinsArea(area: RuinsArea | undefined, row: number, col: number): boolean {
  if (!area || area.width <= 0 || area.height <= 0) return false;
  return row >= area.top && row < area.top + area.height && col >= area.left && col < area.left + area.width;
}

export function createInitialState(opts: CreateInitialStateOpts): GameState {
  return {
    castleP1Col: opts.castleP1Col ?? DEFAULT_CASTLE_P1_COL,
    castleP2Col: opts.castleP2Col ?? DEFAULT_CASTLE_P2_COL,
    towers: opts.towers ? opts.towers.map((t) => ({ ...t })) : [],
    ruins: opts.ruins ? { ...opts.ruins } : { top: 0, left: 0, width: 0, height: 0 },
    ruins2: opts.ruins2 ? { ...opts.ruins2 } : { top: 0, left: 0, width: 0, height: 0 },
    terrain: opts.terrain ? opts.terrain.map((t) => ({ ...t })) : [],
    currentPlayer: opts.player1Starts === false ? 2 : 1,
    turnNumber: 1,
    activatedCount: 0,
    winner: null,
    mode: opts.mode,
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    pendingWeaponEquip: null,
    droppedBackpacks: [],
    constructions: opts.constructions ? opts.constructions.map((c) => ({ ...c })) : [],
    bridgeDurability: opts.bridgeDurability ? { ...opts.bridgeDurability } : {},
    hiddenPickups: opts.hiddenPickups ? opts.hiddenPickups.map((p) => ({ ...p })) : [],
    units: opts.units ? opts.units.map(cloneUnit) : [],
    nextUnitId: (opts.units ?? []).reduce((m, u) => Math.max(m, u.id), 0) + 1,
    rngSeed: opts.seed,
    rngCursor: 0,
    rulesVersion: RULES_VERSION,
  };
}

/**
 * Copy-on-write discipline (this is the reducer's hottest path — every action
 * clones the state, and a search clones it millions of times per second):
 * only what the reducers MUTATE IN PLACE is copied. That is each unit object
 * and its backpack (parts are incremented in place), the droppedBackpacks
 * array (pushed to), and the two buff counters. Everything else — terrain,
 * towers, ruins, constructions, hiddenPickups, bridgeDurability, gear objects,
 * ward lists, dropped packs themselves — is only ever REPLACED wholesale by
 * the reducers, so the new state can safely share it with the old one.
 */
function cloneUnit(u: SerializedUnit): SerializedUnit {
  return { ...u, backpack: { ...u.backpack } };
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    shieldTurns: { ...state.shieldTurns },
    damageBuff: { ...state.damageBuff },
    droppedBackpacks: (state.droppedBackpacks ?? []).slice(),
    constructions: state.constructions ?? [],
    bridgeDurability: state.bridgeDurability ?? {},
    hiddenPickups: state.hiddenPickups ?? [],
    // Units are shared too and copied on first write — see own().
    units: state.units.slice(),
  };
}

// Ownership bookkeeping for own(): the units already copied for the state
// currently being built. Reducers are synchronous and build one `next` at a
// time, so a tiny module-level list beats a WeakMap by a wide margin; if
// another state ever interleaves, the list just resets and a unit may be
// copied twice — wasteful, never wrong.
let ownedFor: GameState | null = null;
const owned: SerializedUnit[] = [];

/**
 * Copy-on-write for units: return a copy of `u` that belongs to `next` (making
 * it, and swapping it into next.units, on the first call). Every reducer must
 * go through this before mutating a unit of `next`, since cloneState shares
 * unit objects with the previous state.
 */
function own(next: GameState, u: SerializedUnit): SerializedUnit {
  if (ownedFor !== next) {
    ownedFor = next;
    owned.length = 0;
  } else if (owned.includes(u)) {
    return u;
  }
  const i = next.units.indexOf(u);
  const c = cloneUnit(u);
  owned.push(c);
  if (i >= 0) next.units[i] = c;
  return c;
}

/** own() for an optional unit. */
function ownOpt(next: GameState, u: SerializedUnit | null | undefined): SerializedUnit | null {
  return u ? own(next, u) : null;
}

/** Mark a unit as activated for the turn, enforcing the per-turn cap. Returns a
 * ValidationError if a new unit would exceed the cap; null on success. Mutates
 * `next` (already a clone). */
function activateUnit(next: GameState, unit: SerializedUnit): ValidationError | null {
  if (unit.activated) return null;
  if (next.activatedCount >= MAX_ACTIVATIONS_PER_TURN) {
    return { code: 'activation-limit', message: 'max units activated this turn' };
  }
  unit.activated = true;
  next.activatedCount += 1;
  return null;
}

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
export function canEquipGear(spec: GearSpec, unit: SerializedUnit, player: Player): boolean {
  if (unit.player !== player || unit.hp <= 0) return false;
  const slot: GearSlot = spec.slot ?? 'weapon';
  if (slot === 'armor') {
    if (unit.armorGear) return false;
  } else if (unit.weapon) {
    return false;
  }
  const allowed = spec.allowedTypes ?? (spec.archerOnly ? (['archer'] as UnitTypeKey[]) : null);
  if (allowed && !allowed.includes(unit.type)) return false;
  if (spec.forbidTypes && spec.forbidTypes.includes(unit.type)) return false;
  return true;
}

/** Lift a static WEAPONS/ARMORS recipe into the serialisable pending-equip shape. */
function weaponToPending(w: Weapon): SerializedWeaponEquip {
  return {
    name: w.name,
    amount: w.amount,
    icon: w.icon,
    allowedTypes: w.allowedTypes ? [...w.allowedTypes] : null,
    forbidTypes: w.forbidTypes ? [...w.forbidTypes] : null,
    archerOnly: w.archerOnly,
    slot: w.slot ?? 'weapon',
  };
}

/** Equip a pending/dropped item onto a unit (mutates the unit). Weapon raises
 * damage; armour raises current and max armour so restoration accounts for it. */
function equipGearToUnit(
  unit: SerializedUnit,
  spec: { name: string; icon: string; amount: number; slot?: GearSlot },
): void {
  const slot: GearSlot = spec.slot ?? 'weapon';
  if (slot === 'armor') {
    unit.armor += spec.amount;
    unit.maxArmor += spec.amount;
    unit.armorGear = { name: spec.name, icon: spec.icon, amount: spec.amount };
  } else {
    unit.damage += spec.amount;
    unit.weapon = { name: spec.name, icon: spec.icon, amount: spec.amount };
  }
}

/** Lift an equipped weapon/armour piece into a transferable GearItem.
 * allowedTypes etc. are recovered from the static catalogue so any future
 * recipient (drop/pickup, hand-to-ally) honours the same restrictions as
 * crafting. */
function gearToItem(slot: GearSlot, gear: { name: string; icon: string; amount: number }): GearItem {
  const catalogue = slot === 'armor' ? ARMORS : WEAPONS;
  const def = catalogue.find((w) => w.name === gear.name);
  return {
    name: gear.name,
    amount: gear.amount,
    icon: gear.icon,
    allowedTypes: def?.allowedTypes ? [...def.allowedTypes] : null,
    forbidTypes: def?.forbidTypes ? [...def.forbidTypes] : null,
    archerOnly: def?.archerOnly ?? false,
  };
}

/**
 * A killed unit's whole backpack — its weapon parts plus its equipped
 * weapon/armour, if any — dropped as ONE object on its death cell. Pushes
 * onto `next.droppedBackpacks`; no-op if the unit was carrying nothing at all
 * (no parts, no gear) so empty markers never litter the board.
 */
function dropUnitBackpack(next: GameState, unit: SerializedUnit): void {
  const hasParts = PARTS.some((p) => unit.backpack[p] > 0);
  if (!hasParts && !unit.weapon && !unit.armorGear) return;
  next.droppedBackpacks.push({
    row: unit.row,
    col: unit.col,
    parts: { ...unit.backpack },
    weapon: unit.weapon ? gearToItem('weapon', unit.weapon) : null,
    armorGear: unit.armorGear ? gearToItem('armor', unit.armorGear) : null,
  });
}

/**
 * Leave one piece of gear lying on (row,col) as a single-item backpack — what
 * happens to crafted/found gear its holder can't wear. Mirrors the web
 * client's pushDroppedGear: no forced "equip an ally" step, whoever later
 * steps on the cell and can wear it picks it up (see pickUpDroppedItems).
 */
function dropGearOnCell(next: GameState, row: number, col: number, slot: GearSlot, item: GearItem): void {
  next.droppedBackpacks.push({
    row,
    col,
    parts: emptyBackpack(),
    weapon: slot === 'weapon' ? item : null,
    armorGear: slot === 'armor' ? item : null,
  });
}

/** A destroyed bridge takes whatever lay on it into the river — otherwise the
 * loot marker would sit on an impassable water cell forever. */
function sinkLootAt(next: GameState, row: number, col: number): void {
  next.droppedBackpacks = next.droppedBackpacks.filter((d) => !(d.row === row && d.col === col));
}

function findUnit(state: GameState, id: number): SerializedUnit | null {
  return state.units.find((u) => u.id === id && u.hp > 0) ?? null;
}

/**
 * A mage that just died (in combat, or overdrawn absorbing a ward hit — see
 * absorbWithWard below) leaves every unit it was warding pointing at a dead
 * id. absorbWithWard's own `mage.hp > 0` check already stops that stale link
 * from blocking damage on their NEXT hit, but until then the flag — and the
 * client's 🛡️ badge that mirrors it — stays up as if the shield still held.
 * Call this the moment a mage's death is applied so the shield visibly drops
 * with its caster instead of lingering.
 */
function clearWardsCastBy(next: GameState, deadMageId: number): void {
  for (const u of next.units) {
    if (u.wardedBy === deadMageId) own(next, u).wardedBy = null;
  }
}

/**
 * Ward check run before ANY damage is applied to `target`: if a living mage
 * currently shields it (`target.wardedBy`), the hit is fully absorbed (the
 * caller must skip applying `rawDamage` to `target` entirely) and the
 * warding mage pays energy 1-to-1 with the absorbed damage (5 damage
 * absorbed → 5 energy spent; MAGE_WARD_ENERGY_PER_DAMAGE = 1 makes the
 * floor-division below a no-op). If the mage doesn't have enough energy
 * left to cover that, the hit is STILL fully absorbed (target takes 0) but
 * the mage dies instead — see [[kc-mage-ward-mechanic]] for the full spec
 * this implements.
 *
 * Mutates `next` (the mage's energy, or removes it on death) and pushes
 * events. Returns true when the hit was absorbed (caller must not also
 * apply rawDamage to target).
 */
function absorbWithWard(
  next: GameState,
  target: SerializedUnit,
  rawDamage: number,
  events: GameEvent[],
): boolean {
  if (!target.wardedBy) return false;
  const mage = ownOpt(next, next.units.find((u) => u.id === target.wardedBy && u.hp > 0 && u.type === 'mage'));
  if (!mage) {
    // Warding mage is gone (died some other way) — the flag is stale, clear
    // it and let the hit through normally.
    target.wardedBy = null;
    return false;
  }

  const cost = Math.floor(rawDamage / MAGE_WARD_ENERGY_PER_DAMAGE);
  const mageEnergy = mage.energy ?? 0;
  if (mageEnergy >= cost) {
    mage.energy = mageEnergy - cost;
    events.push({
      kind: 'mage-warded',
      data: { unitId: mage.id, targetId: target.id, absorbed: rawDamage, cost },
    });
  } else {
    // Not enough energy to cover the drain — the shield still holds (target
    // takes 0) but the mage itself dies from the overdraw. Zero its hp so any
    // caller still holding the object (a pierce bolt's hit list, drain's
    // nextMage) sees it as dead — removing it from `units` alone let the same
    // bolt hit it again and drop its backpack a second time.
    mage.hp = 0;
    dropUnitBackpack(next, mage);
    clearWardsCastBy(next, mage.id);
    next.units = next.units.filter((u) => u.id !== mage.id);
    events.push({ kind: 'mage-died-overdrawn', data: { unitId: mage.id, targetId: target.id, needed: cost, had: mageEnergy } });
    events.push({ kind: 'unit-killed', data: { unitId: mage.id } });
    // The mage's death may itself end the match (its side loses castle
    // defense, etc.) — check same as any other kill.
    maybeFinishMatch(next, events);
  }
  return true;
}

function err(code: ValidationCode, message: string): { ok: false; error: ValidationError } {
  return { ok: false, error: { code, message } };
}

function ok(value: GameState, events: GameEvent[]): Result<GameState, ValidationError> {
  return { ok: true, value, events };
}

/**
 * Apply a single action to the current state. Pure (returns a fresh state).
 * The RNG cursor on the returned state will reflect any random draws so
 * replay determinism holds.
 */
export function applyAction(
  state: GameState,
  action: ServerAction,
  rng: Rng,
): Result<GameState, ValidationError> {
  if (state.winner !== null && action.kind !== 'end-turn') {
    return err('game-over', 'Match is finished.');
  }

  // A crafted/looted weapon must be equipped before anything else can happen —
  // mirrors the web client's blockUntilWeaponEquipped gate.
  if (state.pendingWeaponEquip && action.kind !== 'equip-weapon') {
    return err('weapon-pending', 'equip the crafted weapon first');
  }

  switch (action.kind) {
    case 'move':
      return applyMove(state, action);
    case 'attack':
      return applyAttack(state, action);
    case 'end-turn':
      // A finished match stays exactly as it ended — ending the "turn" after
      // the winning move used to flip currentPlayer and bump turnNumber.
      if (state.winner !== null) return ok(state, []);
      return ok(endTurn(state), [{ kind: 'turn-ended', data: { player: state.currentPlayer } }]);
    case 'resign':
      return applyResign(state, action.player);
    case 'craft':
      return applyCraft(state, action.unitId, action.index);
    case 'craft-armor':
      return applyCraftArmor(state, action.unitId, action.index);
    case 'draw-part':
      return applyDrawPart(state, action.unitId, rng);
    case 'equip-weapon':
      return applyEquipWeapon(state, action.unitId);
    case 'search-ruins':
      return applySearchRuins(state, action.unitId, rng);
    case 'castle-heal':
      return applyCastleHeal(state, action.unitId);
    case 'transfer-items':
      return applyTransferItems(state, action);
    case 'throw-rock':
      return applyThrowRock(state, action);
    case 'build-tower':
      return applyBuild(state, action.unitId, action.row, action.col, 'tower');
    case 'build-bridge':
      return applyBuild(state, action.unitId, action.row, action.col, 'bridge');
    case 'mage-attack':
      return applyMageAttack(state, action);
    case 'mage-ward':
      return applyMageWard(state, action);
    case 'mage-drain':
      return applyMageDrain(state, action);
    case 'mage-burn-bridge':
      return applyMageBurnBridge(state, action);
    case 'mage-heal':
      return applyMageHeal(state, action);
    default:
      return err('unknown-action', 'Unrecognised action kind.');
  }
}

function applyMove(
  state: GameState,
  a: ServerAction & { kind: 'move' },
): Result<GameState, ValidationError> {
  const next = cloneState(state);
  const u = ownOpt(next, findUnit(next, a.unitId));
  if (!u) return err('unit-not-found', `unit ${a.unitId} not alive`);
  if (u.player !== next.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (u.done) return err('unit-cannot-act', 'unit already finished');
  if (u.movesLeft < a.cost) return err('no-moves-left', 'insufficient movesLeft');
  // Cell free?
  if (next.units.some((o) => o.id !== u.id && o.hp > 0 && o.row === a.row && o.col === a.col)) {
    return err('illegal-move', 'destination occupied');
  }
  // Terrain: river and mountain block movement (bridge passable)
  if (
    next.terrain.some(
      (t) => t.row === a.row && t.col === a.col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'),
    )
  ) {
    return err('illegal-move', 'blocked by terrain');
  }
  // An unfinished tower/bridge site is impassable, like a mountain.
  if ((next.constructions ?? []).some((c) => c.row === a.row && c.col === a.col)) {
    return err('illegal-move', 'blocked by an unfinished construction site');
  }
  // Cavalry's river leap, the archer's multi-cell walk and every other move
  // shape are validated together by the shared generator below. A separate
  // "2-cell hop ⇒ must be a cavalry river leap" check used to live here and
  // rejected every legal 2-cell archer move.
  // The authoritative check: the move must be one the shared generator would
  // offer this unit right now (straight lines, per-type reach, exact cost).
  // Without it a client could claim any destination at any cost.
  if (!isLegalMoveShape(next, u, a.row, a.col, a.cost)) {
    return err('illegal-move', 'not a legal move for this unit');
  }

  const actErr = activateUnit(next, u);
  if (actErr) return { ok: false, error: actErr };
  // A step leaves the unit facing the way it walked.
  u.facing = facingToward(u.row, u.col, a.row, a.col, facingOf(u));
  u.row = a.row;
  u.col = a.col;
  u.movesLeft -= a.cost;
  if (u.movesLeft <= 0) u.done = true;
  const moveEvents: GameEvent[] = [
    { kind: 'unit-moved', data: { unitId: u.id, row: a.row, col: a.col } },
  ];
  claimHiddenPickup(next, u, moveEvents);
  pickUpDroppedItems(next, u, moveEvents);
  maybeFinishMatch(next, moveEvents);
  return ok(next, moveEvents);
}

/** Same cell test as boardFromState().isFree, without building a board. */
function cellFree(s: GameState, row: number, col: number): boolean {
  if (!insideBoard(row, col)) return false;
  for (const o of s.units) if (o.hp > 0 && o.row === row && o.col === col) return false;
  for (const t of s.terrain) {
    if (t.row === row && t.col === col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock')) return false;
  }
  for (const c of s.constructions) if (c.row === row && c.col === col) return false;
  return true;
}

/**
 * Exactly the moves generateLegalMoves offers (moves.ts), checked directly —
 * the reducer runs this on every move, so it must not build a whole board.
 * Straight orthogonal line; 1 cell = 1 move; only the archer may go more than
 * one cell at once (every cell on the way free); a cavalry may leap exactly
 * one river cell for CAVALRY_RIVER_JUMP_COST onto a free non-river cell.
 */
function isLegalMoveShape(s: GameState, u: SerializedUnit, row: number, col: number, cost: number): boolean {
  if (u.movesLeft <= 0 || cost > u.movesLeft) return false;
  const dr = row - u.row;
  const dc = col - u.col;
  if ((dr !== 0 && dc !== 0) || (dr === 0 && dc === 0)) return false;
  const steps = Math.abs(dr) + Math.abs(dc);
  const sr = Math.sign(dr);
  const sc = Math.sign(dc);
  const isRiver = (r: number, c: number) => s.terrain.some((t) => t.row === r && t.col === c && t.type === 'river');
  // Stepping into the back half costs +1 to turn round (facing.ts).
  const turn = turnCost(u, u.row + sr, u.col + sc);
  if (u.type === 'cavalry' && steps === 2 && cost === CAVALRY_RIVER_JUMP_COST + turn && isRiver(u.row + sr, u.col + sc)) {
    return !isRiver(row, col) && cellFree(s, row, col);
  }
  if (cost !== steps + turn) return false;
  if (steps > 1 && (u.type !== 'archer' || steps > u.maxMoves)) return false;
  for (let k = 1; k <= steps; k += 1) {
    if (!cellFree(s, u.row + sr * k, u.col + sc * k)) return false;
  }
  return true;
}

/**
 * Claim the hidden pickup buried under a unit that just arrived, if any.
 * Weapon parts go straight into the finder's own backpack. Gear is equipped
 * to the finder when it can wear it; otherwise it becomes a pending equip so
 * the player can put it on a compatible ally — and if nobody can wear it, it
 * drops on the cell as ordinary loot (as a single-item backpack so the
 * drop/pickup model stays uniform). Removes the pickup either way: nothing
 * respawns. Mutates `next`.
 */
const PICKUP_CELLS = new WeakMap<object, Set<number>>();
function pickupCells(list: readonly { row: number; col: number }[]): Set<number> {
  let set = PICKUP_CELLS.get(list);
  if (!set) {
    set = new Set(list.map((p) => p.row * 100 + p.col));
    PICKUP_CELLS.set(list, set);
  }
  return set;
}

function claimHiddenPickup(next: GameState, unit: SerializedUnit, events: GameEvent[]): void {
  if (!next.hiddenPickups || next.hiddenPickups.length === 0) return;
  // O(1) "anything buried here?" — every move asks, and a search makes
  // ~100k moves a turn; the list is shared by reference until a claim.
  if (!pickupCells(next.hiddenPickups).has(unit.row * 100 + unit.col)) return;
  const idx = next.hiddenPickups.findIndex((p) => p.row === unit.row && p.col === unit.col);
  if (idx < 0) return;
  const found = next.hiddenPickups[idx]!;
  next.hiddenPickups = next.hiddenPickups.filter((_, i) => i !== idx);

  if (found.kind === 'part') {
    const name = found.name as PartName;
    unit.backpack[name] = (unit.backpack[name] ?? 0) + 1;
    events.push({
      kind: 'part-found',
      data: { unitId: unit.id, player: unit.player, name },
    });
    return;
  }

  const catalogue = found.kind === 'armor' ? ARMORS : WEAPONS;
  const gear = catalogue.find((w) => w.name === found.name);
  if (!gear) return;
  const slot: GearSlot = found.kind === 'armor' ? 'armor' : 'weapon';
  const item = gearToItem(slot, gear);

  // The finder wears it when it can.
  if (canEquipGear({ ...item, slot }, unit, unit.player)) {
    // Pass the slot through: GearItem carries none, and without it a found
    // armour piece was equipped as a weapon (+damage instead of +armour).
    equipGearToUnit(unit, { ...item, slot });
    events.push({
      kind: 'weapon-equipped',
      data: { unitId: unit.id, name: gear.name, amount: gear.amount, slot, pickedUp: true },
    });
    return;
  }

  // The finder can't wear it — leave it lying on the cell for whoever can
  // (same as the web client; there is no forced "equip an ally" step).
  dropGearOnCell(next, unit.row, unit.col, slot, item);
  events.push({
    kind: 'weapon-found',
    data: { unitId: unit.id, player: unit.player, name: gear.name, slot, dropped: true },
  });
}

/**
 * After a unit lands on `(unit.row, unit.col)`, auto-collect any dropped
 * backpack there: every weapon part goes straight into the finder's own
 * backpack, and any weapon/armour piece it can wear is equipped — all at
 * once, since a dropped backpack is picked up whole (see
 * [[per-unit-backpack]]). Gear the finder can't wear stays behind as a
 * smaller leftover backpack. Deterministic — runs identically client- and
 * server-side. Mutates `next`.
 */
function pickUpDroppedItems(next: GameState, unit: SerializedUnit, events: GameEvent[]): void {
  if (!next.droppedBackpacks || next.droppedBackpacks.length === 0) return;
  const remaining: DroppedBackpack[] = [];
  for (const pack of next.droppedBackpacks) {
    if (pack.row !== unit.row || pack.col !== unit.col) {
      remaining.push(pack);
      continue;
    }
    for (const p of PARTS) {
      const n = pack.parts[p] ?? 0;
      if (n > 0) unit.backpack[p] = (unit.backpack[p] ?? 0) + n;
    }
    if (pack.parts && PARTS.some((p) => (pack.parts[p] ?? 0) > 0)) {
      events.push({ kind: 'part-found', data: { unitId: unit.id, player: unit.player, parts: { ...pack.parts } } });
    }

    let leftoverWeapon = pack.weapon;
    if (pack.weapon && canEquipGear({ ...pack.weapon, slot: 'weapon' }, unit, unit.player)) {
      equipGearToUnit(unit, pack.weapon);
      events.push({
        kind: 'weapon-equipped',
        data: { unitId: unit.id, name: pack.weapon.name, amount: pack.weapon.amount, slot: 'weapon', pickedUp: true },
      });
      leftoverWeapon = null;
    }
    let leftoverArmor = pack.armorGear;
    if (pack.armorGear && canEquipGear({ ...pack.armorGear, slot: 'armor' }, unit, unit.player)) {
      equipGearToUnit(unit, { ...pack.armorGear, slot: 'armor' });
      events.push({
        kind: 'weapon-equipped',
        data: { unitId: unit.id, name: pack.armorGear.name, amount: pack.armorGear.amount, slot: 'armor', pickedUp: true },
      });
      leftoverArmor = null;
    }

    if (leftoverWeapon || leftoverArmor) {
      remaining.push({ row: pack.row, col: pack.col, parts: emptyBackpack(), weapon: leftoverWeapon, armorGear: leftoverArmor });
    }
  }
  next.droppedBackpacks = remaining;
}

/**
 * A catapult's ordinary shot, retargeted at an empty bridge cell instead of a
 * living unit: same range (manhattan 3–6, 3–9 from a tower) and cost (1) as
 * a normal catapult attack, but knocks 1 hit point off the bridge instead of
 * dealing damage. At 0 hit points the bridge is destroyed outright — the
 * cell reverts to plain river, impassable again until rebuilt.
 */
function applyCatapultBridgeShot(
  next: GameState,
  attacker: SerializedUnit,
  a: ServerAction & { kind: 'attack' },
): Result<GameState, ValidationError> {
  const isBridge = next.terrain.some(
    (t) => t.row === a.targetRow && t.col === a.targetCol && t.type === 'bridge',
  );
  if (!isBridge) return err('no-target', 'no living target at given cell');

  const attackerOnTower = isOnTower(next, attacker.row, attacker.col);
  const manhattan = Math.abs(a.targetRow - attacker.row) + Math.abs(a.targetCol - attacker.col);
  const bridgeTurn = turnCost(attacker, a.targetRow, a.targetCol);
  if (manhattan < CATAPULT_MIN_RANGE || manhattan > catapultMaxRangeFor(attackerOnTower) || a.cost !== 1 + bridgeTurn) {
    return err('illegal-attack', 'catapult target out of range');
  }
  if (bridgeTurn > 0) attacker.facing = facingToward(attacker.row, attacker.col, a.targetRow, a.targetCol, facingOf(attacker));

  const actErr = activateUnit(next, attacker);
  if (actErr) return { ok: false, error: actErr };

  const key = bridgeKey(a.targetRow, a.targetCol);
  const hpLeft = (next.bridgeDurability[key] ?? BRIDGE_MAX_DURABILITY) - 1;
  const events: GameEvent[] = [];
  if (hpLeft <= 0) {
    const rest = { ...next.bridgeDurability };
    delete rest[key];
    next.bridgeDurability = rest;
    next.terrain = next.terrain
      .filter((t) => !(t.row === a.targetRow && t.col === a.targetCol && t.type === 'bridge'))
      .concat([{ row: a.targetRow, col: a.targetCol, type: 'river' }]);
    sinkLootAt(next, a.targetRow, a.targetCol);
    events.push({ kind: 'bridge-burned', data: { row: a.targetRow, col: a.targetCol, by: attacker.id } });
  } else {
    next.bridgeDurability = { ...next.bridgeDurability, [key]: hpLeft };
    events.push({ kind: 'bridge-burned', data: { row: a.targetRow, col: a.targetCol, by: attacker.id, hpLeft } });
  }

  attacker.movesLeft -= a.cost;
  if (attacker.movesLeft <= 0) attacker.done = true;

  return ok(next, events);
}

/**
 * Crossbow's piercing bolt: fires along one of the 8 straight directions
 * through CROSSBOW_PIERCE_RANGE cells, hitting a unit standing on ANY of
 * them — friend or foe alike, unlike every other attack in the game. Costs a
 * flat 2 moves regardless of how many cells are actually occupied.
 */
function applyPierceAttack(
  next: GameState,
  attacker: SerializedUnit,
  a: ServerAction & { kind: 'attack' },
): Result<GameState, ValidationError> {
  if (attacker.type !== 'crossbow') return err('illegal-attack', 'only the crossbow can fire a pierce shot');
  const pierceTurn = turnCost(attacker, a.targetRow, a.targetCol);
  if (a.cost !== CROSSBOW_PIERCE_COST + pierceTurn) return err('illegal-attack', 'pierce shot has a fixed cost');

  const dr = Math.sign(a.targetRow - attacker.row);
  const dc = Math.sign(a.targetCol - attacker.col);
  const isValidDir = ALL8_DIRS.some(([r, c]) => r === dr && c === dc);
  if (!isValidDir) return err('illegal-attack', 'pierce shot must fire in a straight line');

  const line = a.targets && a.targets.length > 0
    ? a.targets
    : Array.from({ length: CROSSBOW_PIERCE_RANGE }, (_, i) => ({
        row: attacker.row + dr * (i + 1),
        col: attacker.col + dc * (i + 1),
      }));

  // Validate every cell actually lies on the claimed line, in order, no more
  // than CROSSBOW_PIERCE_RANGE deep — a client can't smuggle in extra/off-line
  // cells via `targets`.
  if (line.length > CROSSBOW_PIERCE_RANGE) {
    return err('illegal-attack', 'pierce shot line too long');
  }
  for (let i = 0; i < line.length; i++) {
    const expectRow = attacker.row + dr * (i + 1);
    const expectCol = attacker.col + dc * (i + 1);
    if (line[i]!.row !== expectRow || line[i]!.col !== expectCol) {
      return err('illegal-attack', 'pierce shot targets off the line');
    }
  }

  // No explicit board-bounds check: a cell off the 0..19 board can never
  // match a real unit's row/col, so an off-board line entry simply never
  // hits anything below — it can't be used to smuggle in a phantom target.
  const hits = line
    .map((cell) => ownOpt(next, next.units.find((u) => u.row === cell.row && u.col === cell.col && u.hp > 0)))
    .filter((u): u is SerializedUnit => !!u);
  if (hits.length === 0) return err('no-target', 'no living unit on the pierce line');
  // Allies on the line are collateral; there must be an enemy to shoot at.
  if (!hits.some((u) => u.player !== attacker.player)) return err('no-target', 'no enemy on the pierce line');

  const actErr = activateUnit(next, attacker);
  if (actErr) return { ok: false, error: actErr };

  const attackerOnTower = isOnTower(next, attacker.row, attacker.col);
  let damage = attacker.damage;
  if (attackerOnTower) damage = Math.max(1, Math.round(damage * TOWER_DAMAGE_FACTOR));
  if (next.damageBuff[attacker.player] > 0) damage += 2;

  const events: GameEvent[] = [];
  for (const target of hits) {
    // A warding mage overdrawn by an earlier hit on this same pierce line
    // may have already killed a LATER target in `hits` (if that target was
    // itself the mage). Skip anything already dead.
    if (target.hp <= 0) continue;
    let hitDamage = applyFacingDamage(damage, target, attacker.row, attacker.col);
    if (hitDamage === 0 && attacker.damage > 0) hitDamage = 1;

    // Ward check first: a shielded target takes 0 damage from this hit
    // outright (its warding mage pays energy for it, or dies overdrawn).
    if (absorbWithWard(next, target, hitDamage, events)) {
      events.push({
        kind: 'unit-attacked',
        data: { attackerId: attacker.id, targetId: target.id, damage: 0, hpLeft: target.hp, warded: true },
      });
      continue;
    }

    let damageToHp = 0;
    if (hitDamage > target.armor) {
      damageToHp = hitDamage - target.armor;
      target.armor = 0;
    } else {
      target.armor -= hitDamage;
    }
    target.hp -= damageToHp;

    events.push({
      kind: 'unit-attacked',
      data: { attackerId: attacker.id, targetId: target.id, damage: hitDamage, hpLeft: target.hp },
    });

    if (target.hp <= 0) {
      dropUnitBackpack(next, target);
      if (target.type === 'mage') clearWardsCastBy(next, target.id);
      events.push({ kind: 'unit-killed', data: { unitId: target.id } });
    }
  }
  next.units = next.units.filter((u) => u.hp > 0);
  maybeFinishMatch(next, events);

  attacker.movesLeft -= a.cost;
  if (attacker.movesLeft <= 0) attacker.done = true;
  if (pierceTurn > 0) attacker.facing = facingToward(attacker.row, attacker.col, a.targetRow, a.targetCol, facingOf(attacker));

  return ok(next, events);
}

function applyAttack(
  state: GameState,
  a: ServerAction & { kind: 'attack' },
): Result<GameState, ValidationError> {
  const next = cloneState(state);
  const attacker = ownOpt(next, findUnit(next, a.unitId));
  if (!attacker) return err('unit-not-found', `attacker ${a.unitId} not alive`);
  if (attacker.player !== next.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (attacker.done) return err('unit-cannot-act', 'unit already finished');
  if (attacker.movesLeft < a.cost) return err('no-moves-left', 'insufficient movesLeft');

  if (a.mode === 'pierce') return applyPierceAttack(next, attacker, a);

  const target = ownOpt(next, next.units.find((u) => u.row === a.targetRow && u.col === a.targetCol && u.hp > 0));
  if (!target) {
    // A catapult may fire at an empty bridge cell to shatter it (1 hit point
    // per hit) instead of requiring a living target — same range/cost rule
    // as an ordinary catapult shot.
    if (attacker.type === 'catapult') {
      return applyCatapultBridgeShot(next, attacker, a);
    }
    return err('no-target', 'no living target at given cell');
  }
  if (target.player === attacker.player) return err('illegal-attack', 'cannot attack own unit');

  // A ranged unit shooting from a mage tower gets ~1.5× range (high ground)
  // in exchange for weaker shots.
  const attackerOnTower = isOnTower(next, attacker.row, attacker.col);
  // Striking into the attacker's own back half costs +1 to turn (facing.ts).
  const turn = turnCost(attacker, a.targetRow, a.targetCol);

  // Catapult: target must be at manhattan distance 3–6 (3–9 from a tower), cost = 1.
  if (attacker.type === 'catapult') {
    const manhattan = Math.abs(a.targetRow - attacker.row) + Math.abs(a.targetCol - attacker.col);
    if (
      manhattan < CATAPULT_MIN_RANGE ||
      manhattan > catapultMaxRangeFor(attackerOnTower) ||
      a.cost !== 1 + turn
    ) {
      return err('illegal-attack', 'catapult target out of range');
    }
  }

  // Archer/crossbow: target must be within square zone. Cost equals the
  // Chebyshev distance to the target (adjacent = 1, range-2 = 2), matching
  // generateAttackActions.
  // BUGFIX: previously required a.cost === 1, which rejected every legal
  // range-2 ranged shot produced by the move generator (cost up to
  // ARCHER_SQUARE_RADIUS). Validate cost against the actual distance instead.
  if (attacker.type === 'archer' || attacker.type === 'crossbow') {
    const chebyshev = Math.max(
      Math.abs(a.targetRow - attacker.row),
      Math.abs(a.targetCol - attacker.col),
    );
    if (
      chebyshev < 1 ||
      chebyshev > archerRadiusFor(attackerOnTower) ||
      a.cost !== chebyshev + turn
    ) {
      return err('illegal-attack', 'archer/crossbow shot out of square range');
    }
  }

  // Melee strikes have a fixed price too (knight/samurai 1, cavalry 2), plus
  // the turn — without this a client could strike behind for the front price.
  if (attacker.type === 'knight' || attacker.type === 'samurai' || attacker.type === 'cavalry') {
    if (a.cost !== (attacker.type === 'cavalry' ? 2 : 1) + turn) {
      return err('illegal-attack', 'wrong cost for this strike');
    }
  }

  const actErr = activateUnit(next, attacker);
  if (actErr) return { ok: false, error: actErr };

  // Jump / l-attack: check landing cell for terrain blocks.
  if (a.mode === 'jump' || a.mode === 'l-attack') {
    if (
      next.terrain.some(
        (t) =>
          t.row === a.landingRow &&
          t.col === a.landingCol &&
          (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'),
      ) ||
      (next.constructions ?? []).some((c) => c.row === a.landingRow && c.col === a.landingCol)
    ) {
      return err('illegal-attack', 'landing cell blocked by terrain');
    }
    attacker.row = a.landingRow;
    attacker.col = a.landingCol;
  }

  // Damage formula — verbatim port of main.ts:1759-1786.
  let damage = attacker.damage;
  // Tower trade-off: extended range costs damage for ranged attackers.
  if (
    attackerOnTower &&
    (attacker.type === 'archer' || attacker.type === 'crossbow' || attacker.type === 'catapult')
  ) {
    damage = Math.max(1, Math.round(damage * TOWER_DAMAGE_FACTOR));
  }
  if (next.damageBuff[attacker.player] > 0) damage += 2;
  // From the target's back ×2, side ×1.25 — measured from where the attacker
  // strikes (after a cavalry jump: its landing cell), as the client does.
  damage = applyFacingDamage(damage, target, attacker.row, attacker.col);
  // A turn (or a jump) leaves the attacker facing its target.
  if (turn > 0 || a.mode === 'jump' || a.mode === 'l-attack') {
    attacker.facing = facingToward(attacker.row, attacker.col, target.row, target.col, facingOf(attacker));
  }
  // Archer/crossbow min-1 rule: ranged units always deal at least 1 damage.
  if (
    (attacker.type === 'archer' || attacker.type === 'crossbow') &&
    damage === 0 &&
    attacker.damage > 0
  ) {
    damage = 1;
  }

  attacker.movesLeft -= a.cost;
  if (attacker.movesLeft <= 0) attacker.done = true;

  const events: GameEvent[] = [];

  // Ward check first: a shielded target takes 0 damage from this hit
  // outright (its warding mage pays energy for it, or dies overdrawn).
  if (absorbWithWard(next, target, damage, events)) {
    events.unshift({
      kind: 'unit-attacked',
      data: { attackerId: attacker.id, targetId: target.id, damage: 0, hpLeft: target.hp, warded: true },
    });
    if (a.mode === 'jump' || a.mode === 'l-attack') {
      claimHiddenPickup(next, attacker, events);
      pickUpDroppedItems(next, attacker, events);
    }
    return ok(next, events);
  }

  let damageToHp = 0;
  if (damage > target.armor) {
    damageToHp = damage - target.armor;
    target.armor = 0;
  } else {
    target.armor -= damage;
  }
  target.hp -= damageToHp;

  events.push({
    kind: 'unit-attacked',
    data: { attackerId: attacker.id, targetId: target.id, damage, hpLeft: target.hp },
  });
  if (target.hp <= 0) {
    // Drop the slain unit's whole backpack onto its cell so it can be picked up later.
    dropUnitBackpack(next, target);
    if (target.type === 'mage') clearWardsCastBy(next, target.id);
    next.units = next.units.filter((u) => u.id !== target.id);
    events.push({ kind: 'unit-killed', data: { unitId: target.id } });
    maybeFinishMatch(next, events);
  }
  // A jump/l-attack lands the attacker on a new cell — let it grab gear there.
  // Buried loot first, then anything lying on the cell — same order as a
  // plain move and as the web client (which already claimed buried loot here).
  if (a.mode === 'jump' || a.mode === 'l-attack') {
    claimHiddenPickup(next, attacker, events);
    pickUpDroppedItems(next, attacker, events);
  }
  return ok(next, events);
}

/**
 * True when (row,col) falls inside a 4×4 castle footprint anchored at
 * (castleRow, castleCol). Exported so callers outside apply.ts (the AI's
 * evaluate()/beam search) can reuse the exact same zone rule instead of
 * reimplementing it — see castleRowFor/castleColFor below for the canonical
 * per-player anchor.
 */
export function inCastleZone(
  u: { row: number; col: number },
  castleRow: number,
  castleCol: number,
): boolean {
  return u.row >= castleRow && u.row < castleRow + 4 && u.col >= castleCol && u.col < castleCol + 4;
}

/** Row of `player`'s own castle footprint (top-left anchor row). */
export function castleRowFor(player: Player): number {
  return player === 1 ? 0 : ROWS - 4;
}

/** Column of `player`'s own castle footprint (top-left anchor col), from state. */
export function castleColFor(state: GameState, player: Player): number {
  return player === 1 ? state.castleP1Col : state.castleP2Col;
}

/** True if `player` has a living unit standing inside its own castle zone. */
export function defendsOwnCastle(state: GameState, player: Player): boolean {
  const row = castleRowFor(player);
  const col = castleColFor(state, player);
  return state.units.some((u) => u.player === player && u.hp > 0 && inCastleZone(u, row, col));
}

/** True if `player` has a living unit standing inside the OTHER player's castle zone. */
export function occupiesEnemyCastle(state: GameState, player: Player): boolean {
  const enemy: Player = player === 1 ? 2 : 1;
  const row = castleRowFor(enemy);
  const col = castleColFor(state, enemy);
  return state.units.some((u) => u.player === player && u.hp > 0 && inCastleZone(u, row, col));
}

function maybeFinishMatch(state: GameState, events: GameEvent[]): void {
  if (state.winner !== null) return;

  const p2CastleRow = ROWS - 4; // 16
  const p1CastleRow = 0;

  // P1 wins: has a unit inside P2's castle AND no P2 units defend it
  const p1InP2Castle = state.units.some(
    (u) => u.player === 1 && u.hp > 0 && inCastleZone(u, p2CastleRow, state.castleP2Col),
  );
  const p2InOwnCastle = state.units.some(
    (u) => u.player === 2 && u.hp > 0 && inCastleZone(u, p2CastleRow, state.castleP2Col),
  );
  if (p1InP2Castle && !p2InOwnCastle) {
    state.winner = 1;
    events.push({ kind: 'match-finished', data: { winner: 1 } });
    return;
  }

  // P2 wins: has a unit inside P1's castle AND no P1 units defend it
  const p2InP1Castle = state.units.some(
    (u) => u.player === 2 && u.hp > 0 && inCastleZone(u, p1CastleRow, state.castleP1Col),
  );
  const p1InOwnCastle = state.units.some(
    (u) => u.player === 1 && u.hp > 0 && inCastleZone(u, p1CastleRow, state.castleP1Col),
  );
  if (p2InP1Castle && !p1InOwnCastle) {
    state.winner = 2;
    events.push({ kind: 'match-finished', data: { winner: 2 } });
  }
}

/**
 * End the current turn. Resets done/movesLeft for the next player, decrements
 * shield/buff timers for the ending player, advances turnNumber.
 * Symmetric with `AIPlayer.applyEndOfTurn` in packages/web/src/game/ai.ts.
 */
export function endTurn(state: GameState): GameState {
  const next = cloneState(state);
  const ending = next.currentPlayer;
  const upcoming = ending === 1 ? 2 : 1;
  // Every unit's activation flag resets, so every unit gets its own copy.
  next.units = next.units.map(cloneUnit);
  ownedFor = next;
  owned.length = 0;
  owned.push(...next.units);
  next.units.forEach((u) => {
    // Activation resets for everyone; moves/done refill for the upcoming player.
    u.activated = false;
    if (u.player === upcoming && u.hp > 0) {
      u.done = false;
      const t = UNIT_TYPES[u.type as UnitTypeKey];
      u.movesLeft = t ? t.moves : u.movesLeft;
      // Mage energy regenerates at the start of its own side's turn.
      if (u.type === 'mage') {
        const max = u.maxEnergy ?? MAGE_MAX_ENERGY;
        u.energy = Math.min(max, (u.energy ?? max) + MAGE_ENERGY_REGEN_PER_TURN);
      }
    }
  });
  next.activatedCount = 0;
  if (next.shieldTurns[ending] > 0) next.shieldTurns[ending] -= 1;
  if (next.damageBuff[ending] > 0) next.damageBuff[ending] -= 1;
  next.currentPlayer = upcoming;
  next.turnNumber += 1;
  return next;
}

function applyResign(state: GameState, player: Player): Result<GameState, ValidationError> {
  if (player !== 1 && player !== 2) return err('unknown-action', 'invalid player');
  const next = cloneState(state);
  next.winner = player === 1 ? 2 : 1;
  return ok(next, [{ kind: 'match-finished', data: { winner: next.winner, reason: 'resign' } }]);
}

function isOnTower(state: GameState, row: number, col: number): boolean {
  return state.towers.some((t) => t.row === row && t.col === col);
}

/**
 * Craft a weapon (Солнечный меч / Синий лук) from a unit's own backpack of
 * weapon parts. Mirrors
 * the web client's craftWeapon(): requires a unit with a move to spend, deducts
 * the recipe and equips the crafter. If the crafter can't wear it, the weapon
 * is left on its cell (the move is still spent), exactly as in the offline game.
 */
/** True if `backpack` holds at least `recipe`'s counts of every part. */
function canAffordFromBackpack(backpack: Backpack, recipe: Partial<Record<PartName, number>>): boolean {
  for (const [part, n] of Object.entries(recipe)) {
    if ((backpack[part as PartName] ?? 0) < (n ?? 0)) return false;
  }
  return true;
}

function applyCraft(
  state: GameState,
  unitId: number,
  index: number,
): Result<GameState, ValidationError> {
  const weapon = WEAPONS[index];
  if (!weapon) return err('unknown-action', `no weapon at index ${index}`);
  const u = findUnit(state, unitId);
  if (!u) return err('unit-not-found', `unit ${unitId} not alive`);
  if (u.player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (u.done) return err('unit-cannot-act', 'unit already finished');
  if (u.movesLeft < 1) return err('no-moves-left', 'crafting costs one move');
  if (!canAffordFromBackpack(u.backpack, weapon.recipe)) {
    return err('craft-unaffordable', 'missing parts');
  }
  const next = cloneState(state);
  const nextU = own(next, next.units.find((x) => x.id === unitId)!);
  const actErr = activateUnit(next, nextU);
  if (actErr) return { ok: false, error: actErr };
  for (const [part, n] of Object.entries(weapon.recipe)) {
    nextU.backpack[part as PartName] -= n ?? 0;
  }
  nextU.movesLeft = Math.max(0, nextU.movesLeft - 1);
  if (nextU.movesLeft <= 0) nextU.done = true;

  // The crafter gets the weapon by default when it's able to wear it;
  // otherwise it's offered to any eligible ally, same as looted gear.
  const pending = weaponToPending(weapon);
  if (canEquipGear(pending, nextU, next.currentPlayer)) {
    equipGearToUnit(nextU, pending);
    return ok(next, [{ kind: 'weapon-crafted', data: { unitId, index, name: weapon.name, dropped: false } }]);
  }
  // The crafter can't wear it — it's left on the crafter's cell (web client
  // parity: no forced equip picker).
  dropGearOnCell(next, nextU.row, nextU.col, 'weapon', gearToItem('weapon', weapon));
  return ok(next, [
    {
      kind: 'weapon-crafted',
      data: { unitId, index, name: weapon.name, dropped: true },
    },
  ]);
}

/**
 * Craft a piece of armour from the crafter's own backpack. Mirrors applyCraft
 * but indexes the ARMORS catalogue and produces a pending equip in the armour slot.
 */
function applyCraftArmor(
  state: GameState,
  unitId: number,
  index: number,
): Result<GameState, ValidationError> {
  const armor = ARMORS[index];
  if (!armor) return err('unknown-action', `no armor at index ${index}`);
  const u = findUnit(state, unitId);
  if (!u) return err('unit-not-found', `unit ${unitId} not alive`);
  if (u.player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (u.done) return err('unit-cannot-act', 'unit already finished');
  if (u.movesLeft < 1) return err('no-moves-left', 'crafting costs one move');
  if (!canAffordFromBackpack(u.backpack, armor.recipe)) {
    return err('craft-unaffordable', 'missing parts');
  }
  const next = cloneState(state);
  const nextU = own(next, next.units.find((x) => x.id === unitId)!);
  const actErr = activateUnit(next, nextU);
  if (actErr) return { ok: false, error: actErr };
  for (const [part, n] of Object.entries(armor.recipe)) {
    nextU.backpack[part as PartName] -= n ?? 0;
  }
  nextU.movesLeft = Math.max(0, nextU.movesLeft - 1);
  if (nextU.movesLeft <= 0) nextU.done = true;

  const pending = weaponToPending(armor);
  if (canEquipGear(pending, nextU, next.currentPlayer)) {
    equipGearToUnit(nextU, pending);
    return ok(next, [
      { kind: 'weapon-crafted', data: { unitId, index, name: armor.name, slot: 'armor', dropped: false } },
    ]);
  }
  dropGearOnCell(next, nextU.row, nextU.col, 'armor', gearToItem('armor', armor));
  return ok(next, [
    {
      kind: 'weapon-crafted',
      data: { unitId, index, name: armor.name, slot: 'armor', dropped: true },
    },
  ]);
}

function applyDrawPart(
  state: GameState,
  unitId: number,
  rng: Rng,
): Result<GameState, ValidationError> {
  const u = findUnit(state, unitId);
  if (!u) return err('unit-not-found', `unit ${unitId} not alive`);
  if (u.player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  return applySearchRuins(state, unitId, rng);
}

function applyEquipWeapon(state: GameState, unitId: number): Result<GameState, ValidationError> {
  const pending = state.pendingWeaponEquip;
  if (!pending) return err('no-pending-weapon', 'no weapon awaiting equip');
  const u = findUnit(state, unitId);
  if (!u) return err('unit-not-found', `unit ${unitId} not alive`);
  if (!canEquipGear(pending, u, state.currentPlayer)) {
    return err('cannot-equip', 'unit cannot equip this item');
  }
  const next = cloneState(state);
  const target = own(next, next.units.find((x) => x.id === unitId)!);
  equipGearToUnit(target, pending);
  next.pendingWeaponEquip = null;
  return ok(next, [
    {
      kind: 'weapon-equipped',
      data: { unitId, name: pending.name, amount: pending.amount, slot: pending.slot ?? 'weapon' },
    },
  ]);
}

/**
 * Hand weapon parts and/or a carried weapon/armour piece from one of your own
 * units to another standing adjacent. Free — costs no moves, doesn't require
 * either unit to be "actable" (not done, not already activated), and doesn't
 * count toward the per-turn activation cap. Both units must belong to the
 * player whose turn it is.
 */
function applyTransferItems(
  state: GameState,
  a: ServerAction & { kind: 'transfer-items' },
): Result<GameState, ValidationError> {
  const from = findUnit(state, a.fromUnitId);
  const to = findUnit(state, a.toUnitId);
  if (!from || !to) return err('unit-not-found', 'both units must be alive');
  if (from.id === to.id) return err('unknown-action', 'cannot transfer to yourself');
  if (from.player !== state.currentPlayer || to.player !== state.currentPlayer) {
    return err('wrong-turn', 'both units must belong to the current player');
  }
  const chebyshev = Math.max(Math.abs(from.row - to.row), Math.abs(from.col - to.col));
  if (chebyshev > 1) return err('not-adjacent', 'units must stand adjacent to transfer items');

  const parts = a.parts ?? {};
  const wantsWeapon = !!a.weapon;
  const wantsArmor = !!a.armor;
  let anyRequested = wantsWeapon || wantsArmor;
  for (const n of Object.values(parts)) {
    if ((n ?? 0) > 0) anyRequested = true;
  }
  if (!anyRequested) return err('nothing-to-transfer', 'nothing selected to hand over');

  // Validate parts: sender must actually hold at least as many of each as requested.
  for (const [part, n] of Object.entries(parts)) {
    if ((n ?? 0) < 0) return err('nothing-to-transfer', 'negative part count');
    if ((from.backpack[part as PartName] ?? 0) < (n ?? 0)) {
      return err('nothing-to-transfer', `sender doesn't have enough ${part}`);
    }
  }
  if (wantsWeapon && !from.weapon) return err('nothing-to-transfer', 'sender has no weapon to hand over');
  if (wantsArmor && !from.armorGear) return err('nothing-to-transfer', 'sender has no armour to hand over');
  // Receiver must have the slot free for anything it's about to receive.
  if (wantsWeapon && to.weapon) return err('cannot-equip', 'receiver already carries a weapon');
  if (wantsArmor && to.armorGear) return err('cannot-equip', 'receiver already carries armour');
  // A weapon/armour piece the receiving unit type can't legally wear can't be
  // handed over either — it would just sit unusable in a slot that blocks any
  // future pickup.
  if (wantsWeapon && from.weapon && !canEquipGear(gearToItem('weapon', from.weapon), to, state.currentPlayer)) {
    return err('cannot-equip', "receiver's unit type cannot equip this weapon");
  }
  if (
    wantsArmor &&
    from.armorGear &&
    !canEquipGear({ ...gearToItem('armor', from.armorGear), slot: 'armor' }, to, state.currentPlayer)
  ) {
    return err('cannot-equip', "receiver's unit type cannot equip this armour");
  }

  const next = cloneState(state);
  const nextFrom = own(next, next.units.find((u) => u.id === from.id)!);
  const nextTo = own(next, next.units.find((u) => u.id === to.id)!);

  for (const [part, n] of Object.entries(parts)) {
    if (!n) continue;
    nextFrom.backpack[part as PartName] -= n;
    nextTo.backpack[part as PartName] = (nextTo.backpack[part as PartName] ?? 0) + n;
  }
  if (wantsWeapon && nextFrom.weapon) {
    nextTo.damage += nextFrom.weapon.amount;
    nextTo.weapon = nextFrom.weapon;
    nextFrom.damage -= nextFrom.weapon.amount;
    nextFrom.weapon = null;
  }
  if (wantsArmor && nextFrom.armorGear) {
    nextTo.armor += nextFrom.armorGear.amount;
    nextTo.maxArmor += nextFrom.armorGear.amount;
    nextTo.armorGear = nextFrom.armorGear;
    nextFrom.armor = Math.max(0, nextFrom.armor - nextFrom.armorGear.amount);
    nextFrom.maxArmor = Math.max(0, nextFrom.maxArmor - nextFrom.armorGear.amount);
    nextFrom.armorGear = null;
  }

  return ok(next, [
    {
      kind: 'items-transferred',
      data: { fromUnitId: from.id, toUnitId: to.id, parts, weapon: wantsWeapon, armor: wantsArmor },
    },
  ]);
}

function applySearchRuins(
  state: GameState,
  unitId: number,
  rng: Rng,
): Result<GameState, ValidationError> {
  const u = findUnit(state, unitId);
  if (!u) return err('unit-not-found', `unit ${unitId} not alive`);
  if (u.player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (u.done) return err('unit-cannot-act', 'unit already finished');
  if (!inRuinsArea(state.ruins, u.row, u.col) && !inRuinsArea(state.ruins2, u.row, u.col)) {
    return err('unit-not-on-ruins', 'unit must be standing on ruins');
  }
  const next = cloneState(state);
  const acted = own(next, next.units.find((x) => x.id === unitId)!);
  const actErr = activateUnit(next, acted);
  if (actErr) return { ok: false, error: actErr };
  const loot = pickLoot(rng);
  if (loot.type === 'part') {
    acted.backpack[loot.name] += 1;
  } else if (loot.type === 'weapon' || loot.type === 'armor') {
    // Looted gear must be equipped to an eligible ally, just like a crafted
    // one; if nobody can take it the gear is dropped.
    const catalogue = loot.type === 'armor' ? ARMORS : WEAPONS;
    const gear = catalogue.find((w) => w.name === loot.name);
    if (gear) {
      const pending = weaponToPending(gear);
      if (next.units.some((t) => canEquipGear(pending, t, next.currentPlayer))) {
        next.pendingWeaponEquip = pending;
      }
    }
  }
  next.rngCursor += 1;
  // Mark unit done — searching consumes the turn.
  acted.movesLeft = 0;
  acted.done = true;
  return ok(next, [{ kind: 'ruins-searched', data: { unitId, loot } }]);
}

/**
 * Restore a unit to full hp/armour while it stands in its OWN castle. Mirrors
 * the web client's applyCastleHealing: costs the unit its whole turn.
 */
function applyCastleHeal(state: GameState, unitId: number): Result<GameState, ValidationError> {
  const u = findUnit(state, unitId);
  if (!u) return err('unit-not-found', `unit ${unitId} not alive`);
  if (u.player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (u.done) return err('unit-cannot-act', 'unit already finished');
  if (u.movesLeft < 1) return err('no-moves-left', 'healing costs a move');
  const ownCastleRow = u.player === 1 ? 0 : ROWS - 4;
  const ownCastleCol = u.player === 1 ? state.castleP1Col : state.castleP2Col;
  if (!inCastleZone(u, ownCastleRow, ownCastleCol)) {
    return err('unit-not-in-castle', 'unit must stand in its own castle to heal');
  }
  const next = cloneState(state);
  const acted = own(next, next.units.find((x) => x.id === unitId)!);
  const actErr = activateUnit(next, acted);
  if (actErr) return { ok: false, error: actErr };
  acted.hp = acted.maxHp;
  acted.armor = acted.maxArmor;
  acted.movesLeft = 0;
  acted.done = true;
  return ok(next, [{ kind: 'castle-healed', data: { player: acted.player, unitId } }]);
}

/**
 * Shared entry checks for all 4 mage-* actions: the acting unit must be a
 * living mage belonging to the current player, not yet done, with a move
 * left to spend (each ability costs exactly 1 move on top of its energy —
 * see MAGE_* constants in constants.ts). Returns the mage on success.
 */
function requireActingMage(state: GameState, unitId: number): SerializedUnit | ValidationError {
  const u = findUnit(state, unitId);
  if (!u) return { code: 'unit-not-found', message: `unit ${unitId} not alive` };
  if (u.player !== state.currentPlayer) return { code: 'wrong-turn', message: "not this player's turn" };
  if (u.type !== 'mage') return { code: 'not-a-mage', message: 'only a mage can use this ability' };
  if (u.done) return { code: 'unit-cannot-act', message: 'unit already finished' };
  if (u.movesLeft < 1) return { code: 'no-moves-left', message: 'ability costs a move' };
  return u;
}

function isValidationError(x: SerializedUnit | ValidationError): x is ValidationError {
  return 'code' in x;
}

/** A 1-move ability aimed at (row, col) — mage abilities, a catapult rock:
 *  +TURN_COST when that cell is in the unit's back half (it turns to face it). See facing.ts. */
function mageMoveCost(mage: SerializedUnit, row: number, col: number): number {
  return 1 + turnCost(mage, row, col);
}

function spendMageMove(mage: SerializedUnit, row: number, col: number): void {
  const turn = turnCost(mage, row, col);
  mage.movesLeft -= 1 + turn;
  if (turn > 0) mage.facing = facingToward(mage.row, mage.col, row, col, facingOf(mage));
}

/**
 * Mage attack: the player picks how much damage to deal (>=1) to one enemy
 * at any Chebyshev distance, no line-of-sight check. Costs 1 move plus
 * `chosenDamage * 1 + distance * MAGE_ATTACK_ENERGY_PER_CELL` energy — same
 * "1 energy per point, plus distance" shape as mage-heal. Armour absorbs
 * first, same damage split as a normal attack. MAGE_ATTACK_DAMAGE is no
 * longer the dealt amount (kept only as a UI default/suggestion).
 */
function applyMageAttack(
  state: GameState,
  a: ServerAction & { kind: 'mage-attack' },
): Result<GameState, ValidationError> {
  const mage = requireActingMage(state, a.unitId);
  if (isValidationError(mage)) return { ok: false, error: mage };

  const target = state.units.find((u) => u.row === a.targetRow && u.col === a.targetCol && u.hp > 0);
  if (!target) return err('no-target', 'no living target at given cell');
  if (target.player === mage.player) return err('illegal-attack', 'cannot attack own unit');

  const chosenDamage = Math.floor(a.damage);
  if (!Number.isFinite(chosenDamage) || chosenDamage < 1) {
    return err('illegal-attack', 'damage must be a positive integer');
  }

  if (mage.movesLeft < mageMoveCost(mage, a.targetRow, a.targetCol)) return err('no-moves-left', 'turning round costs a move');
  const chebyshev = Math.max(Math.abs(a.targetRow - mage.row), Math.abs(a.targetCol - mage.col));
  const cost = chosenDamage * MAGE_ATTACK_ENERGY_PER_HP + chebyshev * MAGE_ATTACK_ENERGY_PER_CELL;
  if ((mage.energy ?? 0) < cost) return err('no-energy', 'not enough energy for this attack');

  const next = cloneState(state);
  const nextMage = own(next, next.units.find((x) => x.id === mage.id)!);
  const nextTarget = own(next, next.units.find((x) => x.id === target.id)!);
  const actErr = activateUnit(next, nextMage);
  if (actErr) return { ok: false, error: actErr };

  let damage = chosenDamage;
  if (next.damageBuff[nextMage.player] > 0) damage += 2;
  damage = applyFacingDamage(damage, nextTarget, nextMage.row, nextMage.col);

  nextMage.energy = (nextMage.energy ?? 0) - cost;
  spendMageMove(nextMage, a.targetRow, a.targetCol);
  if (nextMage.movesLeft <= 0) nextMage.done = true;

  const events: GameEvent[] = [];

  // Ward check first — note this can kill nextMage itself if it's overdrawn
  // (e.g. the target is warded by this same mage, an edge case but not
  // rejected: the attack already committed its move/energy).
  if (absorbWithWard(next, nextTarget, damage, events)) {
    events.unshift({
      kind: 'mage-attacked',
      data: { unitId: nextMage.id, targetId: nextTarget.id, damage: 0, hpLeft: nextTarget.hp, cost, warded: true },
    });
    return ok(next, events);
  }

  let damageToHp = 0;
  if (damage > nextTarget.armor) {
    damageToHp = damage - nextTarget.armor;
    nextTarget.armor = 0;
  } else {
    nextTarget.armor -= damage;
  }
  nextTarget.hp -= damageToHp;

  events.push({ kind: 'mage-attacked', data: { unitId: nextMage.id, targetId: nextTarget.id, damage, hpLeft: nextTarget.hp, cost } });
  if (nextTarget.hp <= 0) {
    dropUnitBackpack(next, nextTarget);
    if (nextTarget.type === 'mage') clearWardsCastBy(next, nextTarget.id);
    next.units = next.units.filter((u) => u.id !== nextTarget.id);
    events.push({ kind: 'unit-killed', data: { unitId: nextTarget.id } });
    maybeFinishMatch(next, events);
  }
  return ok(next, events);
}

/**
 * Ward: a per-unit shield, toggled in bulk. Every id in `toggleUnitIds`
 * flips — an unwarded living ally becomes warded by this mage; a unit this
 * mage is currently warding has its ward removed. Ids that don't resolve to
 * a living ally of the mage's own side are silently skipped (client-side
 * targeting already restricts the picker to legal ids; a stale id just does
 * nothing rather than failing the whole batch).
 *
 * Free of energy cost up front — the whole point of this ability is that
 * warding costs nothing until a warded unit is actually hit (see
 * absorbWithWard). Costs exactly 1 move, no matter how many ids are
 * toggled — the client batches an entire pick/unpick session into one
 * `mage-ward` action (see [[kc-mage-ward-mechanic]]).
 */
function applyMageWard(
  state: GameState,
  a: ServerAction & { kind: 'mage-ward' },
): Result<GameState, ValidationError> {
  const mage = requireActingMage(state, a.unitId);
  if (isValidationError(mage)) return { ok: false, error: mage };

  const toggled = a.toggleUnitIds.filter((id) =>
    state.units.some((u) => u.id === id && u.hp > 0 && u.player === mage.player),
  );
  if (toggled.length === 0) return err('no-warding-target', 'no living ally to toggle');

  const next = cloneState(state);
  const nextMage = own(next, next.units.find((x) => x.id === mage.id)!);
  const actErr = activateUnit(next, nextMage);
  if (actErr) return { ok: false, error: actErr };

  const added: number[] = [];
  const removed: number[] = [];
  for (const id of toggled) {
    const u = ownOpt(next, next.units.find((x) => x.id === id && x.hp > 0));
    if (!u) continue;
    if (u.wardedBy === nextMage.id) {
      u.wardedBy = null;
      removed.push(id);
    } else {
      // Re-warding a unit currently shielded by a DIFFERENT mage simply
      // switches which mage is on the hook for it.
      u.wardedBy = nextMage.id;
      added.push(id);
    }
  }
  nextMage.warding = next.units.filter((u) => u.wardedBy === nextMage.id).map((u) => u.id);
  nextMage.movesLeft -= 1;
  if (nextMage.movesLeft <= 0) nextMage.done = true;

  return ok(next, [
    { kind: 'mage-warded', data: { unitId: nextMage.id, added, removed } },
  ]);
}

/**
 * Drain: the mage takes 1 HP from an adjacent unit (ally or enemy, as long
 * as that unit isn't warded by some OTHER mage) and converts it straight to
 * energy at MAGE_DRAIN_ENERGY_PER_HP energy per HP. Costs a move but no
 * energy of its own — it's how a mage refuels mid-fight.
 *
 * Draining a target warded by a DIFFERENT mage is blocked outright (that
 * mage's shield isn't this mage's to spend down). Draining a target this
 * SAME mage is warding is allowed — the 1 hp still goes through the ward
 * (absorbWithWard), which is a no-op drain of energy from itself; that's an
 * intentionally odd edge case left as-is rather than special-cased away.
 */
function applyMageDrain(
  state: GameState,
  a: ServerAction & { kind: 'mage-drain' },
): Result<GameState, ValidationError> {
  const mage = requireActingMage(state, a.unitId);
  if (isValidationError(mage)) return { ok: false, error: mage };

  const target = findUnit(state, a.targetUnitId);
  if (!target) return err('unit-not-found', 'drain target not alive');
  if (target.id === mage.id) return err('illegal-attack', 'cannot drain yourself');
  const chebyshev = Math.max(Math.abs(target.row - mage.row), Math.abs(target.col - mage.col));
  if (chebyshev > 1) return err('not-adjacent', 'drain target must stand adjacent');
  if (mage.movesLeft < mageMoveCost(mage, target.row, target.col)) return err('no-moves-left', 'turning round costs a move');
  if (target.wardedBy && target.wardedBy !== mage.id) {
    return err('illegal-attack', 'target is warded by another mage');
  }
  if (target.hp <= 1) return err('illegal-attack', 'cannot drain a target down to 0 hp');

  const next = cloneState(state);
  const nextMage = own(next, next.units.find((x) => x.id === mage.id)!);
  const nextTarget = own(next, next.units.find((x) => x.id === target.id)!);
  const actErr = activateUnit(next, nextMage);
  if (actErr) return { ok: false, error: actErr };

  const events: GameEvent[] = [];
  if (absorbWithWard(next, nextTarget, 1, events)) {
    events.unshift({
      kind: 'mage-drained',
      data: { unitId: nextMage.id, targetId: nextTarget.id, hpLeft: nextTarget.hp, energyGained: 0, warded: true },
    });
    // absorbWithWard may have just killed nextMage itself (self-warded target,
    // overdrawn) — only spend its move if it's still alive to spend it.
    if (nextMage.hp > 0) {
      spendMageMove(nextMage, target.row, target.col);
      if (nextMage.movesLeft <= 0) nextMage.done = true;
    }
    return ok(next, events);
  }

  nextTarget.hp -= 1;
  const maxEnergy = nextMage.maxEnergy ?? MAGE_MAX_ENERGY;
  nextMage.energy = Math.min(maxEnergy, (nextMage.energy ?? 0) + MAGE_DRAIN_ENERGY_PER_HP);
  spendMageMove(nextMage, target.row, target.col);
  if (nextMage.movesLeft <= 0) nextMage.done = true;

  events.push({
    kind: 'mage-drained',
    data: { unitId: nextMage.id, targetId: nextTarget.id, hpLeft: nextTarget.hp, energyGained: MAGE_DRAIN_ENERGY_PER_HP },
  });
  return ok(next, events);
}

/**
 * Burn bridge: destroys a built bridge outright at any Chebyshev distance
 * (no partial-durability chipping like a catapult hit — one cast removes it
 * completely). Costs 1 move plus distance × MAGE_BURN_BRIDGE_ENERGY_PER_CELL
 * energy.
 */
function applyMageBurnBridge(
  state: GameState,
  a: ServerAction & { kind: 'mage-burn-bridge' },
): Result<GameState, ValidationError> {
  const mage = requireActingMage(state, a.unitId);
  if (isValidationError(mage)) return { ok: false, error: mage };

  const isBridge = state.terrain.some((t) => t.row === a.row && t.col === a.col && t.type === 'bridge');
  if (!isBridge) return err('no-bridge-here', 'no bridge at given cell');
  // Burning a bridge out from under a unit would leave it standing in the
  // river — same rule as building one: the cell must be empty.
  if (state.units.some((u) => u.hp > 0 && u.row === a.row && u.col === a.col)) {
    return err('cell-occupied', 'a unit is standing on the bridge');
  }

  if (mage.movesLeft < mageMoveCost(mage, a.row, a.col)) return err('no-moves-left', 'turning round costs a move');
  const chebyshev = Math.max(Math.abs(a.row - mage.row), Math.abs(a.col - mage.col));
  const cost = chebyshev * MAGE_BURN_BRIDGE_ENERGY_PER_CELL;
  if ((mage.energy ?? 0) < cost) return err('no-energy', 'not enough energy to burn this bridge');

  const next = cloneState(state);
  const nextMage = own(next, next.units.find((x) => x.id === mage.id)!);
  const actErr = activateUnit(next, nextMage);
  if (actErr) return { ok: false, error: actErr };

  const key = bridgeKey(a.row, a.col);
  const rest = { ...next.bridgeDurability };
  delete rest[key];
  next.bridgeDurability = rest;
  next.terrain = next.terrain
    .filter((t) => !(t.row === a.row && t.col === a.col && t.type === 'bridge'))
    .concat([{ row: a.row, col: a.col, type: 'river' }]);
  sinkLootAt(next, a.row, a.col);

  nextMage.energy = (nextMage.energy ?? 0) - cost;
  spendMageMove(nextMage, a.row, a.col);
  if (nextMage.movesLeft <= 0) nextMage.done = true;

  return ok(next, [{ kind: 'bridge-burned', data: { row: a.row, col: a.col, by: nextMage.id, cost } }]);
}

/**
 * Heal: restores HP to any living unit — self or ally, no enemy — at any
 * Chebyshev distance. 1 HP = 1 energy (MAGE_HEAL_ENERGY_PER_HP) is the base
 * cost; on top of that, distance to the target always adds its own cost at
 * MAGE_HEAL_ENERGY_PER_CELL energy per cell (Chebyshev), same shape as
 * mage-attack/mage-burn-bridge — the farther away the target, the more it
 * costs to reach, on top of however much HP is actually restored. Heals up
 * to the target's maxHp; healing 0 (already full) is rejected outright
 * rather than silently burning a move and energy for nothing.
 */
function applyMageHeal(
  state: GameState,
  a: ServerAction & { kind: 'mage-heal' },
): Result<GameState, ValidationError> {
  const mage = requireActingMage(state, a.unitId);
  if (isValidationError(mage)) return { ok: false, error: mage };

  const target = findUnit(state, a.targetUnitId);
  if (!target) return err('no-heal-target', 'heal target not alive');
  if (target.player !== mage.player) return err('no-heal-target', 'can only heal your own units');
  if (target.hp >= target.maxHp) return err('already-full-hp', 'target is already at full hp');

  const chebyshev = Math.max(Math.abs(target.row - mage.row), Math.abs(target.col - mage.col));
  const missingHp = target.maxHp - target.hp;
  const healedHp = missingHp; // full top-up in one cast
  const cost = healedHp * MAGE_HEAL_ENERGY_PER_HP + chebyshev * MAGE_HEAL_ENERGY_PER_CELL;
  if ((mage.energy ?? 0) < cost) return err('no-energy', 'not enough energy for this heal');

  const next = cloneState(state);
  const nextMage = own(next, next.units.find((x) => x.id === mage.id)!);
  const nextTarget = own(next, next.units.find((x) => x.id === target.id)!);
  const actErr = activateUnit(next, nextMage);
  if (actErr) return { ok: false, error: actErr };

  nextTarget.hp = nextTarget.maxHp;
  nextMage.energy = (nextMage.energy ?? 0) - cost;
  nextMage.movesLeft -= 1;
  if (nextMage.movesLeft <= 0) nextMage.done = true;

  return ok(next, [
    {
      kind: 'mage-healed',
      data: { unitId: nextMage.id, targetId: nextTarget.id, healedHp, hpLeft: nextTarget.hp, cost, distance: chebyshev },
    },
  ]);
}

/** True when (row,col) is impassable for reasons OTHER than an in-progress
 * construction: river/mountain/rock terrain, or a live unit standing there. */
function isBlockedByTerrainOrUnit(state: GameState, row: number, col: number): boolean {
  if (state.units.some((u) => u.hp > 0 && u.row === row && u.col === col)) return true;
  return state.terrain.some(
    (t) => t.row === row && t.col === col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'),
  );
}

function bridgeKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * A knight builds a tower or bridge by standing on a cell orthogonally
 * adjacent to the target cell and spending its whole turn (all movesLeft,
 * which must be exactly its full BUILD_COST_PER_TURN — it can't half-commit
 * moves elsewhere first) on the site. Any knight can add work to an
 * in-progress site, including one a different knight started; the site
 * tracks progress, not who's building it. Counts as the knight's activation.
 *
 * The target cell is impassable (like a mountain) while under construction.
 * Once `progress` reaches BUILD_WORK_TOTAL the site is promoted: a tower
 * becomes a real TowerPosition, a bridge overwrites the river cell there
 * with a `bridge` TerrainCell and gets BRIDGE_MAX_DURABILITY hit points.
 */
function applyBuild(
  state: GameState,
  unitId: number,
  row: number,
  col: number,
  kind: 'tower' | 'bridge',
): Result<GameState, ValidationError> {
  const u = findUnit(state, unitId);
  if (!u) return err('unit-not-found', `unit ${unitId} not alive`);
  if (u.player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (u.type !== 'knight') return err('unit-cannot-act', 'only a knight can build');
  if (u.done) return err('unit-cannot-act', 'unit already finished');
  if (u.movesLeft !== BUILD_COST_PER_TURN) {
    return err('no-moves-left', 'building spends the knight\'s whole turn, all at once');
  }
  if (!insideBoard(row, col)) return err('not-empty-cell', 'target cell is off the board');
  const chebyshev = Math.max(Math.abs(row - u.row), Math.abs(col - u.col));
  const isOrtho = (row === u.row || col === u.col) && chebyshev === 1;
  if (!isOrtho) return err('not-adjacent', 'must build from an orthogonally adjacent cell');

  const existing = state.constructions.find((c) => c.row === row && c.col === col);
  if (existing && existing.kind !== kind) {
    return err('already-built', 'a different structure is already under construction here');
  }
  if (!existing) {
    if (kind === 'tower') {
      if (state.towers.some((t) => t.row === row && t.col === col)) {
        return err('already-built', 'a tower already stands here');
      }
      // A bridge isn't open ground either (the client never offers it).
      const onBridge = state.terrain.some((t) => t.row === row && t.col === col && t.type === 'bridge');
      if (onBridge || isBlockedByTerrainOrUnit(state, row, col)) {
        return err('not-empty-cell', 'target cell is not free to build on');
      }
    } else {
      const isRiver = state.terrain.some((t) => t.row === row && t.col === col && t.type === 'river');
      if (!isRiver) return err('not-river-cell', 'a bridge can only be built on a river cell');
      if (state.units.some((o) => o.hp > 0 && o.row === row && o.col === col)) {
        return err('cell-occupied', 'a unit is standing on the river cell');
      }
    }
  }

  const next = cloneState(state);
  const nextU = own(next, next.units.find((x) => x.id === unitId)!);
  // The building knight still uses one of the turn's activations, same as the
  // client (selecting a unit activates it) — otherwise building would be a
  // way around MAX_ACTIVATIONS_PER_TURN.
  const actErr = activateUnit(next, nextU);
  if (actErr) return { ok: false, error: actErr };
  nextU.movesLeft = 0;
  nextU.done = true;

  const site = next.constructions.find((c) => c.row === row && c.col === col);
  const progress = (site ? site.progress : 0) + BUILD_COST_PER_TURN;
  const events: GameEvent[] = [];

  if (progress >= BUILD_WORK_TOTAL) {
    // Finished — promote the site and remove it from constructions.
    next.constructions = next.constructions.filter((c) => !(c.row === row && c.col === col));
    if (kind === 'tower') {
      next.towers = [...next.towers, { row, col }];
      events.push({ kind: 'tower-built', data: { row, col, unitId } });
    } else {
      next.terrain = next.terrain
        .filter((t) => !(t.row === row && t.col === col))
        .concat([{ row, col, type: 'bridge' }]);
      next.bridgeDurability = { ...next.bridgeDurability, [bridgeKey(row, col)]: BRIDGE_MAX_DURABILITY };
      events.push({ kind: 'bridge-built', data: { row, col, unitId } });
    }
  } else if (site) {
    next.constructions = next.constructions.map((c) =>
      c.row === row && c.col === col ? { ...c, progress } : c,
    );
  } else {
    next.constructions = [...next.constructions, { row, col, kind, progress }];
  }

  return ok(next, events);
}

/** Rows kept clear in front of each castle gate — boulders may not seal a keep. */
const ROCK_CASTLE_APPROACH = 2;

/**
 * True when (row,col) lies in a castle footprint or the approach strip in
 * front of its gate — the band where a catapult may not drop a boulder.
 * Orientation-free (both ends of the board are covered), so the client can
 * use it on its physical board unchanged.
 */
export function isRockForbiddenZone(row: number, col: number, castleCols: readonly number[]): boolean {
  return castleCols.some(
    (cc) =>
      col >= cc &&
      col < cc + 4 &&
      (row < 5 + ROCK_CASTLE_APPROACH || row >= ROWS - 5 - ROCK_CASTLE_APPROACH),
  );
}

/**
 * Whether a catapult may aim a boulder at (row,col): empty ground (or an
 * existing rock, which it shatters), never a unit, tower, river, bridge,
 * mountain, construction site, dropped loot, or the castle approach zone.
 */
export function rockTargetAllowed(state: GameState, row: number, col: number): boolean {
  if (!insideBoard(row, col)) return false;
  if (state.units.some((u) => u.hp > 0 && u.row === row && u.col === col)) return false;
  if (state.towers.some((t) => t.row === row && t.col === col)) return false;
  if (
    state.terrain.some(
      (t) => t.row === row && t.col === col && (t.type === 'river' || t.type === 'bridge' || t.type === 'mountain'),
    )
  ) {
    return false;
  }
  if ((state.constructions ?? []).some((c) => c.row === row && c.col === col)) return false;
  if ((state.droppedBackpacks ?? []).some((d) => d.row === row && d.col === col)) return false;
  return !isRockForbiddenZone(row, col, [state.castleP1Col, state.castleP2Col]);
}

function applyThrowRock(
  state: GameState,
  a: ServerAction & { kind: 'throw-rock' },
): Result<GameState, ValidationError> {
  const u = findUnit(state, a.unitId);
  if (!u) return err('unit-not-found', `unit ${a.unitId} not alive`);
  if (u.player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (u.type !== 'catapult') return err('unit-cannot-act', 'only a catapult can throw a rock');
  if (u.done) return err('unit-cannot-act', 'unit already finished');
  if (u.movesLeft < 1 + turnCost(u, a.row, a.col)) return err('no-moves-left', 'throwing a rock costs a move (+1 to turn round)');
  const dist = Math.abs(a.row - u.row) + Math.abs(a.col - u.col);
  if (dist < CATAPULT_MIN_RANGE || dist > catapultMaxRangeFor(isOnTower(state, u.row, u.col))) {
    return err('illegal-attack', 'rock target out of range');
  }
  if (!rockTargetAllowed(state, a.row, a.col)) return err('not-empty-cell', 'cannot drop a rock there');

  const next = cloneState(state);
  const nextU = own(next, next.units.find((x) => x.id === u.id)!);
  const actErr = activateUnit(next, nextU);
  if (actErr) return { ok: false, error: actErr };

  const hadRock = next.terrain.some((t) => t.row === a.row && t.col === a.col && t.type === 'rock');
  next.terrain = hadRock
    ? next.terrain.filter((t) => !(t.row === a.row && t.col === a.col && t.type === 'rock'))
    : [...next.terrain, { row: a.row, col: a.col, type: 'rock' }];
  spendMageMove(nextU, a.row, a.col); // 1 move, +1 and a turn when aimed behind
  if (nextU.movesLeft <= 0) nextU.done = true;
  return ok(next, [{ kind: hadRock ? 'rock-shattered' : 'rock-thrown', data: { unitId: u.id, row: a.row, col: a.col } }]);
}

function pickLoot(rng: Rng): LootEntry {
  const items: LootEntry[] = [...RUINS_LOOT_TABLE];
  const weights = items.map((i) => i.weight);
  return weightedChoiceWith(rng, items, weights);
}
