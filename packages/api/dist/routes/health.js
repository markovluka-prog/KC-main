import fp from 'fastify-plugin';
import { pingDb } from '../db/pool.js';
const healthPlugin = async (app) => {
    app.get('/healthz', async () => ({ status: 'ok' }));
    app.get('/readyz', async (_req, reply) => {
        const dbOk = await pingDb();
        if (!dbOk)
            return reply.code(503).send({ status: 'db-unavailable' });
        return { status: 'ready' };
    });
};
export const registerHealthRoutes = fp(healthPlugin, { name: 'kc-health' });
