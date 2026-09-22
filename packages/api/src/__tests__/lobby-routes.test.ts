/**
 * HTTP integration tests for the lobby routes (room-code + queue + rematch).
 * Builds a minimal Fastify app with only the lobby plugin (no DB-backed auth
 * routes) and authenticates with real Ed25519 JWTs. Env is set before any
 * lazy loadEnv()/loadKeys() call, then the env-dependent modules are imported.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const kp = crypto.generateKeyPairSync('ed25519');
process.env.DATABASE_URL = 'postgres://test';
process.env.JWT_PRIVATE_KEY_JWK = JSON.stringify(kp.privateKey.export({ format: 'jwk' }));
process.env.AUTH_MODE = 'production';
process.env.NODE_ENV = 'test';

const { registerLobbyRoutes, _userActiveMatch } = await import('../lobby/routes.js');
const { signAccessToken } = await import('../auth/jwt.js');
const { getMatch } = await import('../match/registry.js');
const { _resetRooms } = await import('../lobby/rooms.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  await app.register(registerLobbyRoutes, { prefix: '/api' });
  await app.ready();
});

afterEach(() => {
  _userActiveMatch.clear();
  _resetRooms();
});

function inj(
  method: 'POST' | 'GET',
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}

describe('lobby room-code flow', () => {
  it('host creates a room and a second player joins by code', async () => {
    const a = await signAccessToken('user-a');
    const b = await signAccessToken('user-b');

    const created = await inj('POST', '/api/lobby/room', a);
    expect(created.statusCode).toBe(200);
    const room = created.json() as { code: string; matchId: string; you: number };
    expect(room.code).toHaveLength(6);
    expect(room.you).toBe(1);

    // Room is visible while waiting.
    const status = await inj('GET', `/api/lobby/room/${room.code}`, b);
    expect(status.json()).toMatchObject({ exists: true, status: 'waiting' });

    const joined = await inj('POST', '/api/lobby/room/join', b, { code: room.code });
    expect(joined.statusCode).toBe(200);
    const jr = joined.json() as { matchId: string; you: number };
    expect(jr.you).toBe(2);
    expect(jr.matchId).toBe(room.matchId);

    // The match is now in progress and the code is consumed.
    const rec = getMatch(room.matchId);
    expect(rec?.status).toBe('in_progress');
    const after = await inj('GET', `/api/lobby/room/${room.code}`, a);
    expect(after.json()).toMatchObject({ exists: false });
  });

  it('rejects joining an unknown code', async () => {
    const b = await signAccessToken('user-unknown');
    const res = await inj('POST', '/api/lobby/room/join', b, { code: 'ZZZZZZ' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'room-not-found' });
  });

  it('lowercased / dashed codes still join', async () => {
    const a = await signAccessToken('user-lc-a');
    const b = await signAccessToken('user-lc-b');
    const room = (await inj('POST', '/api/lobby/room', a)).json() as { code: string };
    const messy = `${room.code.slice(0, 3)}-${room.code.slice(3)}`.toLowerCase();
    const joined = await inj('POST', '/api/lobby/room/join', b, { code: messy });
    expect(joined.statusCode).toBe(200);
    expect((joined.json() as { you: number }).you).toBe(2);
  });
});

describe('lobby queue flow', () => {
  it('first player waits, second player pairs', async () => {
    const c = await signAccessToken('user-c');
    const d = await signAccessToken('user-d');
    const first = await inj('POST', '/api/lobby/queue', c);
    expect(first.json()).toMatchObject({ paired: false });
    const second = await inj('POST', '/api/lobby/queue', d);
    const sr = second.json() as { paired: boolean; matchId: string; you: number };
    expect(sr.paired).toBe(true);
    expect(typeof sr.matchId).toBe('string');
    expect(sr.you).toBe(2);
    // The match is in progress for both.
    expect(getMatch(sr.matchId)?.status).toBe('in_progress');
  });
});

describe('lobby rematch flow', () => {
  it('creates a new match only after both players opt in', async () => {
    const a = await signAccessToken('user-rm-a');
    const b = await signAccessToken('user-rm-b');
    const room = (await inj('POST', '/api/lobby/room', a)).json() as {
      code: string;
      matchId: string;
    };
    await inj('POST', '/api/lobby/room/join', b, { code: room.code });

    // Force-finish the match so a rematch is allowed.
    const rec = getMatch(room.matchId)!;
    rec.status = 'finished';
    rec.state.winner = 1;

    const first = await inj('POST', '/api/lobby/rematch', a, { matchId: room.matchId });
    expect(first.json()).toMatchObject({ ready: false, waiting: true });

    const second = await inj('POST', '/api/lobby/rematch', b, { matchId: room.matchId });
    const sr = second.json() as { ready: boolean; matchId: string; you: number };
    expect(sr.ready).toBe(true);
    expect(typeof sr.matchId).toBe('string');
    expect(sr.matchId).not.toBe(room.matchId);
    expect(getMatch(sr.matchId)?.status).toBe('in_progress');
  });

  it('rejects a rematch on a still-running match', async () => {
    const a = await signAccessToken('user-rm2-a');
    const b = await signAccessToken('user-rm2-b');
    const room = (await inj('POST', '/api/lobby/room', a)).json() as {
      code: string;
      matchId: string;
    };
    await inj('POST', '/api/lobby/room/join', b, { code: room.code });
    const res = await inj('POST', '/api/lobby/rematch', a, { matchId: room.matchId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not-finished' });
  });
});
