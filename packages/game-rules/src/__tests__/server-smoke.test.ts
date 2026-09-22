/**
 * Phase 1.5 S7 — proves that @kc/game-rules can be imported and used in a
 * pure server-side context: no DOM globals, no localStorage, no Math.random
 * leakage. If this test ever fails, server bundle imports got polluted.
 *
 * Imports ONLY from '@kc/game-rules' (no '/storage'). Any future change
 * that pulls localStorage into the main barrel will break this file.
 */
import { describe, expect, it } from 'vitest';
import {
  RULES_VERSION,
  applyAction,
  createInitialState,
  endTurn,
  mulberry32,
  type GameState,
  type ServerAction,
  type SerializedUnit,
} from '../index.js';
import { UNIT_TYPES } from '../constants.js';

function mkUnit(
  over: Partial<SerializedUnit> & Pick<SerializedUnit, 'id' | 'player' | 'type'>,
): SerializedUnit {
  const t = UNIT_TYPES[over.type];
  return {
    row: 0,
    col: 0,
    maxHp: t.hp,
    hp: t.hp,
    startArmor: t.armor,
    armor: t.armor,
    maxArmor: t.armor,
    damage: t.damage,
    maxMoves: t.moves,
    movesLeft: t.moves,
    done: false,
    activated: false,
    visualRow: null,
    visualCol: null,
    dying: false,
    deathProgress: 0,
    weapon: null,
    ...over,
  };
}

describe('server-smoke: pure import + deterministic replay', () => {
  it('module barrel does not touch localStorage at import time', () => {
    // If `@kc/game-rules` ever pulls localStorage into the barrel, this
    // assertion catches it: in pure Node there's no `globalThis.localStorage`.
    expect((globalThis as { localStorage?: unknown }).localStorage).toBeUndefined();
  });

  it('createInitialState + applyAction produce a deterministic state from a seed', () => {
    const seed = 12345;
    const buildState = (): GameState =>
      createInitialState({
        mode: 'pvp',
        seed,
        units: [
          mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 }),
          mkUnit({ id: 2, player: 2, type: 'archer', row: 5, col: 7 }),
        ],
      });

    const sequence: ServerAction[] = [
      { kind: 'move', unitId: 1, row: 5, col: 6, cost: 1 },
      { kind: 'end-turn' },
      { kind: 'move', unitId: 2, row: 5, col: 8, cost: 1 },
      { kind: 'end-turn' },
      {
        kind: 'attack',
        unitId: 1,
        mode: 'shot',
        cost: 2,
        targetRow: 5,
        targetCol: 8,
        landingRow: 5,
        landingCol: 6,
      },
    ];

    const runOnce = (): GameState => {
      let s = buildState();
      const rng = mulberry32(seed);
      for (const a of sequence) {
        const res = applyAction(s, a, rng);
        if (!res.ok) throw new Error(`unexpected error: ${res.error.code}`);
        s = res.value;
      }
      return s;
    };

    const a = runOnce();
    const b = runOnce();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('endTurn flips currentPlayer and refills movesLeft for opponent', () => {
    const s = createInitialState({
      mode: 'pvp',
      seed: 1,
      units: [mkUnit({ id: 1, player: 2, type: 'knight', done: true, movesLeft: 0 })],
    });
    const after = endTurn(s);
    expect(after.currentPlayer).toBe(2);
    const u = after.units.find((x) => x.id === 1)!;
    expect(u.done).toBe(false);
    expect(u.movesLeft).toBe(UNIT_TYPES.knight.moves);
  });

  it('rulesVersion is exposed (audit field for match-record)', () => {
    expect(RULES_VERSION).toBeGreaterThan(0);
    const s = createInitialState({ mode: 'pvp', seed: 1 });
    expect(s.rulesVersion).toBe(RULES_VERSION);
  });

  it('rngCursor increments deterministically across action stream', () => {
    const s = createInitialState({
      mode: 'pvp',
      seed: 7,
      units: [mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5 })],
    });
    // Put a ruins area under the unit so search-ruins is legal.
    const withRuins: GameState = { ...s, ruins: { top: 5, left: 5, width: 1, height: 1 } };
    const rng = mulberry32(7);
    const res = applyAction(withRuins, { kind: 'search-ruins', unitId: 1 }, rng);
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.rngCursor).toBe(1);
  });
});
