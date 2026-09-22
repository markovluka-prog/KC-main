/**
 * Phase 4 T4.2 — WebSocket endpoint for an active match.
 *
 * URL:  /ws/v1/match/:matchId
 * Auth: ?token=<accessJWT> query param (Bearer in WS headers is awkward
 *       in browsers — Sec-WebSocket-Protocol is the alternative but query
 *       wins for this MVP).
 *
 * Protocol:
 *   - Client → server: { kind: 'move' | 'attack' | ... } (ServerAction shape)
 *   - Server → client: { type: 'state-update', state, events, status }
 *                     | { type: 'error', code, message }
 *                     | { type: 'match-aborted', reason, winner }
 */
import type { FastifyPluginAsync } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import {
  applyClientAction,
  attachSocket,
  detachSocket,
  getMatch,
  getTurnEndsAt,
} from './registry.js';
import { parseAction } from './validator.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { loadEnv } from '../env.js';

export const registerMatchWebSocket: FastifyPluginAsync = async (app) => {
  await app.register(websocketPlugin);

  app.get<{ Params: { matchId: string }; Querystring: { token?: string } }>(
    '/ws/v1/match/:matchId',
    { websocket: true },
    async (socket, req) => {
      const env = loadEnv();
      const { matchId } = req.params as { matchId: string };
      const token = (req.query as { token?: string }).token;

      // Resolve user. dev-bypass mode (set in env.ts) lets us run a flow
      // without going through Google OIDC — uses DEV_BYPASS_USER_ID.
      let userId: string | null = null;
      if (env.AUTH_MODE === 'dev-bypass') {
        userId = env.DEV_BYPASS_USER_ID ?? null;
      } else if (token) {
        const payload = await verifyAccessToken(token);
        userId = payload?.sub ?? null;
      }
      if (!userId) {
        socket.send(JSON.stringify({ type: 'error', code: 'unauthenticated' }));
        socket.close(4401, 'unauthenticated');
        return;
      }

      const record = getMatch(matchId);
      if (!record) {
        socket.send(JSON.stringify({ type: 'error', code: 'match-not-found' }));
        socket.close(4404, 'match-not-found');
        return;
      }

      // Determine which player slot the user occupies.
      let player: 1 | 2 | null = null;
      if (record.participants[1]?.userId === userId) player = 1;
      else if (record.participants[2]?.userId === userId) player = 2;
      if (player === null) {
        socket.send(JSON.stringify({ type: 'error', code: 'not-participant' }));
        socket.close(4403, 'not-participant');
        return;
      }

      const adapter = {
        userId,
        player,
        send: (data: string): void => socket.send(data),
        close: (reason?: string): void => socket.close(1000, reason ?? 'close'),
      };
      if (!attachSocket(matchId, adapter)) {
        socket.close(4403, 'attach-failed');
        return;
      }

      // Send initial state to the connecting client.
      socket.send(
        JSON.stringify({
          type: 'state-update',
          state: record.state,
          events: [],
          status: record.status,
          you: player,
          turnEndsAt: getTurnEndsAt(matchId),
        }),
      );

      socket.on('message', (raw: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf-8'));
        } catch {
          socket.send(JSON.stringify({ type: 'error', code: 'invalid-json' }));
          return;
        }
        const action = parseAction(parsed);
        if (!action.ok) {
          socket.send(
            JSON.stringify({ type: 'error', code: 'invalid-action', message: action.error }),
          );
          return;
        }
        const result = applyClientAction(matchId, userId!, action.value);
        if (!result.ok) {
          socket.send(JSON.stringify({ type: 'error', code: result.error ?? 'invalid' }));
        }
        // On success, broadcast is handled inside applyClientAction.
      });

      socket.on('close', () => {
        detachSocket(matchId, userId!);
      });
    },
  );
};
