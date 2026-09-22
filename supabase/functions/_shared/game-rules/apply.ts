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
  ARTIFACTS,
  DEFAULT_CASTLE_P1_COL,
  DEFAULT_CASTLE_P2_COL,
  ROWS,
  RUINS_LOOT_TABLE,
  SPELLS,
  UNIT_TYPES,
  WEAPONS,
} from './constants.ts';
import { type Rng, weightedChoiceWith } from './rng.ts';
import { CATAPULT_MIN_RANGE, archerRadiusFor, catapultMaxRangeFor } from './moves.ts';
import {
  type GameState,
  MAX_ACTIVATIONS_PER_TURN,
  RULES_VERSION,
  emptyInventoryFor,
} from './state.ts';
import type { SerializedUnit, SerializedWeaponEquip } from './save.ts';
import type {
  ArtifactName,
  AttackMode,
  DroppedItem,
  GameMode,
  GearSlot,
  HiddenPickup,
  LootEntry,
  Player,
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
    }
  | { kind: 'end-turn' }
  | { kind: 'resign'; player: Player }
  | { kind: 'spell'; player: Player; index: number; unitId?: number }
  | { kind: 'craft'; unitId: number; index: number }
  | { kind: 'craft-armor'; unitId: number; index: number }
  | { kind: 'draw-artifact'; unitId: number }
  | { kind: 'equip-weapon'; unitId: number }
  | { kind: 'search-ruins'; unitId: number }
  | { kind: 'castle-heal'; unitId: number };

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
  | 'spell-unaffordable'
  | 'spell-needs-tower'
  | 'spell-no-caster'
  | 'spell-no-effect'
  | 'craft-unaffordable'
  | 'no-pending-weapon'
  | 'cannot-equip'
  | 'weapon-pending'
  | 'activation-limit'
  | 'unit-not-on-ruins'
  | 'unit-not-in-castle'
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
    | 'spell-cast'
    | 'artifact-drawn'
    | 'weapon-crafted'
    | 'weapon-equipped'
    | 'ruins-searched'
    /** A unit stepped onto a buried artifact. */
    | 'artifact-found'
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
}

/** True if (row,col) falls inside a (non-zero-size) ruins rectangle. */
function inRuinsArea(area: RuinsArea | undefined, row: number, col: number): boolean {
  if (!area || area.width <= 0 || area.height <= 0) return false;
  return row >= area.top && row < area.top + area.height && col >= area.left && col < area.left + area.width;
}

export function createInitialState(opts: CreateInitialStateOpts): GameState {
  const inv: Record<Player, Record<ArtifactName, number>> = {
    1: emptyInventoryFor(ARTIFACTS),
    2: emptyInventoryFor(ARTIFACTS),
  };
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
    inventory: inv,
    pendingWeaponEquip: null,
    droppedItems: [],
    hiddenPickups: opts.hiddenPickups ? opts.hiddenPickups.map((p) => ({ ...p })) : [],
    units: opts.units ? opts.units.map(cloneUnit) : [],
    nextUnitId: (opts.units ?? []).reduce((m, u) => Math.max(m, u.id), 0) + 1,
    rngSeed: opts.seed,
    rngCursor: 0,
    rulesVersion: RULES_VERSION,
  };
}

