import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInitialState, type GameState, type SerializedUnit } from '@kc/game-rules';
import { db, hooks } from './fake-supabase.js';

/**
 * Runs the REAL Supabase Edge Function (supabase/functions/match-action) under
 * Node: Deno.serve/Deno.env are stubbed and supabase-js is aliased to an
 * in-memory fake (vitest.config.ts). Exercises the authoritative turn path end
 * to end — batch apply, turn ownership, atomic rejection, the compare-and-set
 * that stops two racing requests from overwriting each other, win and resign.
 */
type Handler = (req: Request) => Promise<Response>;
let handler: Handler;

beforeAll(async () => {
  (globalThis as unknown as { Deno: unknown }).Deno = {
    serve: (h: Handler) => {
      handler = h;
    },
    env: { get: (k: string) => `env:${k}` },
  };
  // A non-literal path keeps tsc (Node project settings) out of the Deno
  // sources; vitest resolves and transforms it at runtime.
  const fn = '../../../../supabase/functions/match-action/index.ts';
  await import(/* @vite-ignore */ fn);
});

function unit(id: number, player: 1 | 2, type: SerializedUnit['type'], row: number, col: number): SerializedUnit {
  const hp = type === 'cavalry' ? 5 : 3;
  return {
    id, player, type, row, col, maxHp: hp, hp, startArmor: 1, armor: 1, maxArmor: 1, damage: 5,
    maxMoves: 2, movesLeft: 2, done: false, activated: false, visualRow: null, visualCol: null,
    dying: false, deathProgress: 0, weapon: null, armorGear: null,
    backpack: { 'Металл': 0, 'Амулет': 0, 'Рубин': 0, 'Дерево': 0, 'Стрелы': 0 }, wardedBy: null,
  };
}

function seed(state: GameState): void {
  db.matches = [{ id: 'm1', player1: 'alice', player2: 'bob', state, status: 'in_progress', winner: null, updated_at: 't0' }];
  db.clock = 0;
  hooks.beforeUpdate = null;
}

async function call(user: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handler(
    new Request('http://x/match-action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const row = () => db.matches[0]!;
const st = () => row().state as GameState;

describe('Supabase match-action (real function code)', () => {
  beforeEach(() => {
    seed(
      createInitialState({
        mode: 'pvp',
        seed: 7,
        units: [unit(1, 1, 'knight', 5, 5), unit(2, 1, 'knight', 5, 7), unit(3, 2, 'knight', 6, 7)],
      }),
    );
  });

  it('applies a whole turn batch and writes the final state once', async () => {
    const r = await call('alice', {
      matchId: 'm1',
      actions: [
        { kind: 'move', unitId: 1, row: 4, col: 5, cost: 1 },
        { kind: 'attack', unitId: 2, mode: 'shot', cost: 1, targetRow: 6, targetCol: 7, landingRow: 5, landingCol: 7 },
        { kind: 'end-turn' },
      ],
    });
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(st().currentPlayer).toBe(2);
    expect(st().units.find((u) => u.id === 1)!.row).toBe(4);
    expect(st().units.find((u) => u.id === 3)).toBeUndefined(); // 5 dmg vs 1 armor + 3 hp
    expect(db.clock).toBe(1);
  });

  it('rejects the whole batch atomically when any action is illegal', async () => {
    const before = JSON.stringify(row());
    const r = await call('alice', {
      matchId: 'm1',
      actions: [
        { kind: 'move', unitId: 1, row: 4, col: 5, cost: 1 },
        { kind: 'move', unitId: 1, row: 0, col: 0, cost: 1 }, // teleport
      ],
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(row())).toBe(before);
  });

  it('refuses actions from the player whose turn it is not, and from strangers', async () => {
    expect((await call('bob', { matchId: 'm1', actions: [{ kind: 'end-turn' }] })).status).toBe(403);
    expect((await call('mallory', { matchId: 'm1', actions: [{ kind: 'end-turn' }] })).status).toBe(403);
    expect((await call('', { matchId: 'm1', actions: [{ kind: 'end-turn' }] })).status).toBe(401);
  });

  it('a request racing another write is rejected instead of overwriting it', async () => {
    // Another request lands between this one's read and its write.
    hooks.beforeUpdate = () => {
      hooks.beforeUpdate = null;
      row().updated_at = 'concurrent';
    };
    const r = await call('alice', { matchId: 'm1', actions: [{ kind: 'move', unitId: 1, row: 4, col: 5, cost: 1 }] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('stale-state');
    expect(st().units.find((u) => u.id === 1)!.row).toBe(5); // not overwritten
  });

  it('a capturing move finishes the match; nothing further is accepted', async () => {
    // P1 knight steps into P2's empty castle (rows 16-19, castleP2Col default 8).
    seed(
      createInitialState({
        mode: 'pvp',
        seed: 7,
        units: [unit(1, 1, 'knight', 15, 9), unit(3, 2, 'knight', 2, 2)],
      }),
    );
    const r = await call('alice', {
      matchId: 'm1',
      actions: [{ kind: 'move', unitId: 1, row: 16, col: 9, cost: 1 }, { kind: 'end-turn' }],
    });
    expect(r.status).toBe(200);
    expect(row().status).toBe('finished');
    expect(row().winner).toBe(1);
    expect(st().currentPlayer).toBe(1); // end-turn after the win changed nothing
    expect((await call('alice', { matchId: 'm1', actions: [{ kind: 'end-turn' }] })).status).toBe(409);
  });

  it('either side may resign at any time, but never for the opponent', async () => {
    expect((await call('alice', { matchId: 'm1', action: { kind: 'resign', player: 2 } })).status).toBe(403);
    const r = await call('bob', { matchId: 'm1', action: { kind: 'resign', player: 2 } });
    expect(r.status).toBe(200);
    expect(row().winner).toBe(1);
  });

  it('rejects malformed bodies', async () => {
    expect((await call('alice', { matchId: 'm1', actions: [] })).status).toBe(400);
    expect((await call('alice', { matchId: 'm1', actions: [null] })).status).toBe(400);
    expect((await call('alice', { matchId: 'nope', actions: [{ kind: 'end-turn' }] })).status).toBe(404);
  });
});
