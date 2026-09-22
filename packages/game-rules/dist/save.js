import { COLS, DEFAULT_RUINS, DEFAULT_TOWERS, MAGE_MAX_ENERGY, PARTS, SAVE_VERSION, UNIT_TYPES, emptyBackpack, } from './constants.js';
import { insideBoard } from './board.js';
/**
 * Tampering ceiling for a unit's damage when restoring from localStorage.
 * Maximum allowed = base damage for the unit type + this cap.
 *
 * T25 (P1) — defends against a player editing localStorage to inflate damage,
 * which is otherwise possible because the save is fully client-controlled.
 * Real anti-cheat lands in Phase 4 (server-authoritative state).
 */
export const DESERIALIZED_DAMAGE_BUFF_CAP = 10;
function toPlayer(value) {
    return value === 2 ? 2 : 1;
}
function toFiniteInt(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.floor(n);
}
function toBool(value) {
    return !!value;
}
function toString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
const UNIT_TYPE_KEYS = new Set([
    'knight',
    'cavalry',
    'archer',
    'catapult',
    'crossbow',
    'samurai',
    'mage',
]);
function toBackpack(raw) {
    const b = emptyBackpack();
    if (!raw || typeof raw !== 'object')
        return b;
    const r = raw;
    for (const p of PARTS) {
        const n = Number(r[p]);
        if (Number.isFinite(n) && n >= 0)
            b[p] = Math.floor(n);
    }
    return b;
}
function isUnitType(value) {
    return typeof value === 'string' && UNIT_TYPE_KEYS.has(value);
}
function isGameMode(value) {
    return value === 'pvp' || value === 'ai' || value === 'story';
}
function normaliseUnitTypes(value) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const v of value) {
        if (isUnitType(v))
            out.push(v);
    }
    return out;
}
export function validateSerializedUnit(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (!isUnitType(r.type))
        return null;
    const id = toFiniteInt(r.id, -1);
    if (id <= 0)
        return null;
    const row = toFiniteInt(r.row, -1);
    const col = toFiniteInt(r.col, -1);
    if (!insideBoard(row, col))
        return null;
    const player = toPlayer(r.player);
    const baseDamage = UNIT_TYPES[r.type].damage;
    const damageCeiling = baseDamage + DESERIALIZED_DAMAGE_BUFF_CAP;
    const maxHp = Math.max(1, toFiniteInt(r.maxHp, UNIT_TYPES[r.type].hp));
    const hp = Math.max(0, Math.min(maxHp, toFiniteInt(r.hp, maxHp)));
    const startArmor = Math.max(0, toFiniteInt(r.startArmor, UNIT_TYPES[r.type].armor));
    const maxArmor = Math.max(0, Math.min(startArmor, toFiniteInt(r.maxArmor, startArmor)));
    const armor = Math.max(0, Math.min(maxArmor, toFiniteInt(r.armor, maxArmor)));
    // T25 P1: cap damage to prevent localStorage tampering.
    const damage = Math.max(0, Math.min(damageCeiling, toFiniteInt(r.damage, baseDamage)));
    const maxMoves = Math.max(1, toFiniteInt(r.maxMoves, UNIT_TYPES[r.type].moves));
    const movesLeft = Math.max(0, Math.min(maxMoves, toFiniteInt(r.movesLeft, maxMoves)));
    let weapon = null;
    if (r.weapon && typeof r.weapon === 'object') {
        const w = r.weapon;
        weapon = {
            name: toString(w.name),
            icon: toString(w.icon),
            amount: Math.max(0, toFiniteInt(w.amount, 0)),
        };
    }
    let armorGear = null;
    if (r.armorGear && typeof r.armorGear === 'object') {
        const a = r.armorGear;
        armorGear = {
            name: toString(a.name),
            icon: toString(a.icon),
            amount: Math.max(0, toFiniteInt(a.amount, 0)),
        };
    }
    const unit = {
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
        visualRow: r.visualRow == null || !Number.isFinite(Number(r.visualRow)) ? null : Number(r.visualRow),
        visualCol: r.visualCol == null || !Number.isFinite(Number(r.visualCol)) ? null : Number(r.visualCol),
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
            ? r.warding.filter((x) => Number.isFinite(Number(x))).map(Number)
            : [];
    }
    // wardedBy: any unit type can be on the receiving end of a mage's shield.
    const wardedByRaw = toFiniteInt(r.wardedBy, 0);
    unit.wardedBy = wardedByRaw > 0 ? wardedByRaw : null;
    return unit;
}
function validatePendingWeaponEquip(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.name !== 'string')
        return null;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount))
        return null;
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
function validateGearItem(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.name !== 'string')
        return null;
    return {
        name: r.name,
        amount: Math.max(0, toFiniteInt(r.amount, 0)),
        icon: toString(r.icon),
        allowedTypes: normaliseUnitTypes(r.allowedTypes),
        forbidTypes: normaliseUnitTypes(r.forbidTypes),
        archerOnly: toBool(r.archerOnly),
    };
}
function validateDroppedBackpacks(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object')
            continue;
        const r = item;
        const row = toFiniteInt(r.row, -1);
        const col = toFiniteInt(r.col, -1);
        if (!insideBoard(row, col))
            continue;
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
function validateStoryTask(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const ci = toFiniteInt(r.ci, -1);
    const gi = toFiniteInt(r.gi, -1);
    const ti = toFiniteInt(r.ti, -1);
    if (ci < 0 || gi < 0 || ti < 0)
        return null;
    return { ci, gi, ti };
}
function validateTowers(raw) {
    if (!Array.isArray(raw))
        return DEFAULT_TOWERS.map((t) => ({ ...t }));
    const out = [];
    for (const t of raw) {
        if (!t || typeof t !== 'object')
            continue;
        const r = t;
        const row = toFiniteInt(r.row, -1);
        const col = toFiniteInt(r.col, -1);
        if (row >= 0 && col >= 0)
            out.push({ row, col });
    }
    return out.length > 0 ? out : DEFAULT_TOWERS.map((t) => ({ ...t }));
}
function validateRuins(raw) {
    if (!raw || typeof raw !== 'object')
        return { ...DEFAULT_RUINS };
    const r = raw;
    const top = toFiniteInt(r.top, DEFAULT_RUINS.top);
    const left = toFiniteInt(r.left, DEFAULT_RUINS.left);
    const width = Math.max(0, toFiniteInt(r.width, DEFAULT_RUINS.width));
    const height = Math.max(0, toFiniteInt(r.height, DEFAULT_RUINS.height));
    if (width === 0 || height === 0)
        return { ...DEFAULT_RUINS };
    return { top, left, width, height };
}
/** Second ruins area — may legitimately be absent (zero-size). */
function validateRuins2(raw) {
    const empty = { top: 0, left: 0, width: 0, height: 0 };
    if (!raw || typeof raw !== 'object')
        return empty;
    const r = raw;
    const width = Math.max(0, toFiniteInt(r.width, 0));
    const height = Math.max(0, toFiniteInt(r.height, 0));
    if (width === 0 || height === 0)
        return empty;
    return { top: toFiniteInt(r.top, 0), left: toFiniteInt(r.left, 0), width, height };
}
function validateTerrain(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((t) => t &&
        typeof t === 'object' &&
        typeof t.row === 'number' &&
        typeof t.col === 'number' &&
        typeof t.type === 'string')
        .map((t) => ({ row: t.row, col: t.col, type: t.type }));
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
export function validateSnapshot(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.version !== 'number' || !SUPPORTED_VERSIONS.has(r.version))
        return null;
    const screen = r.screen === 'game' ? 'game' : 'menu';
    // FUNC-001 fix — no longer restricting restore to PvP only.
    const mode = isGameMode(r.mode) ? r.mode : null;
    if (screen === 'game' && !mode)
        return null;
    const unitsRaw = Array.isArray(r.units) ? r.units : [];
    const units = [];
    const occupied = new Set();
    for (const u of unitsRaw) {
        const v = validateSerializedUnit(u);
        if (!v)
            continue;
        const key = v.row + ',' + v.col;
        if (occupied.has(key))
            continue;
        occupied.add(key);
        units.push(v);
    }
    if (screen === 'game' && units.length === 0)
        return null;
    const shield = r.shieldTurns ?? {};
    const buff = r.damageBuff ?? {};
    const sessionRaw = r.sessionWins ?? {};
    return {
        version: SAVE_VERSION,
        screen,
        mode: mode ?? 'pvp',
        currentPlayer: toPlayer(r.currentPlayer),
        activatedCount: Math.max(0, toFiniteInt(r.activatedCount, 0)),
        turnNumber: Math.max(1, toFiniteInt(r.turnNumber, 1)),
        winner: r.winner === 1 || r.winner === 2 ? r.winner : null,
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
export function snapshotToState(snapshot) {
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
export function isContinuableSnapshot(snapshot) {
    return !!(snapshot &&
        snapshot.screen === 'game' &&
        snapshot.winner === null &&
        snapshot.units.length > 0);
}
//# sourceMappingURL=save.js.map