function cloneUnit(u: SerializedUnit): SerializedUnit {
  return {
    ...u,
    weapon: u.weapon ? { ...u.weapon } : null,
    armorGear: u.armorGear ? { ...u.armorGear } : null,
  };
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    towers: state.towers.map((t) => ({ ...t })),
    ruins: { ...state.ruins },
    ruins2: state.ruins2 ? { ...state.ruins2 } : undefined,
    terrain: state.terrain.map((t) => ({ ...t })),
    shieldTurns: { ...state.shieldTurns },
    damageBuff: { ...state.damageBuff },
    inventory: {
      1: { ...state.inventory[1] },
      2: { ...state.inventory[2] },
    },
    pendingWeaponEquip: state.pendingWeaponEquip ? { ...state.pendingWeaponEquip } : null,
    droppedItems: (state.droppedItems ?? []).map((d) => ({ ...d })),
    hiddenPickups: (state.hiddenPickups ?? []).map((p) => ({ ...p })),
    units: state.units.map(cloneUnit),
  };
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
function canEquipGear(spec: GearSpec, unit: SerializedUnit, player: Player): boolean {
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

/** Build a dropped-item record for a piece of gear at a board cell. allowedTypes
 * etc. are recovered from the static catalogue so pickup honours the same
 * restrictions as crafting. */
function gearToDrop(
  slot: GearSlot,
  gear: { name: string; icon: string; amount: number },
  row: number,
  col: number,
): DroppedItem {
  const catalogue = slot === 'armor' ? ARMORS : WEAPONS;
  const def = catalogue.find((w) => w.name === gear.name);
  return {
    row,
    col,
    slot,
    name: gear.name,
    amount: gear.amount,
    icon: gear.icon,
    allowedTypes: def?.allowedTypes ? [...def.allowedTypes] : null,
    forbidTypes: def?.forbidTypes ? [...def.forbidTypes] : null,
    archerOnly: def?.archerOnly ?? false,
  };
}

function findUnit(state: GameState, id: number): SerializedUnit | null {
  return state.units.find((u) => u.id === id && u.hp > 0) ?? null;
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
      return ok(endTurn(state), [{ kind: 'turn-ended', data: { player: state.currentPlayer } }]);
    case 'resign':
      return applyResign(state, action.player);
    case 'spell':
      return applySpell(state, action.player, action.index, action.unitId);
    case 'craft':
      return applyCraft(state, action.unitId, action.index);
    case 'craft-armor':
      return applyCraftArmor(state, action.unitId, action.index);
    case 'draw-artifact':
      return applyDrawArtifact(state, action.unitId, rng);
    case 'equip-weapon':
      return applyEquipWeapon(state, action.unitId);
    case 'search-ruins':
      return applySearchRuins(state, action.unitId, rng);
    case 'castle-heal':
      return applyCastleHeal(state, action.unitId);
    default:
      return err('unknown-action', 'Unrecognised action kind.');
  }
}

function applyMove(
  state: GameState,
  a: ServerAction & { kind: 'move' },
): Result<GameState, ValidationError> {
  const next = cloneState(state);
  const u = findUnit(next, a.unitId);
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
      (t) => t.row === a.row && t.col === a.col && (t.type === 'river' || t.type === 'mountain'),
    )
  ) {
    return err('illegal-move', 'blocked by terrain');
  }
  const actErr = activateUnit(next, u);
  if (actErr) return { ok: false, error: actErr };
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

/**
 * Claim the hidden pickup buried under a unit that just arrived, if any.
 * Artifacts go into the owner's inventory. Gear is equipped to the finder when
 * it can wear it; otherwise it becomes a pending equip so the player can put it
 * on a compatible ally — and if nobody can wear it, it drops on the cell as
 * ordinary loot. Removes the pickup either way: nothing respawns. Mutates `next`.
 */
function claimHiddenPickup(next: GameState, unit: SerializedUnit, events: GameEvent[]): void {
  if (!next.hiddenPickups || next.hiddenPickups.length === 0) return;
  const idx = next.hiddenPickups.findIndex((p) => p.row === unit.row && p.col === unit.col);
  if (idx < 0) return;
  const found = next.hiddenPickups[idx]!;
  next.hiddenPickups = next.hiddenPickups.filter((_, i) => i !== idx);

  if (found.kind === 'artifact') {
    const name = found.name as ArtifactName;
    if (next.inventory[unit.player][name] !== undefined) {
      next.inventory[unit.player][name] += 1;
    }
    events.push({
      kind: 'artifact-found',
      data: { unitId: unit.id, player: unit.player, name },
    });
    return;
  }

  const catalogue = found.kind === 'armor' ? ARMORS : WEAPONS;
  const gear = catalogue.find((w) => w.name === found.name);
  if (!gear) return;
  const slot: GearSlot = found.kind === 'armor' ? 'armor' : 'weapon';
  const asDropped: DroppedItem = {
    row: unit.row,
    col: unit.col,
    slot,
    name: gear.name,
    amount: gear.amount,
    icon: gear.icon,
    allowedTypes: gear.allowedTypes ? [...gear.allowedTypes] : null,
    forbidTypes: gear.forbidTypes ? [...gear.forbidTypes] : null,
    archerOnly: !!gear.archerOnly,
  };

  // The finder wears it when it can.
  if (canEquipGear(asDropped, unit, unit.player)) {
    equipGearToUnit(unit, asDropped);
    events.push({
      kind: 'weapon-equipped',
      data: { unitId: unit.id, name: gear.name, amount: gear.amount, slot, pickedUp: true },
    });
    return;
  }

  // Otherwise offer it to a compatible ally, exactly like ruins loot did.
  const hasRecipient = next.units.some(
    (o) => o.hp > 0 && o.player === unit.player && canEquipGear(asDropped, o, unit.player),
  );
  if (hasRecipient) {
    next.pendingWeaponEquip = {
      name: gear.name,
      amount: gear.amount,
      icon: gear.icon,
      slot,
      allowedTypes: gear.allowedTypes ? [...gear.allowedTypes] : null,
      forbidTypes: gear.forbidTypes ? [...gear.forbidTypes] : null,
      archerOnly: !!gear.archerOnly,
    };
    events.push({
      kind: 'weapon-found',
      data: { unitId: unit.id, player: unit.player, name: gear.name, slot },
    });
    return;
  }

  // Nobody in the army can wear it — leave it lying on the cell.
  next.droppedItems.push(asDropped);
}

