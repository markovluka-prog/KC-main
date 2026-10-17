import {
  ARMORS,
  BUILD_WORK_TOTAL,
  BRIDGE_MAX_DURABILITY,
  COLS,
  DEFAULT_RUINS,
  DEFAULT_TOWERS,
  MAGE_MAX_ENERGY,
  PARTS,
  SAVE_VERSION,
  UNIT_TYPES,
  emptyBackpack,
} from './constants.js';
import { insideBoard } from './board.js';
import type {
  Backpack,
  BridgeDurability,
  Construction,
  DroppedBackpack,
  HiddenPickup,
  EquippedGear,
  GameMode,
  GearItem,
  GearSlot,
  PartName,
  Player,
  RuinsArea,
  TowerPosition,
  UnitTypeKey,
} from './types.js';

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
  terrain: { row: number; col: number; type: string }[];
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

  // FUNC-001 fix — AI / story restoration fields.
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
export const DESERIALIZED_DAMAGE_BUFF_CAP = 10;

/** Largest armour bonus any single armour piece can give. */
const MAX_ARMOR_GEAR_AMOUNT = Math.max(0, ...ARMORS.map((a) => a.amount));

function toPlayer(value: unknown): Player {
  return value === 2 ? 2 : 1;
}

function toFiniteInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function toBool(value: unknown): boolean {
  return !!value;
}

function toString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

const UNIT_TYPE_KEYS = new Set<UnitTypeKey>([
  'knight',
  'cavalry',
  'archer',
  'catapult',
  'crossbow',
  'samurai',
  'mage',
]);

function toBackpack(raw: unknown): Backpack {
  const b = emptyBackpack();
  if (!raw || typeof raw !== 'object') return b;
  const r = raw as Record<string, unknown>;
  for (const p of PARTS) {
    const n = Number(r[p]);
    if (Number.isFinite(n) && n >= 0) b[p] = Math.floor(n);
  }
  return b;
}

function isUnitType(value: unknown): value is UnitTypeKey {
  return typeof value === 'string' && UNIT_TYPE_KEYS.has(value as UnitTypeKey);
}

function isGameMode(value: unknown): value is GameMode {
  return value === 'pvp' || value === 'ai' || value === 'story';
}

function normaliseUnitTypes(value: unknown): UnitTypeKey[] | null {
  if (!Array.isArray(value)) return null;
  const out: UnitTypeKey[] = [];
  for (const v of value) {
    if (isUnitType(v)) out.push(v);
  }
  return out;
}

