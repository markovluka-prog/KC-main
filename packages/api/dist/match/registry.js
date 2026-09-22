/**
 * Phase 4 T4.5/T4.7/T4.8 — in-memory registry of live matches + WS sockets.
 *
 * Single-instance for MVP. On Cloud Run scale-out, two clients of the same
 * match might land on different revisions and lose state sync. Phase 4 R4.1
 * mitigation (Postgres LISTEN/NOTIFY) is deferred until we actually see
 * >1 instance handling matches.
 */
import { dispatchAction, abortMatch } from './state.js';
const live = new Map();
const DISCONNECT_GRACE_MS = 30_000;
/** Server-authoritative per-turn time limit. On expiry the current player's
 * turn is auto-ended so an idle/disconnected player can't stall the match. */
const TURN_LIMIT_MS = 60_000;
export function registerMatch(record) {
    if (live.has(record.id))
        return;
    live.set(record.id, {
        record,
        sockets: new Map(),
        disconnectTimers: new Map(),
        turnTimer: null,
        turnEndsAt: null,
    });
}
/** Current turn deadline (epoch ms) so clients can render a countdown. */
export function getTurnEndsAt(matchId) {
    return live.get(matchId)?.turnEndsAt ?? null;
}
function clearTurnTimer(m) {
    if (m.turnTimer)
        clearTimeout(m.turnTimer);
    m.turnTimer = null;
    m.turnEndsAt = null;
}
/**
 * (Re)start the 60s turn timer for a match. Call when a match enters
 * in_progress and after every turn change. On expiry the server auto-ends the
 * current player's turn (dropping any un-equipped crafted weapon first, since
 * a pending equip would otherwise block end-turn) and broadcasts the update.
 */
export function armTurnTimer(matchId) {
    const m = live.get(matchId);
    if (!m)
        return;
    clearTurnTimer(m);
    if (m.record.status !== 'in_progress')
        return;
    m.turnEndsAt = Date.now() + TURN_LIMIT_MS;
    m.turnTimer = setTimeout(() => {
        const cur = m.record.state.currentPlayer;
        const uid = m.record.participants[cur]?.userId;
        if (!uid)
            return;
        // A crafted-but-unequipped weapon blocks end-turn — drop it so the
        // auto-end always succeeds.
        if (m.record.state.pendingWeaponEquip)
            m.record.state.pendingWeaponEquip = null;
        const res = dispatchAction(m.record, uid, { kind: 'end-turn' });
        if (!res.ok)
            return;
        broadcast(matchId, {
            type: 'state-update',
            state: m.record.state,
            events: res.events,
            status: m.record.status,
            turnEndsAt: null,
            autoEnded: true,
        });
        if (m.record.status === 'in_progress')
            armTurnTimer(matchId);
        else
            clearTurnTimer(m);
    }, TURN_LIMIT_MS);
}
export function getMatch(id) {
    return live.get(id)?.record ?? null;
}
/**
 * Attach a WebSocket to a match. Returns false if the user is not a
 * participant or the match doesn't exist.
 */
export function attachSocket(matchId, socket) {
    const m = live.get(matchId);
    if (!m)
        return false;
    const p1 = m.record.participants[1]?.userId;
    const p2 = m.record.participants[2]?.userId;
    if (socket.userId !== p1 && socket.userId !== p2)
        return false;
    // Cancel any pending disconnect-abort timer for this user.
    const timer = m.disconnectTimers.get(socket.userId);
    if (timer) {
        clearTimeout(timer);
        m.disconnectTimers.delete(socket.userId);
    }
    // Replace any existing socket for this user (reconnect).
    const existing = m.sockets.get(socket.userId);
    if (existing)
        existing.close('replaced');
    m.sockets.set(socket.userId, socket);
    return true;
}
/**
 * Detach a socket (WS closed). Starts a 30s disconnect-grace timer; if not
 * reconnected, opponent wins (T4.9).
 */
export function detachSocket(matchId, userId) {
    const m = live.get(matchId);
    if (!m)
        return;
    const sock = m.sockets.get(userId);
    if (!sock)
        return;
    m.sockets.delete(userId);
    if (m.record.status !== 'in_progress')
        return;
    const timer = setTimeout(() => {
        abortMatch(m.record, `disconnect-${userId}`);
        clearTurnTimer(m);
        // Award win to the still-connected opponent.
        const p1 = m.record.participants[1]?.userId;
        const p2 = m.record.participants[2]?.userId;
        if (userId === p1 && p2)
            m.record.state.winner = 2;
        else if (userId === p2 && p1)
            m.record.state.winner = 1;
        broadcast(matchId, {
            type: 'match-aborted',
            reason: 'disconnect',
            winner: m.record.state.winner,
        });
        // Close any remaining sockets.
        for (const s of m.sockets.values())
            s.close('aborted');
        m.sockets.clear();
        m.disconnectTimers.delete(userId);
    }, DISCONNECT_GRACE_MS);
    m.disconnectTimers.set(userId, timer);
}
export function broadcast(matchId, msg) {
    const m = live.get(matchId);
    if (!m)
        return;
    const payload = JSON.stringify(msg);
    for (const s of m.sockets.values()) {
        try {
            s.send(payload);
        }
        catch {
            // Socket dead; cleanup happens on next 'close' event.
        }
    }
}
/**
 * Handle an action submitted by a connected client. Validates via
 * dispatchAction (which already checks ownership + turn order).
 */
export function applyClientAction(matchId, fromUserId, action) {
    const m = live.get(matchId);
    if (!m)
        return { ok: false, error: 'match-not-found' };
    const prevPlayer = m.record.state.currentPlayer;
    const res = dispatchAction(m.record, fromUserId, action);
    if (!res.ok)
        return { ok: false, error: res.error?.code };
    // Re-arm the turn timer when the turn flips (fresh 60s for the new player);
    // clear it once the match is over.
    if (m.record.status !== 'in_progress') {
        clearTurnTimer(m);
    }
    else if (m.record.state.currentPlayer !== prevPlayer) {
        armTurnTimer(matchId);
    }
    // Broadcast state-update to everyone in this match.
    broadcast(matchId, {
        type: 'state-update',
        state: m.record.state,
        events: res.events,
        status: m.record.status,
        turnEndsAt: m.turnEndsAt,
    });
    return { ok: true };
}
/** Drop match from memory (after finished/aborted, finalized in DB). */
export function dropMatch(matchId) {
    const m = live.get(matchId);
    if (!m)
        return;
    clearTurnTimer(m);
    for (const timer of m.disconnectTimers.values())
        clearTimeout(timer);
    for (const s of m.sockets.values())
        s.close('drop');
    live.delete(matchId);
}