/**
 * After a unit lands on `(unit.row, unit.col)`, auto-equip any dropped gear it
 * can use. One item per slot; an item the unit can't equip stays on the cell.
 * Deterministic — runs identically client- and server-side. Mutates `next`.
 */
function pickUpDroppedItems(next: GameState, unit: SerializedUnit, events: GameEvent[]): void {
  if (!next.droppedItems || next.droppedItems.length === 0) return;
  const remaining: DroppedItem[] = [];
  for (const item of next.droppedItems) {
    const here = item.row === unit.row && item.col === unit.col;
    if (here && canEquipGear(item, unit, unit.player)) {
      equipGearToUnit(unit, item);
      events.push({
        kind: 'weapon-equipped',
        data: { unitId: unit.id, name: item.name, amount: item.amount, slot: item.slot, pickedUp: true },
      });
    } else {
      remaining.push(item);
    }
  }
  next.droppedItems = remaining;
}

function applyAttack(
  state: GameState,
  a: ServerAction & { kind: 'attack' },
): Result<GameState, ValidationError> {
  const next = cloneState(state);
  const attacker = findUnit(next, a.unitId);
  if (!attacker) return err('unit-not-found', `attacker ${a.unitId} not alive`);
  if (attacker.player !== next.currentPlayer) return err('wrong-turn', "not this player's turn");
  if (attacker.done) return err('unit-cannot-act', 'unit already finished');
  if (attacker.movesLeft < a.cost) return err('no-moves-left', 'insufficient movesLeft');

  const target = next.units.find((u) => u.row === a.targetRow && u.col === a.targetCol && u.hp > 0);
  if (!target) return err('no-target', 'no living target at given cell');
  if (target.player === attacker.player) return err('illegal-attack', 'cannot attack own unit');

  // A ranged unit shooting from a mage tower gets ~1.5× range (high ground).
  const attackerOnTower = isOnTower(next, attacker.row, attacker.col);

  // Catapult: target must be at manhattan distance 3–6 (3–9 from a tower), cost = 1.
  if (attacker.type === 'catapult') {
    const manhattan = Math.abs(a.targetRow - attacker.row) + Math.abs(a.targetCol - attacker.col);
    if (
      manhattan < CATAPULT_MIN_RANGE ||
      manhattan > catapultMaxRangeFor(attackerOnTower) ||
      a.cost !== 1
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
      a.cost !== chebyshev
    ) {
      return err('illegal-attack', 'archer/crossbow shot out of square range');
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
          (t.type === 'river' || t.type === 'mountain'),
      )
    ) {
      return err('illegal-attack', 'landing cell blocked by terrain');
    }
    attacker.row = a.landingRow;
    attacker.col = a.landingCol;
  }

  // Damage formula — verbatim port of main.ts:1759-1786.
  let damage = attacker.damage;
  if (next.damageBuff[attacker.player] > 0) damage += 2;
  if (next.shieldTurns[target.player] > 0) damage = Math.max(0, damage - 2);
  // Archer/crossbow min-1 rule: ranged units always deal at least 1 damage.
  if (
    (attacker.type === 'archer' || attacker.type === 'crossbow') &&
    damage === 0 &&
    attacker.damage > 0
  ) {
    damage = 1;
  }
  let damageToHp = 0;
  if (damage > target.armor) {
    damageToHp = damage - target.armor;
    target.armor = 0;
  } else {
    target.armor -= damage;
  }
  target.hp -= damageToHp;

  attacker.movesLeft -= a.cost;
  if (attacker.movesLeft <= 0) attacker.done = true;

  const events: GameEvent[] = [
    {
      kind: 'unit-attacked',
      data: { attackerId: attacker.id, targetId: target.id, damage, hpLeft: target.hp },
    },
  ];
  if (target.hp <= 0) {
    // Drop the slain unit's gear onto its cell so it can be picked up later.
    if (target.weapon) next.droppedItems.push(gearToDrop('weapon', target.weapon, target.row, target.col));
    if (target.armorGear)
      next.droppedItems.push(gearToDrop('armor', target.armorGear, target.row, target.col));
    next.units = next.units.filter((u) => u.id !== target.id);
    events.push({ kind: 'unit-killed', data: { unitId: target.id } });
    maybeFinishMatch(next, events);
  }
  // A jump/l-attack lands the attacker on a new cell — let it grab gear there.
  if (a.mode === 'jump' || a.mode === 'l-attack') pickUpDroppedItems(next, attacker, events);
  return ok(next, events);
}