export function validateSerializedUnit(raw: unknown): SerializedUnit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isUnitType(r.type)) return null;

  const id = toFiniteInt(r.id, -1);
  if (id <= 0) return null;
  const row = toFiniteInt(r.row, -1);
  const col = toFiniteInt(r.col, -1);
  if (!insideBoard(row, col)) return null;

  const player = toPlayer(r.player);
  const baseDamage = UNIT_TYPES[r.type].damage;
  const damageCeiling = baseDamage + DESERIALIZED_DAMAGE_BUFF_CAP;

  // Nothing in the game raises max HP or base armour, so both are capped at
  // the unit type's own stats (tamper guard, same spirit as the damage cap).
  const baseHp = UNIT_TYPES[r.type].hp;
  const maxHp = Math.max(1, Math.min(baseHp, toFiniteInt(r.maxHp, baseHp)));
  const hp = Math.max(0, Math.min(maxHp, toFiniteInt(r.hp, maxHp)));
  const baseArmor = UNIT_TYPES[r.type].armor;
  const startArmor = Math.max(0, Math.min(baseArmor, toFiniteInt(r.startArmor, baseArmor)));
  // T25 P1: cap damage to prevent localStorage tampering.
  const damage = Math.max(0, Math.min(damageCeiling, toFiniteInt(r.damage, baseDamage)));
  const maxMoves = Math.max(1, toFiniteInt(r.maxMoves, UNIT_TYPES[r.type].moves));
  const movesLeft = Math.max(0, Math.min(maxMoves, toFiniteInt(r.movesLeft, maxMoves)));

  let weapon: SerializedUnit['weapon'] = null;
  if (r.weapon && typeof r.weapon === 'object') {
    const w = r.weapon as Record<string, unknown>;
    weapon = {
      name: toString(w.name),
      icon: toString(w.icon),
      amount: Math.max(0, toFiniteInt(w.amount, 0)),
    };
  }

  let armorGear: SerializedUnit['armorGear'] = null;
  if (r.armorGear && typeof r.armorGear === 'object') {
    const a = r.armorGear as Record<string, unknown>;
    armorGear = {
      name: toString(a.name),
      icon: toString(a.icon),
      amount: Math.max(0, Math.min(MAX_ARMOR_GEAR_AMOUNT, toFiniteInt(a.amount, 0))),
    };
  }
  // Worn armour raises maxArmor above startArmor (see equipGearToUnit) — the
  // cap used to be startArmor alone, so every reload stripped the bonus off.
  const armorCeiling = startArmor + (armorGear ? armorGear.amount : 0);
  const maxArmor = Math.max(0, Math.min(armorCeiling, toFiniteInt(r.maxArmor, armorCeiling)));
  const armor = Math.max(0, Math.min(maxArmor, toFiniteInt(r.armor, maxArmor)));

  const unit: SerializedUnit = {
    id,
    player,
    type: r.type,
    row,
    col,
    maxHp,
    hp,
    startArmor,
    armor,
    maxArmor,
    damage,
    maxMoves,
    movesLeft,
    done: toBool(r.done),
    activated: toBool(r.activated),
    // null/undefined must stay null — Number(null) === 0 is finite, which would
    // otherwise pin a unit's visual position to cell (0,0). The server sends
    // visualRow/Col: null (visual position is a client-only render concern), so
    // a naive Number() check made every online unit render stacked at top-left.
    visualRow:
      r.visualRow == null || !Number.isFinite(Number(r.visualRow)) ? null : Number(r.visualRow),
    visualCol:
      r.visualCol == null || !Number.isFinite(Number(r.visualCol)) ? null : Number(r.visualCol),
    dying: toBool(r.dying),
    deathProgress: Math.max(0, toFiniteInt(r.deathProgress, 0)),
    weapon,
    armorGear,
    backpack: toBackpack(r.backpack),
  };

  if (r.type === 'mage') {
    const maxEnergy = Math.max(1, toFiniteInt(r.maxEnergy, MAGE_MAX_ENERGY));
    unit.maxEnergy = maxEnergy;
    unit.energy = Math.max(0, Math.min(maxEnergy, toFiniteInt(r.energy, maxEnergy)));
    unit.warding = Array.isArray(r.warding)
      ? r.warding.filter((x): x is number => Number.isFinite(Number(x))).map(Number)
      : [];
  }
  // wardedBy: any unit type can be on the receiving end of a mage's shield.
  const wardedByRaw = toFiniteInt(r.wardedBy, 0);
  unit.wardedBy = wardedByRaw > 0 ? wardedByRaw : null;

  return unit;
}

function validatePendingWeaponEquip(raw: unknown): SerializedWeaponEquip | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;
  const amount = Number(r.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    name: r.name,
    amount: Math.max(0, amount),
    icon: toString(r.icon),
    allowedTypes: normaliseUnitTypes(r.allowedTypes),
    forbidTypes: normaliseUnitTypes(r.forbidTypes),
    archerOnly: toBool(r.archerOnly),
    slot: r.slot === 'armor' ? 'armor' : 'weapon',
  };
}

function validateGearItem(raw: unknown): GearItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;
  return {
    name: r.name,
    amount: Math.max(0, toFiniteInt(r.amount, 0)),
    icon: toString(r.icon),
    allowedTypes: normaliseUnitTypes(r.allowedTypes),
    forbidTypes: normaliseUnitTypes(r.forbidTypes),
    archerOnly: toBool(r.archerOnly),
  };
}

function validateDroppedBackpacks(raw: unknown): DroppedBackpack[] {
  if (!Array.isArray(raw)) return [];
  const out: DroppedBackpack[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const row = toFiniteInt(r.row, -1);
    const col = toFiniteInt(r.col, -1);
    if (!insideBoard(row, col)) continue;
    out.push({
      row,
      col,
      parts: toBackpack(r.parts),
      weapon: validateGearItem(r.weapon),
      armorGear: validateGearItem(r.armorGear),
    });
  }
  return out;
}

function validateConstructions(raw: unknown): Construction[] {
  if (!Array.isArray(raw)) return [];
  const out: Construction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const row = toFiniteInt(r.row, -1);
    const col = toFiniteInt(r.col, -1);
    if (!insideBoard(row, col)) continue;
    if (r.kind !== 'tower' && r.kind !== 'bridge') continue;
    // Older web saves stored progress as `hp`.
    const progress = toFiniteInt(r.progress ?? r.hp, 0);
    if (progress <= 0 || progress >= BUILD_WORK_TOTAL) continue;
    out.push({ row, col, kind: r.kind, progress });
  }
  return out;
}

function validateBridgeDurability(raw: unknown): BridgeDurability {
  const out: BridgeDurability = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const m = /^(\d+),(\d+)$/.exec(key);
    if (!m || !insideBoard(Number(m[1]), Number(m[2]))) continue;
    const hp = toFiniteInt(value, 0);
    if (hp > 0) out[key] = Math.min(BRIDGE_MAX_DURABILITY, hp);
  }
  return out;
}

