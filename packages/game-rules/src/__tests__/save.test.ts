import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESERIALIZED_DAMAGE_BUFF_CAP,
  isContinuableSnapshot,
  validateSerializedUnit,
  validateSnapshot,
} from '../save.js';
// Phase 1.5 S1: storage-touching functions live in a separate file so they
// can be excluded from server bundles. Tests still cover them from here.
import { clearSave, readSavedState, writeSnapshot } from '../save-storage.js';
import { SAVE_KEY, SAVE_VERSION, UNIT_TYPES } from '../constants.js';
import type { GameSnapshot } from '../save.js';

/** Tiny in-memory localStorage stub. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
  (globalThis as { localStorage?: Storage }).localStorage = stub;
}

function uninstallLocalStorage(): void {
  delete (globalThis as { localStorage?: Storage }).localStorage;
}

function makeSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    version: SAVE_VERSION,
    screen: 'game',
    mode: 'pvp',
    currentPlayer: 1,
    activatedCount: 0,
    turnNumber: 1,
    winner: null,
    message: '',
    lastEvent: '',
    player1Bottom: false,
    castleP1Col: 3,
    castleP2Col: 3,
    // Phase 1.5 S6: snapshot v3 carries towers/ruins inline.
    towers: [
      { row: 5, col: 3 },
      { row: 5, col: 6 },
      { row: 14, col: 3 },
      { row: 14, col: 6 },
    ],
    ruins: { top: 8, left: 3, width: 4, height: 4 },
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    pendingWeaponEquip: null,
    previewUnitId: null,
    selectedUnitId: null,
    inventory: {
      1: {
        'Трава С.': 0,
        'Посох огня': 0,
        'Волшебная палочка': 0,
        'Солнечные часы': 0,
        'Вода серебряных трав': 0,
      },
      2: {
        'Трава С.': 0,
        'Посох огня': 0,
        'Волшебная палочка': 0,
        'Солнечные часы': 0,
        'Вода серебряных трав': 0,
      },
    },
    units: [
      {
        id: 1,
        player: 1,
        type: 'knight',
        row: 5,
        col: 5,
        maxHp: 3,
        hp: 3,
        startArmor: 4,
        armor: 4,
        maxArmor: 4,
        damage: 5,
        maxMoves: 2,
        movesLeft: 2,
        done: false,
        activated: false,
        visualRow: null,
        visualCol: null,
        dying: false,
        deathProgress: 0,
        weapon: null,
      },
    ],
    aiDifficulty: null,
    currentStoryTask: null,
    mapTheme: 'land',
    p1Faction: 'blue',
    p2Faction: 'red',
    sessionWins: { 1: 0, 2: 0 },
    ...overrides,
  };
}

describe('validateSerializedUnit', () => {
  it('returns null for non-object input', () => {
    expect(validateSerializedUnit(null)).toBeNull();
    expect(validateSerializedUnit(42)).toBeNull();
    expect(validateSerializedUnit('foo')).toBeNull();
  });

  it('rejects unknown unit type', () => {
    expect(validateSerializedUnit({ id: 1, type: 'dragon', row: 0, col: 0, player: 1 })).toBeNull();
  });

  it('rejects out-of-bounds coordinates', () => {
    expect(
      validateSerializedUnit({ id: 1, type: 'knight', row: 999, col: 0, player: 1 }),
    ).toBeNull();
  });

  it('T25: caps damage at base + DESERIALIZED_DAMAGE_BUFF_CAP', () => {
    const base = UNIT_TYPES.knight.damage;
    const tampered = validateSerializedUnit({
      id: 1,
      type: 'knight',
      row: 0,
      col: 0,
      player: 1,
      damage: 999, // attacker tried to set absurd damage in localStorage
    });
    expect(tampered).not.toBeNull();
    expect(tampered?.damage).toBe(base + DESERIALIZED_DAMAGE_BUFF_CAP);
  });

  it('preserves normal damage values within range', () => {
    const result = validateSerializedUnit({
      id: 1,
      type: 'cavalry',
      row: 3,
      col: 4,
      player: 2,
      damage: UNIT_TYPES.cavalry.damage,
    });
    expect(result?.damage).toBe(UNIT_TYPES.cavalry.damage);
  });

  it('keeps null visual coords null (Number(null) === 0 must not pin units to 0,0)', () => {
    // Regression: server-spawned units serialize with visualRow/Col: null.
    // A bare Number.isFinite(Number(null)) check turned them into 0, so every
    // online unit rendered stacked at cell (0,0) — "units never placed".
    const result = validateSerializedUnit({
      id: 1,
      type: 'knight',
      row: 2,
      col: 7,
      player: 1,
      visualRow: null,
      visualCol: null,
    });
    expect(result).not.toBeNull();
    expect(result?.visualRow).toBeNull();
    expect(result?.visualCol).toBeNull();
  });

  it('preserves real visual coords (including 0)', () => {
    const result = validateSerializedUnit({
      id: 1,
      type: 'knight',
      row: 0,
      col: 0,
      player: 1,
      visualRow: 0,
      visualCol: 5,
    });
    expect(result?.visualRow).toBe(0);
    expect(result?.visualCol).toBe(5);
  });
});

describe('validateSnapshot', () => {
  it('returns null for snapshots with mismatched version', () => {
    expect(validateSnapshot({ version: 999 })).toBeNull();
  });

  it('returns null when screen is "game" but units list is empty', () => {
    const snap = makeSnapshot({ units: [] });
    expect(validateSnapshot(snap)).toBeNull();
  });

  it('accepts mode="ai" (FUNC-001 fix — no longer pvp-only)', () => {
    const ai = makeSnapshot({ mode: 'ai', aiDifficulty: 'hard' });
    const result = validateSnapshot(ai);
    expect(result).not.toBeNull();
    expect(result?.mode).toBe('ai');
    expect(result?.aiDifficulty).toBe('hard');
  });

  it('preserves story task fields', () => {
    const story = makeSnapshot({
      mode: 'ai',
      currentStoryTask: { ci: 1, gi: 2, ti: 0 },
    });
    const result = validateSnapshot(story);
    expect(result?.currentStoryTask).toEqual({ ci: 1, gi: 2, ti: 0 });
  });

  it('preserves session wins, factions and map theme', () => {
    const snap = makeSnapshot({
      sessionWins: { 1: 3, 2: 2 },
      mapTheme: 'sea',
      p1Faction: 'blue',
      p2Faction: 'purple',
    });
    const result = validateSnapshot(snap);
    expect(result?.sessionWins).toEqual({ 1: 3, 2: 2 });
    expect(result?.mapTheme).toBe('sea');
    expect(result?.p2Faction).toBe('purple');
  });

  it('rejects mutated snapshots with non-finite numeric fields', () => {
    const bad = makeSnapshot({ activatedCount: NaN });
    const result = validateSnapshot(bad);
    expect(result?.activatedCount).toBe(0);
  });
});

describe('isContinuableSnapshot (FUNC-001 fix)', () => {
  it('true for an in-progress AI game with units', () => {
    const ai = validateSnapshot(makeSnapshot({ mode: 'ai' }));
    expect(isContinuableSnapshot(ai)).toBe(true);
  });

  it('false when winner is set', () => {
    const finished = validateSnapshot(makeSnapshot({ mode: 'pvp', winner: 1 }));
    expect(isContinuableSnapshot(finished)).toBe(false);
  });

  it('false when screen is "menu"', () => {
    const menu = validateSnapshot(makeSnapshot({ screen: 'menu' }));
    expect(isContinuableSnapshot(menu)).toBe(false);
  });

  it('false for null input', () => {
    expect(isContinuableSnapshot(null)).toBe(false);
  });
});

describe('readSavedState / writeSnapshot round-trip', () => {
  beforeEach(installLocalStorage);
  afterEach(uninstallLocalStorage);

  it('returns null when key is absent', () => {
    expect(readSavedState()).toBeNull();
  });

  it('round-trips through localStorage for an AI snapshot (FUNC-001 fix)', () => {
    const ai = makeSnapshot({
      mode: 'ai',
      aiDifficulty: 'medium',
      mapTheme: 'sea',
      sessionWins: { 1: 1, 2: 0 },
    });
    writeSnapshot(ai);
    const reloaded = readSavedState();
    expect(reloaded).not.toBeNull();
    expect(reloaded?.mode).toBe('ai');
    expect(reloaded?.aiDifficulty).toBe('medium');
    expect(reloaded?.mapTheme).toBe('sea');
    expect(reloaded?.sessionWins).toEqual({ 1: 1, 2: 0 });
  });

  it('clearSave removes the saved entry', () => {
    writeSnapshot(makeSnapshot());
    expect(readSavedState()).not.toBeNull();
    clearSave();
    expect(readSavedState()).toBeNull();
  });

  it('discards invalid JSON without throwing', () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(SAVE_KEY, '{not valid json}');
    expect(readSavedState()).toBeNull();
  });
});

describe('Phase 1.5 S6 — snapshot v3 upgrade', () => {
  beforeEach(installLocalStorage);
  afterEach(uninstallLocalStorage);

  it('rejects a pre-v4 snapshot outright (per-unit backpacks are structurally incompatible)', () => {
    const v3 = makeSnapshot();
    const v3Raw = JSON.parse(JSON.stringify(v3)) as Record<string, unknown>;
    v3Raw.version = SAVE_VERSION - 1;
    expect(validateSnapshot(v3Raw)).toBeNull();
  });

  it('rejects snapshots with version older than v2', () => {
    const ancient = makeSnapshot();
    const raw = JSON.parse(JSON.stringify(ancient)) as Record<string, unknown>;
    raw.version = 1;
    expect(validateSnapshot(raw)).toBeNull();
  });

  it('round-trip: write v3 → read v3 preserves towers and ruins', () => {
    const snap = makeSnapshot({
      towers: [
        { row: 0, col: 0 },
        { row: 1, col: 1 },
      ],
      ruins: { top: 2, left: 2, width: 5, height: 5 },
    });
    writeSnapshot(snap);
    const out = readSavedState();
    expect(out?.towers).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 1 },
    ]);
    expect(out?.ruins).toEqual({ top: 2, left: 2, width: 5, height: 5 });
  });
});