function inCastleZone(
  u: { row: number; col: number },
  castleRow: number,
  castleCol: number,
): boolean {
  return u.row >= castleRow && u.row < castleRow + 4 && u.col >= castleCol && u.col < castleCol + 4;
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
  next.units.forEach((u) => {
    // Activation resets for everyone; moves/done refill for the upcoming player.
    u.activated = false;
    if (u.player === upcoming && u.hp > 0) {
      u.done = false;
      const t = UNIT_TYPES[u.type as UnitTypeKey];
      u.movesLeft = t ? t.moves : u.movesLeft;
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

function applySpell(
  state: GameState,
  player: Player,
  index: number,
  casterUnitId?: number,
): Result<GameState, ValidationError> {
  const spell = SPELLS[index];
  if (!spell) return err('unknown-action', `no spell at index ${index}`);
  if (player !== state.currentPlayer) return err('wrong-turn', "not this player's turn");
  // Spells require a caster standing on a mage tower (mirrors web castSpell).
  if (casterUnitId === undefined) return err('spell-no-caster', 'spell needs a caster unit');
  const caster = state.units.find((u) => u.id === casterUnitId && u.player === player && u.hp > 0);
  if (!caster) return err('unit-not-found', `caster ${casterUnitId} not alive/owned`);
  if (caster.done) return err('unit-cannot-act', 'caster already finished');
  if (caster.movesLeft < 1) return err('no-moves-left', 'caster has no moves');
  if (!isOnTower(state, caster.row, caster.col)) {
    return err('spell-needs-tower', 'spells can only be cast from a mage tower');
  }
  const inv = state.inventory[player];
  for (const [art, n] of Object.entries(spell.recipe)) {
    if ((inv[art as ArtifactName] ?? 0) < (n ?? 0)) {
      return err('spell-unaffordable', `missing ${art}`);
    }
  }
  const next = cloneState(state);
  const nextCaster = next.units.find((u) => u.id === casterUnitId)!;
  const actErr = activateUnit(next, nextCaster);
  if (actErr) return { ok: false, error: actErr };
  for (const [art, n] of Object.entries(spell.recipe)) {
    next.inventory[player][art as ArtifactName] -= n ?? 0;
  }
  // Guard: block spells that would have no effect.
  const aliveAllies = next.units.filter((u) => u.player === player && u.hp > 0);
  if (index === 0) {
    if (aliveAllies.every((u) => u.hp >= u.maxHp)) {
      return err('spell-no-effect', 'Все отряды уже имеют максимальное здоровье.');
    }
  } else if (index === 1) {
    if (aliveAllies.every((u) => u.armor >= u.maxArmor)) {
      return err('spell-no-effect', 'Все отряды уже имеют максимальную броню.');
    }
  } else if (index === 2) {
    if (next.damageBuff[player] > 0) {
      return err('spell-no-effect', 'Бафф урона уже активен.');
    }
  }

  // Apply spell effect. Indices match SPELLS array in constants.ts:
  //   0 = "Дождь защиты"  → +2 HP to all own units (capped at maxHp)
  //   1 = "Сталь свободы"  → +2 armor restoration (capped at maxArmor)
  //   2 = "Небо огня"      → +2 damage buff for 2 turns
  if (index === 0) {
    next.units.forEach((u) => {
      if (u.player === player && u.hp > 0) u.hp = Math.min(u.maxHp, u.hp + 2);
    });
  } else if (index === 1) {
    next.units.forEach((u) => {
      if (u.player === player && u.hp > 0) u.armor = Math.min(u.maxArmor, u.armor + 2);
    });
  } else if (index === 2) {
    next.damageBuff[player] = 2;
  }
  // Casting a spell costs the caster one move (energy).
  nextCaster.movesLeft = Math.max(0, nextCaster.movesLeft - 1);
  if (nextCaster.movesLeft <= 0) nextCaster.done = true;
  return ok(next, [{ kind: 'spell-cast', data: { player, index } }]);
}

/**
 * Craft a weapon (Солнечный меч / Синий лук) from accumulated artifacts. Mirrors
 * the web client's craftWeapon(): requires a unit with a move to spend, deducts
 * the recipe, and — if an eligible ally exists — sets `pendingWeaponEquip` so the
 * next action must equip it. If no eligible recipient exists the weapon is
 * dropped (the move is still spent), exactly as in the offline game.
 */
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
  const inv = state.inventory[u.player];
  for (const [art, n] of Object.entries(weapon.recipe)) {
    if ((inv[art as ArtifactName] ?? 0) < (n ?? 0)) {
      return err('craft-unaffordable', `missing ${art}`);
    }
  }
  const next = cloneState(state);
  const nextU = next.units.find((x) => x.id === unitId)!;
  const actErr = activateUnit(next, nextU);
  if (actErr) return { ok: false, error: actErr };
  for (const [art, n] of Object.entries(weapon.recipe)) {
    next.inventory[u.player][art as ArtifactName] -= n ?? 0;
  }
  nextU.movesLeft = Math.max(0, nextU.movesLeft - 1);
  if (nextU.movesLeft <= 0) nextU.done = true;

  const pending = weaponToPending(weapon);
  const hasRecipient = next.units.some((t) => canEquipGear(pending, t, next.currentPlayer));
  if (hasRecipient) next.pendingWeaponEquip = pending;
  return ok(next, [
    {
      kind: 'weapon-crafted',
      data: { unitId, index, name: weapon.name, dropped: !hasRecipient },
    },
  ]);
}

/**
 * Craft a piece of armour from accumulated artifacts. Mirrors applyCraft but
 * indexes the ARMORS catalogue and produces a pending equip in the armour slot.
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
  const inv = state.inventory[u.player];
  for (const [art, n] of Object.entries(armor.recipe)) {
    if ((inv[art as ArtifactName] ?? 0) < (n ?? 0)) {
      return err('craft-unaffordable', `missing ${art}`);
    }
  }
  const next = cloneState(state);
  const nextU = next.units.find((x) => x.id === unitId)!;
  const actErr = activateUnit(next, nextU);
  if (actErr) return { ok: false, error: actErr };
  for (const [art, n] of Object.entries(armor.recipe)) {
    next.inventory[u.player][art as ArtifactName] -= n ?? 0;
  }
  nextU.movesLeft = Math.max(0, nextU.movesLeft - 1);
  if (nextU.movesLeft <= 0) nextU.done = true;

  const pending = weaponToPending(armor);
  const hasRecipient = next.units.some((t) => canEquipGear(pending, t, next.currentPlayer));
  if (hasRecipient) next.pendingWeaponEquip = pending;
  return ok(next, [
    {
      kind: 'weapon-crafted',
      data: { unitId, index, name: armor.name, slot: 'armor', dropped: !hasRecipient },
    },
  ]);
}

function applyDrawArtifact(
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
  const target = next.units.find((x) => x.id === unitId)!;
  equipGearToUnit(target, pending);
  next.pendingWeaponEquip = null;
  return ok(next, [
    {
      kind: 'weapon-equipped',
      data: { unitId, name: pending.name, amount: pending.amount, slot: pending.slot ?? 'weapon' },
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
  const acted = next.units.find((x) => x.id === unitId)!;
  const actErr = activateUnit(next, acted);
  if (actErr) return { ok: false, error: actErr };
  const loot = pickLoot(rng);
  if (loot.type === 'artifact') {
    next.inventory[u.player][loot.name] += 1;
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
  const acted = next.units.find((x) => x.id === unitId)!;
  const actErr = activateUnit(next, acted);
  if (actErr) return { ok: false, error: actErr };
  acted.hp = acted.maxHp;
  acted.armor = acted.maxArmor;
  acted.movesLeft = 0;
  acted.done = true;
  return ok(next, [{ kind: 'spell-cast', data: { player: acted.player, heal: true, unitId } }]);
}

function pickLoot(rng: Rng): LootEntry {
  const items: LootEntry[] = [...RUINS_LOOT_TABLE];
  const weights = items.map((i) => i.weight);
  return weightedChoiceWith(rng, items, weights);
}