function validateHiddenPickups(raw: unknown): HiddenPickup[] | undefined {
  // Absent ⇒ undefined (an old save), so the client knows to scatter fresh
  // loot; an empty array means "everything was already claimed".
  if (!Array.isArray(raw)) return undefined;
  const out: HiddenPickup[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const row = toFiniteInt(r.row, -1);
    const col = toFiniteInt(r.col, -1);
    if (!insideBoard(row, col)) continue;
    if (r.kind !== 'part' && r.kind !== 'weapon' && r.kind !== 'armor') continue;
    if (typeof r.name !== 'string') continue;
    if (r.kind === 'part' && !PARTS.includes(r.name as PartName)) continue;
    out.push({ row, col, kind: r.kind, name: r.name });
  }
  return out;
}

function validateStoryTask(raw: unknown): SerializedStoryTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ci = toFiniteInt(r.ci, -1);
  const gi = toFiniteInt(r.gi, -1);
  const ti = toFiniteInt(r.ti, -1);
  if (ci < 0 || gi < 0 || ti < 0) return null;
  return { ci, gi, ti };
}

function validateTowers(raw: unknown): TowerPosition[] {
  if (!Array.isArray(raw)) return DEFAULT_TOWERS.map((t) => ({ ...t }));
  const out: TowerPosition[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const row = toFiniteInt(r.row, -1);
    const col = toFiniteInt(r.col, -1);
    if (row >= 0 && col >= 0) out.push({ row, col });
  }
  return out.length > 0 ? out : DEFAULT_TOWERS.map((t) => ({ ...t }));
}

function validateRuins(raw: unknown): RuinsArea {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RUINS };
  const r = raw as Record<string, unknown>;
  const top = toFiniteInt(r.top, DEFAULT_RUINS.top);
  const left = toFiniteInt(r.left, DEFAULT_RUINS.left);
  const width = Math.max(0, toFiniteInt(r.width, DEFAULT_RUINS.width));
  const height = Math.max(0, toFiniteInt(r.height, DEFAULT_RUINS.height));
  if (width === 0 || height === 0) return { ...DEFAULT_RUINS };
  return { top, left, width, height };
}

/** Second ruins area — may legitimately be absent (zero-size). */
function validateRuins2(raw: unknown): RuinsArea {
  const empty: RuinsArea = { top: 0, left: 0, width: 0, height: 0 };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const width = Math.max(0, toFiniteInt(r.width, 0));
  const height = Math.max(0, toFiniteInt(r.height, 0));
  if (width === 0 || height === 0) return empty;
  return { top: toFiniteInt(r.top, 0), left: toFiniteInt(r.left, 0), width, height };
}

function validateTerrain(raw: unknown): { row: number; col: number; type: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t) =>
        t &&
        typeof t === 'object' &&
        typeof t.row === 'number' &&
        typeof t.col === 'number' &&
        typeof t.type === 'string',
    )
    .map((t) => ({ row: t.row as number, col: t.col as number, type: t.type as string }));
}

/**
 * Type-guard / sanitiser for a snapshot pulled from localStorage. Returns
 * `null` if the structure or version cannot be trusted.
 *
 * Only the current `SAVE_VERSION` is accepted — v4's per-unit backpacks and
 * removal of the shared artifact inventory are structurally incompatible
 * with v3, so an old in-progress save is simply dropped rather than
 * partially migrated (screen falls back to the menu; nothing crashes).
 */
const SUPPORTED_VERSIONS = new Set([SAVE_VERSION]);

