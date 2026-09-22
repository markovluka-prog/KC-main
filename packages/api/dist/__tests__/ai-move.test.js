/**
 * Integration tests for POST /api/ai-move.
 * Uses Fastify's app.inject() — no real HTTP, no Ollama/OpenRouter needed.
 * All LLM calls are mocked via environment control.
 */
import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
process.env.DATABASE_URL = 'postgres://test';
process.env.JWT_PRIVATE_KEY_JWK = '{}';
process.env.NODE_ENV = 'test';
// ── helpers ──────────────────────────────────────────────────────────────────
function makeUnit(id, overrides = {}) {
    return {
        id,
        type: 'knight',
        row: 5,
        col: 3,
        hp: 8,
        maxHp: 8,
        armor: 2,
        damage: 4,
        movesLeft: 2,
        availableActions: [
            { type: 'move', row: 4, col: 3, desc: 'Move to (row 4, col 3)' },
            { type: 'move', row: 6, col: 3, desc: 'Move to (row 6, col 3)' },
        ],
        ...overrides,
    };
}
function makeEnemy(id) {
    return { id, type: 'archer', row: 2, col: 3, hp: 6, maxHp: 6, armor: 0, damage: 5 };
}
function post(app, body) {
    return app.inject({
        method: 'POST',
        url: '/api/ai-move',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}
// ── setup ─────────────────────────────────────────────────────────────────────
let app;
beforeAll(async () => {
    const { registerAIMoveRoute } = await import('../routes/ai-move.js');
    app = Fastify();
    await app.register(registerAIMoveRoute, { prefix: '/api' });
    await app.ready();
});
afterEach(() => {
    vi.restoreAllMocks();
    // Reset env between tests
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
});
// ── tests ─────────────────────────────────────────────────────────────────────
describe('POST /api/ai-move', () => {
    it('returns 200 with empty plan when no units sent', async () => {
        const res = await post(app, { player: 2, myUnits: [], enemyUnits: [] });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.plan).toEqual([]);
    });
    it('search fallback: plans for every actionable unit when Ollama is down and no OpenRouter key', async () => {
        // Point Ollama at an invalid address so it always fails
        process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
        const res = await post(app, {
            player: 2,
            myUnits: [makeUnit(1), makeUnit(2)],
            enemyUnits: [makeEnemy(10)],
        });
        expect(res.statusCode).toBe(200);
        const { plan } = JSON.parse(res.body);
        // The search plans one action per unit that can act (no unit acts twice).
        expect(plan).toHaveLength(2);
        expect(plan.map((p) => p.unitId).sort()).toEqual([1, 2]);
    });
    it('search fallback: unit with no actions is excluded', async () => {
        process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
        const res = await post(app, {
            player: 2,
            myUnits: [
                makeUnit(1), // has 2 actions
                makeUnit(2, { availableActions: [] }), // no actions
            ],
            enemyUnits: [],
        });
        expect(res.statusCode).toBe(200);
        const { plan } = JSON.parse(res.body);
        expect(plan).toHaveLength(1);
        expect(plan[0]?.unitId).toBe(1);
    });
    it('accepts all three difficulty values without error', async () => {
        process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
        for (const difficulty of ['easy', 'medium', 'hard']) {
            const res = await post(app, {
                player: 2,
                difficulty,
                myUnits: [makeUnit(1)],
                enemyUnits: [],
            });
            expect(res.statusCode).toBe(200);
        }
    });
    it('unknown difficulty falls back to medium behaviour without crashing', async () => {
        process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
        const res = await post(app, {
            player: 2,
            difficulty: 'legendary',
            myUnits: [makeUnit(1)],
            enemyUnits: [],
        });
        expect(res.statusCode).toBe(200);
    });
    it('Ollama unreachable + no OpenRouter key → search fallback, no crash', async () => {
        process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
        // no OPENROUTER_API_KEY
        const res = await post(app, {
            player: 2,
            myUnits: [makeUnit(1), makeUnit(2)],
            enemyUnits: [makeEnemy(10)],
        });
        expect(res.statusCode).toBe(200);
        const { plan } = JSON.parse(res.body);
        // search fallback: one entry per unit that has actions
        expect(plan).toHaveLength(2);
    });
    it('both Ollama and OpenRouter unreachable → search fallback, no crash', async () => {
        process.env.OLLAMA_BASE_URL = 'http://localhost:19999';
        process.env.OPENROUTER_API_KEY = 'fake-key';
        // Point OpenRouter at a dead local port too. Previously this test left the
        // base URL at the real openrouter.ai and relied on the fake key being
        // rejected quickly — a live network call that made the test flaky (it
        // intermittently blew the 5 s timeout when the round trip was slow).
        process.env.OPENROUTER_BASE_URL = 'http://localhost:19998/v1';
        const res = await post(app, {
            player: 2,
            myUnits: [makeUnit(1)],
            enemyUnits: [],
        });
        expect(res.statusCode).toBe(200);
    });
});
