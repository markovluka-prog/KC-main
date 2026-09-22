/**
 * Tests for the ApiFreeLLM provider branch in POST /api/ai-move.
 *
 * ApiFreeLLM's free tier is not OpenAI-compatible (that endpoint answers
 * 403 premium_required), so this branch talks to `/api/v1/chat` over plain
 * fetch. These tests stub global fetch and point APIFREELLM_BASE_URL at a fake
 * host — no network, no key spent.
 *
 * The behaviour that matters most: a slow, rate-limited or broken provider must
 * never hang or break a turn. It must fall through to the local search, which
 * always returns a legal plan.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.DATABASE_URL = 'postgres://test';
process.env.JWT_PRIVATE_KEY_JWK = '{}';
process.env.NODE_ENV = 'test';

const FAKE_BASE = 'https://apifreellm.test';

function makeUnit(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'knight',
    row: 10,
    col: 10,
    hp: 6,
    maxHp: 6,
    armor: 1,
    damage: 6,
    movesLeft: 2,
    availableActions: [
      { type: 'move', row: 9, col: 10, desc: 'Move to (row 9, col 10)' },
      {
        type: 'attack',
        targetRow: 10,
        targetCol: 11,
        landingRow: 10,
        landingCol: 10,
        desc: 'Attack knight #9 [KILLS!]',
      },
    ],
    ...overrides,
  };
}

function body() {
  return {
    player: 2,
    difficulty: 'medium',
    myUnits: [makeUnit(1)],
    enemyUnits: [
      { id: 9, type: 'knight', row: 10, col: 11, hp: 1, maxHp: 1, armor: 0, damage: 3 },
    ],
  };
}

function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/ai-move',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Build a fetch stub that only answers the ApiFreeLLM chat endpoint. */
function stubFetch(handler: (url: string) => { status: number; json: unknown }) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const { status, json } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  const { registerAIMoveRoute } = await import('../routes/ai-move.js');
  app = Fastify();
  await app.register(registerAIMoveRoute, { prefix: '/api' });
  await app.ready();
});

beforeEach(() => {
  // Ollama must fail so the chain reaches ApiFreeLLM.
  process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
  process.env.APIFREELLM_BASE_URL = FAKE_BASE;
  process.env.APIFREELLM_API_KEY = 'apf_test_key';
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.APIFREELLM_API_KEY;
  delete process.env.APIFREELLM_BASE_URL;
  delete process.env.APIFREELLM_MAX_WAIT_MS;
});

describe('ApiFreeLLM provider', () => {
  it('uses the plan it returns, in the free tier response shape', async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      // The real free-tier shape: { success, response } with JSON inside a string.
      json: { success: true, response: '{"plan":[{"unitId":1,"actionIndex":1}]}' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const { plan } = JSON.parse(res.body) as { plan: Array<{ unitId: number; action: { type: string } }> };
    // actionIndex 1 is the attack — proof the LLM's choice was used, not the search's.
    expect(plan).toHaveLength(1);
    expect(plan[0]!.action.type).toBe('attack');

    const called = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u === `${FAKE_BASE}/api/v1/chat`)).toBe(true);
  });

  it('sends the key as an Authorization: Bearer header', async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      json: { success: true, response: '{"plan":[{"unitId":1,"actionIndex":0}]}' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await post(app, body());
    const init = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/v1/chat'))?.[1] as
      | RequestInit
      | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer apf_test_key');
    // The free endpoint takes a single `message`, not OpenAI `messages`.
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(typeof sent.message).toBe('string');
    expect(sent.messages).toBeUndefined();
  });

  it('retries after a 429 and then succeeds', async () => {
    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return { status: 429, json: { success: false, error: 'Rate limited', retryAfter: 0 } };
      }
      return { status: 200, json: { success: true, response: '{"plan":[{"unitId":1,"actionIndex":1}]}' } };
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const { plan } = JSON.parse(res.body) as { plan: Array<{ action: { type: string } }> };
    expect(plan[0]!.action.type).toBe('attack');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('gives up on a long rate limit instead of hanging the turn', async () => {
    // retryAfter far exceeds the wait budget: the branch must bail immediately
    // and let the local search answer, not sleep for 60s mid-turn.
    process.env.APIFREELLM_MAX_WAIT_MS = '50';
    const fetchMock = stubFetch(() => ({
      status: 429,
      json: { success: false, error: 'Rate limited', retryAfter: 60 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const started = Date.now();
    const res = await post(app, body());
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(5000); // did not wait out the 60s
    const { plan } = JSON.parse(res.body) as { plan: unknown[] };
    expect(plan.length).toBeGreaterThan(0); // search fallback still answered
  });

  it('falls through to the local search when the provider errors', async () => {
    const fetchMock = stubFetch(() => ({
      status: 500,
      json: { success: false, error: 'boom' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const { plan } = JSON.parse(res.body) as { plan: Array<{ action: { type: string } }> };
    // The search finds the same free kill on its own.
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0]!.action.type).toBe('attack');
  });

  it('falls through when the model returns unparseable text', async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      json: { success: true, response: 'I think unit 1 should probably attack, good luck!' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const { plan } = JSON.parse(res.body) as { plan: unknown[] };
    expect(plan.length).toBeGreaterThan(0);
  });

  it('is skipped entirely when no key is configured', async () => {
    delete process.env.APIFREELLM_API_KEY;
    const fetchMock = stubFetch(() => ({ status: 200, json: { success: true, response: '{}' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    // No request may be made to the provider without a key.
    const hit = fetchMock.mock.calls.some((c) => String(c[0]).includes('apifreellm'));
    expect(hit).toBe(false);
  });

  it('never returns an action the client did not offer', async () => {
    // A hostile/confused model naming an out-of-range action index must not
    // produce an illegal move — the parser drops it and the search answers.
    const fetchMock = stubFetch(() => ({
      status: 200,
      json: { success: true, response: '{"plan":[{"unitId":1,"actionIndex":99}]}' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(app, body());
    const { plan } = JSON.parse(res.body) as {
      plan: Array<{ unitId: number; action: Record<string, unknown> }>;
    };
    const legal = makeUnit(1).availableActions;
    for (const entry of plan) {
      expect(entry.unitId).toBe(1);
      expect(legal.some((a) => a.desc === entry.action.desc)).toBe(true);
    }
  });
});
