/*
 * The search's light-state move generator MUST agree with the game's real rules.
 *
 * These are two independent implementations: the game builds its `moveMap` from
 * `generateLegalMoves` (@kc/game-rules), while the MCTS plans against
 * `generateActionsForLightState`. When they disagree the game simply rejects the
 * planned move — `performMove` looks it up in `moveMap`, gets undefined, returns
 * false, and the AI's action is silently dropped. The unit stands still and the
 * turn is wasted, which looks exactly like "the bot plays badly".
 *
 * That is not hypothetical: the search used to emit 2-cell orthogonal moves for
 * knights (half of them illegal) and 8-direction 2-cell moves for samurai (12 of
 * 16 illegal). generateLegalMoves `break`s after one step for every non-archer
 * and never emits diagonals. The opening has 7 knights out of 10 units.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { generateAttackActions, generateLegalMoves, getTerrain, setTerrain } from '@kc/game-rules';
import { AI_DIFFICULTY, type AIConfig } from '../ai-config.js';
import { makeSearcher, makeState, makeUnit } from './mcts-harness.js';

const TYPES = ['knight', 'samurai', 'archer', 'cavalry', 'crossbow', 'catapult'] as const;

describe('move generator agrees with the real rules', () => {
  it.each(TYPES)('%s: every searched move is a legal move', (type) => {
    // A lone unit in open space, with one distant enemy so the board has a
    // blocked cell to respect.
    const u = makeUnit({ id: 1, player: 2, type: type as never, row: 10, col: 10 });
    const enemy = makeUnit({ id: 2, player: 1, type: 'knight', row: 2, col: 2 });
    const state = makeState([u, enemy], 3);
    const ai = makeSearcher(
      2,
      { ...AI_DIFFICULTY.hard, label: 'test' } as Partial<AIConfig>,
      state,
      true,
      3,
    ) as unknown as {
      generateActionsForLightState: (s: unknown, u: unknown) => Array<Record<string, unknown>>;
    };

    const board = {
      isFree: (r: number, c: number) =>
        r >= 0 && r < 20 && c >= 0 && c < 20 && !(r === enemy.row && c === enemy.col),
    };
    const legal = new Set(
      generateLegalMoves(board as never, u as never).map((m) => `${m.row},${m.col}`),
    );
    const searched = ai
      .generateActionsForLightState(state, u)
      .filter((a) => a.type === 'move')
      .map((a) => `${a.row as number},${a.col as number}`);

    expect(searched.length).toBeGreaterThan(0);
    const illegal = searched.filter((m) => !legal.has(m));
    expect(illegal).toEqual([]);
  });
});

describe('impassable terrain is respected', () => {
  const saved = getTerrain();
  afterAll(() => setTerrain(saved as never));

  it.each(TYPES)('%s never plans a move into river or mountain', (type) => {
    // Ring the unit with water and rock: Board.isFree() rejects both, so the
    // search must not offer them. It used to check only board bounds and unit
    // occupancy — measured in a live game, 10 of 80 planned moves (12.5%) were
    // refused by the game and the unit's activation was wasted.
    setTerrain([
      { row: 9, col: 10, type: 'river' },
      { row: 11, col: 10, type: 'mountain' },
      { row: 10, col: 9, type: 'river' },
      { row: 10, col: 11, type: 'mountain' },
    ] as never);

    const u = makeUnit({ id: 1, player: 2, type: type as never, row: 10, col: 10 });
    const state = makeState([u], 3);
    const ai = makeSearcher(
      2,
      { ...AI_DIFFICULTY.hard, label: 'test' } as Partial<AIConfig>,
      state,
      true,
      3,
    ) as unknown as {
      generateActionsForLightState: (s: unknown, u: unknown) => Array<Record<string, unknown>>;
    };

    const blocked = new Set(['9,10', '11,10', '10,9', '10,11']);
    const searched = ai
      .generateActionsForLightState(state, u)
      .filter((a) => a.type === 'move')
      .map((a) => `${a.row as number},${a.col as number}`);

    expect(searched.filter((m) => blocked.has(m))).toEqual([]);
  });
});

describe('attack generator agrees with the real rules', () => {
  // Ring the unit with enemies in every orthogonal AND diagonal direction, so
  // every unit type's full attack shape (including cavalry's Г-attack side
  // landings) has a target to react to.
  const RING: Array<[number, number]> = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ];

  it.each(TYPES)('%s: every searched attack (incl. landing square) is legal', (type) => {
    const u = makeUnit({ id: 1, player: 2, type: type as never, row: 10, col: 10, movesLeft: 3 });
    // Catapult's minimum range is 3, so it has nothing to hit at ring distance
    // 1 — give it a matching ring of enemies at distance 4 instead.
    const dist = type === 'catapult' ? 4 : 1;
    const enemies = RING.map(([dr, dc], i) =>
      makeUnit({
        id: 100 + i,
        player: 1,
        type: 'knight',
        row: 10 + dr * dist,
        col: 10 + dc * dist,
        hp: 5,
      }),
    );
    const state = makeState([u, ...enemies], 3);
    const ai = makeSearcher(
      2,
      { ...AI_DIFFICULTY.hard, label: 'test' } as Partial<AIConfig>,
      state,
      true,
      3,
    ) as unknown as {
      generateActionsForLightState: (s: unknown, u: unknown) => Array<Record<string, unknown>>;
    };

    const board = {
      unitAt: (r: number, c: number) => enemies.find((e) => e.row === r && e.col === c) ?? null,
      isFree: (r: number, c: number) =>
        r >= 0 && r < 20 && c >= 0 && c < 20 && !enemies.some((e) => e.row === r && e.col === c),
    };
    const legal = new Set(
      generateAttackActions(board as never, u as never).map(
        (a) => `${a.targetRow},${a.targetCol}->${a.landingRow},${a.landingCol}`,
      ),
    );
    const searched = ai
      .generateActionsForLightState(state, u)
      .filter((a) => a.type === 'attack')
      .map(
        (a) =>
          `${a.targetRow as number},${a.targetCol as number}->${a.landingRow as number},${a.landingCol as number}`,
      );

    expect(searched.length).toBeGreaterThan(0);
    const illegal = searched.filter((a) => !legal.has(a));
    expect(illegal).toEqual([]);
  });
});
