/**
 * Tests for the Groq provider branch in POST /api/ai-move.
 *
 * Groq is OpenAI-compatible, so unlike ApiFreeLLM it needs no bespoke transport
 * — it reuses `makeClient` / `callLLM`. These tests stub the OpenAI SDK so no
 * network call and no key are needed.
 *
 * The behaviours that matter: it is tried before the slower providers, it asks
 * for JSON mode so the model cannot answer with prose, and any failure falls
 * through to the next provider rather than breaking the turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.DATABASE_URL = 'postgres://test';
process.env.JWT_PRIVATE_KEY_JWK = '{}';
process.env.NODE_ENV = 'test';

/** Captured `chat.completions.create` calls, newest last. */
const calls: Array<{ baseURL?: string; apiKey?: string; body: Record<string, unknown> }> = [];
/** Queue of behaviours, one per call: a reply string or an Error to throw. */
let script: Array<string | Error> = [];

vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      baseURL?: string;
      apiKey?: string;
      chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } };

      constructor(opts: { baseURL?: string; apiKey?: string }) {
        this.baseURL = opts.baseURL;
        this.apiKey = opts.apiKey;
        this.chat = {
          completions: {
            create: async (body: Record<string, unknown>) => {
              calls.push({ baseURL: this.baseURL, apiKey: this.apiKey, body });
              const next = script.shift();
              if (next instanceof Error) throw next;
              if (next === undefined) throw new Error('provider unavailable');
              return { choices: [{ message: { content: next } }] };
            },
          },
        };
      }
    },
  };
});

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

async function makeApp(): Promise<FastifyInstance> {
  const { registerAIMoveRoute } = await import('../routes/ai-move.js');
  const app = Fastify();
  await app.register(registerAIMoveRoute, { prefix: '/api' });
  await app.ready();
  return app;
}

function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/ai-move',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Requests made to the Groq base URL. */
function groqCalls() {
  return calls.filter((c) => (c.baseURL ?? '').includes('groq'));
}

let app: FastifyInstance;

beforeEach(async () => {
  calls.length = 0;
  script = [];
  process.env.GROQ_API_KEY = 'gsk_test_key';
  process.env.GROQ_BASE_URL = 'https://groq.test/openai/v1';
  process.env.GROQ_MODEL = 'test-model';
  // Ollama is tried first and must fail so the chain reaches Groq.
  process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
  delete process.env.APIFREELLM_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  app = await makeApp();
});

afterEach(async () => {
  await app.close();
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_BASE_URL;
  delete process.env.GROQ_MODEL;
  delete process.env.OLLAMA_BASE_URL;
});

describe('Groq provider', () => {
  it('uses the plan Groq returns', async () => {
    script = [
      new Error('ollama down'),
      '{"plan":[{"unitId":1,"actionIndex":1}]}',
    ];

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const { plan } = JSON.parse(res.body) as {
      plan: Array<{ unitId: number; action: { type: string } }>;
    };
    // actionIndex 1 is the attack — proof the LLM's choice was used.
    expect(plan).toHaveLength(1);
    expect(plan[0]!.action.type).toBe('attack');
  });

  it('requests JSON mode so the model cannot reply with prose', async () => {
    script = [new Error('ollama down'), '{"plan":[{"unitId":1,"actionIndex":0}]}'];
    await post(app, body());

    const call = groqCalls()[0];
    expect(call).toBeDefined();
    expect(call!.body.response_format).toEqual({ type: 'json_object' });
    expect(call!.body.model).toBe('test-model');
    expect(call!.apiKey).toBe('gsk_test_key');
  });

  it('does NOT request JSON mode from Ollama, whose shim rejects unknown fields', async () => {
    script = [new Error('ollama down'), '{"plan":[{"unitId":1,"actionIndex":0}]}'];
    await post(app, body());

    const ollama = calls.find((c) => (c.baseURL ?? '').includes('19999'));
    expect(ollama).toBeDefined();
    expect(ollama!.body.response_format).toBeUndefined();
  });

  it('is tried before ApiFreeLLM when both are configured', async () => {
    process.env.APIFREELLM_API_KEY = 'apf_test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    script = [new Error('ollama down'), '{"plan":[{"unitId":1,"actionIndex":1}]}'];

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    expect(groqCalls()).toHaveLength(1);
    // Groq answered, so the slower rate-limited provider was never called.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('falls through to the local search when Groq errors', async () => {
    script = [new Error('ollama down'), new Error('groq 500')];

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const { plan } = JSON.parse(res.body) as { plan: Array<{ action: { type: string } }> };
    // The search finds the same free kill on its own.
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0]!.action.type).toBe('attack');
  });

  it('falls through when Groq returns unparseable text', async () => {
    script = [new Error('ollama down'), 'I think unit 1 should attack. Good luck!'];

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    const { plan } = JSON.parse(res.body) as { plan: unknown[] };
    expect(plan.length).toBeGreaterThan(0);
  });

  it('is skipped entirely when no key is configured', async () => {
    delete process.env.GROQ_API_KEY;
    script = [new Error('ollama down')];

    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    expect(groqCalls()).toHaveLength(0);
  });

  it('never returns an action the client did not offer', async () => {
    // An out-of-range actionIndex must not produce an illegal move.
    script = [new Error('ollama down'), '{"plan":[{"unitId":1,"actionIndex":99}]}'];

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
