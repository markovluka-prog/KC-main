/**
 * Campaign progress sync routes (auth required). Guests (userId 'guest_*')
 * have no users row, so sync is a no-op for them. All DB failures are caught
 * and downgraded — the client always has its localStorage copy to fall back on.
 */
import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';
import { getProgress, upsertProgress } from '../db/repos/progress.js';

const progressPlugin: FastifyPluginAsync = async (app) => {
  app.get('/progress', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.userId!;
    if (userId.startsWith('guest_')) return reply.send({ data: null });
    try {
      const data = await getProgress(pool, userId);
      return reply.send({ data });
    } catch (err) {
      app.log.error({ err }, 'getProgress failed');
      return reply.send({ data: null });
    }
  });

  app.put<{ Body: { data?: unknown } }>(
    '/progress',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.userId!;
      if (userId.startsWith('guest_')) return reply.code(204).send();
      const data = req.body?.data;
      if (data == null || typeof data !== 'object') {
        return reply.code(400).send({ code: 'bad-body', message: 'data object required' });
      }
      try {
        await upsertProgress(pool, userId, data);
      } catch (err) {
        app.log.error({ err }, 'upsertProgress failed');
      }
      return reply.code(204).send();
    },
  );
};

export const registerProgressRoutes = progressPlugin;
