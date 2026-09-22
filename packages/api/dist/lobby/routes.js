import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { MatchmakingQueue } from './queue.js';
import { createRoom, deleteRoom, deleteRoomByMatch, getRoom } from './rooms.js';
import { createMatch, joinMatch, abortMatch } from '../match/state.js';
import { registerMatch, getMatch, getTurnEndsAt, armTurnTimer, broadcast, dropMatch, } from '../match/registry.js';
import { RULES_VERSION } from '@kc/game-rules';
import crypto from 'node:crypto';
// In-memory state. Single Cloud Run instance for MVP (see registry.ts notes).
const queue = new MatchmakingQueue();
// userId → matchId of their active match.
const userActiveMatch = new Map();
// rematch coordination, keyed by the finished match id.
const rematchVotes = new Map();
const rematchNewMatch = new Map();
const JoinBody = z.object({ code: z.string().min(1).max(16) });
const RematchBody = z.object({ matchId: z.string().min(1).max(64) });
function newSeed() {
    return crypto.randomInt(0, 2 ** 31);
}
/** Tear down a user's stale active match (e.g. when they start something new),
 * awarding the win to the opponent and notifying them. No-op for finished
 * matches that are merely lingering in the map. */
function abandonActiveMatch(userId) {
    const matchId = userActiveMatch.get(userId);
    if (!matchId)
        return;
    const rec = getMatch(matchId);
    if (rec && (rec.status === 'waiting' || rec.status === 'in_progress')) {
        const p1 = rec.participants[1]?.userId;
        const p2 = rec.participants[2]?.userId;
        const winner = userId === p1 ? 2 : userId === p2 ? 1 : null;
        abortMatch(rec, `abandoned-${userId}`);
        if (winner)
            rec.state.winner = winner;
        broadcast(matchId, { type: 'match-aborted', reason: 'opponent-left', winner });
    }
    if (rec) {
        const p1 = rec.participants[1]?.userId;
        const p2 = rec.participants[2]?.userId;
        if (p1)
            userActiveMatch.delete(p1);
        if (p2)
            userActiveMatch.delete(p2);
    }
    else {
        userActiveMatch.delete(userId);
    }
    deleteRoomByMatch(matchId);
    dropMatch(matchId);
}
const lobbyPlugin = async (app) => {
    // ---- Room code: create ----------------------------------------------------
    app.post('/lobby/room', { preHandler: requireAuth }, async (req, _reply) => {
        const userId = req.userId;
        // Starting a fresh room means abandoning anything we were in before.
        abandonActiveMatch(userId);
        const matchId = crypto.randomUUID();
        const record = createMatch(matchId, newSeed(), RULES_VERSION);
        joinMatch(record, userId, 1); // status → 'waiting'
        registerMatch(record);
        userActiveMatch.set(userId, matchId);
        const room = createRoom(userId, matchId);
        return { code: room.code, matchId, you: 1 };
    });
    // ---- Room code: join ------------------------------------------------------
    app.post('/lobby/room/join', { preHandler: requireAuth }, async (req, reply) => {
        const userId = req.userId;
        const parsed = JoinBody.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ code: 'invalid-body' });
        const room = getRoom(parsed.data.code);
        if (!room)
            return reply.code(404).send({ code: 'room-not-found' });
        const rec = getMatch(room.matchId);
        if (!rec) {
            deleteRoom(room.code);
            return reply.code(404).send({ code: 'match-not-found' });
        }
        // Host re-opening their own room: just hand back their slot + code.
        if (room.hostUserId === userId) {
            return { matchId: room.matchId, you: 1, code: room.code };
        }
        if (rec.participants[2] && rec.participants[2].userId !== userId) {
            return reply.code(409).send({ code: 'room-full' });
        }
        // Leave whatever the joiner was previously in, then join this room.
        abandonActiveMatch(userId);
        joinMatch(rec, userId, 2); // status → 'in_progress'
        userActiveMatch.set(userId, room.matchId);
        armTurnTimer(room.matchId);
        // Tell the waiting host (and anyone attached) the match has started.
        broadcast(room.matchId, {
            type: 'state-update',
            state: rec.state,
            events: [],
            status: rec.status,
            turnEndsAt: getTurnEndsAt(room.matchId),
        });
        deleteRoom(room.code); // consumed — no third player
        return { matchId: room.matchId, you: 2, code: room.code };
    });
    // ---- Room code: status ----------------------------------------------------
    app.get('/lobby/room/:code', { preHandler: requireAuth }, async (req) => {
        const { code } = req.params;
        const room = getRoom(code);
        if (!room)
            return { exists: false };
        const rec = getMatch(room.matchId);
        return { exists: true, matchId: room.matchId, status: rec?.status ?? 'unknown' };
    });
    // ---- Matchmaking queue ----------------------------------------------------
    app.post('/lobby/queue', { preHandler: requireAuth }, async (req, _reply) => {
        const userId = req.userId;
        const existing = userActiveMatch.get(userId);
        if (existing) {
            const rec = getMatch(existing);
            if (rec && (rec.status === 'waiting' || rec.status === 'in_progress')) {
                const you = rec.participants[1]?.userId === userId ? 1 : 2;
                return { paired: true, matchId: existing, you };
            }
            userActiveMatch.delete(userId);
        }
        const result = queue.enqueue(userId);
        if (!result.paired) {
            return { paired: false, position: result.position };
        }
        const [u1, u2] = result.paired;
        const matchId = crypto.randomUUID();
        const record = createMatch(matchId, newSeed(), RULES_VERSION);
        joinMatch(record, u1, 1);
        joinMatch(record, u2, 2);
        registerMatch(record);
        userActiveMatch.set(u1, matchId);
        userActiveMatch.set(u2, matchId);
        armTurnTimer(matchId);
        const you = userId === u1 ? 1 : 2;
        return { paired: true, matchId, you };
    });
    app.post('/lobby/leave', { preHandler: requireAuth }, async (req, reply) => {
        const userId = req.userId;
        const removed = queue.leave(userId);
        if (!removed)
            return reply.code(404).send({ code: 'not-queued' });
        return { ok: true };
    });
    // ---- Rematch (both players must opt in) -----------------------------------
    app.post('/lobby/rematch', { preHandler: requireAuth }, async (req, reply) => {
        const userId = req.userId;
        const parsed = RematchBody.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ code: 'invalid-body' });
        const oldId = parsed.data.matchId;
        const old = getMatch(oldId);
        if (!old)
            return reply.code(404).send({ code: 'match-not-found' });
        const p1 = old.participants[1]?.userId;
        const p2 = old.participants[2]?.userId;
        if (!p1 || !p2 || (userId !== p1 && userId !== p2)) {
            return reply.code(403).send({ code: 'not-participant' });
        }
        if (old.status !== 'finished' && old.status !== 'aborted') {
            return reply.code(409).send({ code: 'not-finished' });
        }
        const you = userId === p1 ? 1 : 2;
        // Already created (the other player got here first).
        const existingNew = rematchNewMatch.get(oldId);
        if (existingNew)
            return { matchId: existingNew, you, ready: true };
        let votes = rematchVotes.get(oldId);
        if (!votes) {
            votes = new Set();
            rematchVotes.set(oldId, votes);
        }
        votes.add(userId);
        if (!(votes.has(p1) && votes.has(p2))) {
            return { matchId: null, you, ready: false, waiting: true };
        }
        // Both opted in → spin up a fresh match with the same slots.
        const newId = crypto.randomUUID();
        const rec = createMatch(newId, newSeed(), RULES_VERSION);
        joinMatch(rec, p1, 1);
        joinMatch(rec, p2, 2); // in_progress
        registerMatch(rec);
        userActiveMatch.set(p1, newId);
        userActiveMatch.set(p2, newId);
        rematchNewMatch.set(oldId, newId);
        rematchVotes.delete(oldId);
        armTurnTimer(newId);
        // Notify both clients (still attached to the old match socket).
        broadcast(oldId, { type: 'rematch', matchId: newId });
        return { matchId: newId, you, ready: true };
    });
    // ---- Status ---------------------------------------------------------------
    app.get('/lobby/me', { preHandler: requireAuth }, async (req) => {
        const userId = req.userId;
        const active = userActiveMatch.get(userId);
        if (active) {
            const rec = getMatch(active);
            const you = rec?.participants[1]?.userId === userId ? 1 : 2;
            return { state: 'in_match', matchId: active, you, status: rec?.status ?? 'unknown' };
        }
        const entries = queue.snapshot();
        const idx = entries.findIndex((e) => e.userId === userId);
        if (idx === -1)
            return { state: 'idle' };
        return { state: 'queued', position: idx + 1 };
    });
};
export const registerLobbyRoutes = lobbyPlugin;
export const _userActiveMatch = userActiveMatch; // Exposed for cleanup hooks.