export function validateSnapshot(raw: unknown): GameSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'number' || !SUPPORTED_VERSIONS.has(r.version)) return null;

  const screen: 'menu' | 'game' = r.screen === 'game' ? 'game' : 'menu';
  // FUNC-001 fix — no longer restricting restore to PvP only.
  const mode: GameMode | null = isGameMode(r.mode) ? r.mode : null;
  if (screen === 'game' && !mode) return null;

  const unitsRaw = Array.isArray(r.units) ? r.units : [];
  const units: SerializedUnit[] = [];
  const occupied = new Set<string>();
  for (const u of unitsRaw) {
    const v = validateSerializedUnit(u);
    if (!v) continue;
    // Dead/dying units carry nothing a resumed game needs, and keeping one
    // could shadow a live unit standing on the same cell (first wins below).
    if (v.hp <= 0 || v.dying) continue;
    const key = v.row + ',' + v.col;
    if (occupied.has(key)) continue;
    occupied.add(key);
    units.push(v);
  }
  if (screen === 'game' && units.length === 0) return null;

  const shield = (r.shieldTurns as Record<string, unknown>) ?? {};
  const buff = (r.damageBuff as Record<string, unknown>) ?? {};
  const sessionRaw = (r.sessionWins as Record<string, unknown>) ?? {};

  return {
    version: SAVE_VERSION,
    screen,
    mode: mode ?? 'pvp',
    currentPlayer: toPlayer(r.currentPlayer),
    activatedCount: Math.max(0, toFiniteInt(r.activatedCount, 0)),
    turnNumber: Math.max(1, toFiniteInt(r.turnNumber, 1)),
    winner: r.winner === 1 || r.winner === 2 ? (r.winner as Player) : null,
    message: toString(r.message),
    lastEvent: toString(r.lastEvent),
    player1Bottom: r.player1Bottom === true,
    castleP1Col: Math.max(0, Math.min(COLS - 4, toFiniteInt(r.castleP1Col, 0))),
    castleP2Col: Math.max(0, Math.min(COLS - 4, toFiniteInt(r.castleP2Col, 0))),
    towers: validateTowers(r.towers),
    ruins: validateRuins(r.ruins),
    ruins2: validateRuins2(r.ruins2),
    terrain: validateTerrain(r.terrain),
    shieldTurns: {
      1: Math.max(0, toFiniteInt(shield[1], 0)),
      2: Math.max(0, toFiniteInt(shield[2], 0)),
    },
    damageBuff: {
      1: Math.max(0, toFiniteInt(buff[1], 0)),
      2: Math.max(0, toFiniteInt(buff[2], 0)),
    },
    pendingWeaponEquip: validatePendingWeaponEquip(r.pendingWeaponEquip),
    droppedBackpacks: validateDroppedBackpacks(r.droppedBackpacks),
    constructions: validateConstructions(r.constructions),
    bridgeDurability: validateBridgeDurability(r.bridgeDurability),
    hiddenPickups: validateHiddenPickups(r.hiddenPickups),
    previewUnitId: Number.isFinite(Number(r.previewUnitId)) ? Number(r.previewUnitId) : null,
    selectedUnitId: Number.isFinite(Number(r.selectedUnitId)) ? Number(r.selectedUnitId) : null,
    units,

    // FUNC-001 fix: AI/story state.
    aiDifficulty: typeof r.aiDifficulty === 'string' ? r.aiDifficulty : null,
    currentStoryTask: validateStoryTask(r.currentStoryTask),
    mapTheme: r.mapTheme === 'sea' ? 'sea' : 'land',
    p1Faction: typeof r.p1Faction === 'string' ? r.p1Faction : 'blue',
    p2Faction: typeof r.p2Faction === 'string' ? r.p2Faction : 'red',
    sessionWins: {
      1: Math.max(0, toFiniteInt(sessionRaw[1], 0)),
      2: Math.max(0, toFiniteInt(sessionRaw[2], 0)),
    },
  };
}

/**
 * Phase 1.5 S6 adapter: lifts a fully-validated GameSnapshot into the
 * server-side GameState shape. Save metadata (story task, factions, UI
 * selection) is NOT carried over — the server doesn't need it.
 */
export function snapshotToState(snapshot: GameSnapshot): {
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
} {
  return {
    castleP1Col: snapshot.castleP1Col,
    castleP2Col: snapshot.castleP2Col,
    towers: snapshot.towers.map((t) => ({ ...t })),
    ruins: { ...snapshot.ruins },
    ruins2: { ...snapshot.ruins2 },
    currentPlayer: snapshot.currentPlayer,
    turnNumber: snapshot.turnNumber,
    activatedCount: snapshot.activatedCount,
    winner: snapshot.winner,
    mode: snapshot.mode,
    shieldTurns: { ...snapshot.shieldTurns },
    damageBuff: { ...snapshot.damageBuff },
    units: snapshot.units.map((u) => ({
      ...u,
      weapon: u.weapon ? { ...u.weapon } : null,
      armorGear: u.armorGear ? { ...u.armorGear } : null,
      backpack: { ...u.backpack },
      warding: u.warding ? [...u.warding] : undefined,
    })),
    droppedBackpacks: snapshot.droppedBackpacks.map((d) => ({
      ...d,
      parts: { ...d.parts },
      weapon: d.weapon ? { ...d.weapon } : null,
      armorGear: d.armorGear ? { ...d.armorGear } : null,
    })),
  };
}

/**
 * Returns true if the given snapshot is a partial match we can resume in
 * the menu. FUNC-001 fix: previously this was restricted to `mode === 'pvp'`
 * which orphaned every AI/story save.
 */
export function isContinuableSnapshot(snapshot: GameSnapshot | null): boolean {
  return !!(
    snapshot &&
    snapshot.screen === 'game' &&
    snapshot.winner === null &&
    snapshot.units.length > 0
  );
}
