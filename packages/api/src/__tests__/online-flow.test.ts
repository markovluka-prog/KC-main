/**
 * End-to-end online flow over a real HTTP + WebSocket server: boots the full
 * Fastify app on an ephemeral port and drives two guest clients through
 * create-room → join → server-authoritative move (with cross-client broadcast)
 * → out-of-turn rejection → end-turn. Covers the WS handler + registry
 * broadcast + dispatchAction wiring that the unit tests can't reach.
 *
 * Env is set before importing the env-dependent app (pool.ts calls loadEnv at
 * module load), then the app is imported dynamically. Uses Node's global
 * WebSocket client (Node 18+).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

const kp = crypto.generateKeyPairSync('ed25519');
process.env.DATABASE_URL = 'postgres://localhost/none';
process.env.JWT_PRIVATE_KEY_JWK = JSON.stringify(kp.privateKey.export({ format: 'jwk' }));
process.env.AUTH_MODE = 'production';
process.env.NODE_ENV = 'development'; // not 'test' → real routes, real rate-limit
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.LOG_LEVEL = 'error';

const { buildApp } = await import('../main.js');

type Frame = Record<string, any>;

let app: Awaited<ReturnType<typeof buildApp>>;
let base = '';
let wsBase = '';

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

async function post(path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Frame };
}

interface TestSocket {
  raw: WebSocket;
  opened: Promise<void>;
  waitFor(pred: (m: Frame) => boolean, ms?: number): Promise<Frame>;
  send(obj: unknown): void;
}

function connect(matchId: string, token: string): TestSocket {
  const ws = new WebSocket(`${wsBase}/ws/v1/match/${matchId}?token=${encodeURIComponent(token)}`);
  const frames: Frame[] = [];
  let waiters: { pred: (m: Frame) => boolean; resolve: (m: Frame) => void }[] = [];
  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as Frame;
    frames.push(msg);
    waiters = waiters.filter((w) => {
      if (w.pred(msg)) {
        w.resolve(msg);
        return false;
      }
      return true;
    });
  });
  return {
    raw: ws,
    opened: new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true })),
    waitFor: (pred, ms = 3000) =>
      new Promise<Frame>((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error('waitFor timeout')), ms);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
    send: (obj) => ws.send(JSON.stringify(obj)),
  };
}

describe('online flow (HTTP + WebSocket, 2 guests)', () => {
  it('guest → create room → join → move (synced) → out-of-turn reject → end-turn', async () => {
    const gA = await post('/api/auth/guest');
    const gB = await post('/api/auth/guest');
    expect(gA.status).toBe(200);
    expect(gA.body.user.isGuest).toBe(true);
    const tokenA = gA.body.accessToken as string;
    const tokenB = gB.body.accessToken as string;

    const room = await post('/api/lobby/room', tokenA);
    expect(room.status).toBe(200);
    expect(room.body.you).toBe(1);
    const { code, matchId } = room.body as { code: string; matchId: string };

    const wsA = connect(matchId, tokenA);
    await wsA.opened;
    const firstA = await wsA.waitFor((m) => m.type === 'state-update');
    expect(firstA.status).toBe('waiting');
    expect(firstA.state.units).toHaveLength(20);
    expect(firstA.you).toBe(1);

    const join = await post('/api/lobby/room/join', tokenB, { code });
    expect(join.status).toBe(200);
    expect(join.body.you).toBe(2);

    const aStarted = await wsA.waitFor(
      (m) => m.type === 'state-update' && m.status === 'in_progress',
    );
    expect(typeof aStarted.turnEndsAt).toBe('number');

    const wsB = connect(matchId, tokenB);
    await wsB.opened;
    const firstB = await wsB.waitFor(
      (m) => m.type === 'state-update' && m.status === 'in_progress',
    );
    expect(firstB.you).toBe(2);

    // Player 1 (A) moves a unit into an empty neighbouring cell.
    const occupied = new Set<string>(aStarted.state.units.map((u: Frame) => `${u.row},${u.col}`));
    const p1 = aStarted.state.units.find((u: Frame) => u.player === 1)!;
    let dest: { r: number; c: number } | null = null;
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const r = p1.row + dr;
      const c = p1.col + dc;
      if (r >= 0 && r < 20 && c >= 0 && c < 20 && !occupied.has(`${r},${c}`)) {
        dest = { r, c };
        break;
      }
    }
    expect(dest).not.toBeNull();
    wsA.send({ kind: 'move', unitId: p1.id, row: dest!.r, col: dest!.c, cost: 1 });

    const movedA = await wsA.waitFor(
      (m) =>
        m.type === 'state-update' &&
        Array.isArray(m.events) &&
        m.events.some((e: Frame) => e.kind === 'unit-moved' && e.data.unitId === p1.id),
    );
    const movedB = await wsB.waitFor(
      (m) =>
        m.type === 'state-update' &&
        Array.isArray(m.events) &&
        m.events.some((e: Frame) => e.kind === 'unit-moved' && e.data.unitId === p1.id),
    );
    const unitA = movedA.state.units.find((u: Frame) => u.id === p1.id);
    expect(unitA.row).toBe(dest!.r);
    expect(unitA.col).toBe(dest!.c);
    expect(movedB.state.units.find((u: Frame) => u.id === p1.id).row).toBe(dest!.r);
    expect(movedA.state.currentPlayer).toBe(1);
    expect(movedA.state.activatedCount).toBe(1);

    // Player 2 (B) cannot act out of turn.
    const p2 = movedB.state.units.find((u: Frame) => u.player === 2)!;
    wsB.send({ kind: 'move', unitId: p2.id, row: p2.row - 1, col: p2.col, cost: 1 });
    const errB = await wsB.waitFor((m) => m.type === 'error');
    expect(errB.code).toBe('wrong-turn');

    // End turn → both clients see player 2 to move, activation reset.
    wsA.send({ kind: 'end-turn' });
    const turnA = await wsA.waitFor(
      (m) => m.type === 'state-update' && m.state.currentPlayer === 2,
    );
    const turnB = await wsB.waitFor(
      (m) => m.type === 'state-update' && m.state.currentPlayer === 2,
    );
    expect(turnA.state.activatedCount).toBe(0);
    expect(turnB.state.currentPlayer).toBe(2);

    wsA.raw.close();
    wsB.raw.close();
  });
});
