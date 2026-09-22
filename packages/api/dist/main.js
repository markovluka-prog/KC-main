/**
 * Phase 3 T3.1 — Fastify backend entry point.
 *
 * Boot order:
 *   1. Validate env via zod (loadEnv).
 *   2. Init pino logger with PII redaction.
 *   3. Build Fastify app, register CORS + rate-limit + routes.
 *   4. Listen on PORT (Cloud Run sets it dynamically).
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { getCorsOrigins, loadEnv } from './env.js';
import { logger } from './log.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLobbyRoutes } from './lobby/routes.js';
import { registerMatchWebSocket } from './match/ws-handler.js';
import { registerAIMoveRoute } from './routes/ai-move.js';
import { registerProgressRoutes } from './routes/progress.js';
async function buildApp() {
    const env = loadEnv();
    const app = Fastify({
        loggerInstance: logger,
        disableRequestLogging: false,
    });
    await app.register(cors, {
        origin: getCorsOrigins(env),
        credentials: true,
    });
    await app.register(cookie);
    // T3.11 baseline — global generous limit; tighter per-route limits added
    // alongside auth routes (Phase 3 T3.11).
    await app.register(rateLimit, {
        max: 300,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.headers['x-forwarded-for']?.toString() ?? req.ip,
    });
    // Health endpoints at root so Cloud Run liveness/startup probes work
    // without needing the LB URL-map to route them.
    await app.register(registerHealthRoutes);
    // All auth/lobby/match routes live behind /api/ so the LB URL-map can
    // route /api/* → Cloud Run, everything else → the web bucket. (Same
    // domain split per master plan §11.3.)
    await app.register(registerAuthRoutes, { prefix: '/api' });
    await app.register(registerLobbyRoutes, { prefix: '/api' });
    await app.register(registerAIMoveRoute, { prefix: '/api' });
    await app.register(registerProgressRoutes, { prefix: '/api' });
    // WebSocket route — LB URL map already routes /ws/* to Cloud Run.
    await app.register(registerMatchWebSocket);
    return app;
}
async function main() {
    const env = loadEnv();
    const app = await buildApp();
    try {
        await app.listen({ host: env.HOST, port: env.PORT });
    }
    catch (err) {
        logger.fatal({ err }, 'listen failed');
        process.exit(1);
    }
}
const isDirectInvoke = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvoke) {
    void main();
}
export { buildApp };
