/**
 * Supabase-backed lobby: code-invite rooms, matchmaking queue, and rematch.
 *
 * Privileged writes (creating matches, pairing two distinct users out of the
 * queue, promoting a guest into a match) can't be done from the browser under
 * RLS, so they're delegated to the `matchmake` Edge Function (service role).
 * Authoritative match-state construction lives in the `create-match` function
 * (owned by agent A); `matchmake` calls it. This module just translates the
 * function responses into the result shapes ApiClient expects.
 *
 * Keeps the same result shapes as the old REST client so ApiClient can delegate
 * here without touching main.ts.
 */
import type {
  CreateRoomResult,
  JoinRoomResult,
  QueueResult,
  RematchResult,
  PlayerSlot,
} from '../api/client.js';
import { getSupabase } from './supabase.js';

function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function toSlot(v: unknown): PlayerSlot {
  return v === 2 ? 2 : 1;
}

export class SupabaseLobby {
  private readonly sb = getSupabase();

  private async uid(): Promise<string> {
    const { data } = await this.sb.auth.getSession();
    const id = data.session?.user.id;
    if (!id) throw new Error('Не выполнен вход.');
    return id;
  }

  /** Invoke the `matchmake` Edge Function and return its JSON payload. */
  private async callMatchmake<T>(body: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.functions.invoke('matchmake', { body });
    if (error) {
      // Surface the function's structured error if it sent one in the body.
      const ctx = (error as { context?: { error?: string } }).context;
      throw new Error(ctx?.error ?? error.message ?? 'matchmake-failed');
    }
    const payload = data as (T & { error?: string }) | null;
    if (!payload) throw new Error('matchmake-empty');
    if (payload.error) throw new Error(payload.error);
    return payload;
  }

  /** Create a code-invite room; caller becomes host (player 1). */
  async createRoom(): Promise<CreateRoomResult> {
    await this.uid();
    // Retry a couple of times on the (rare) random-code collision.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = makeRoomCode();
      try {
        const res = await this.callMatchmake<{ code: string; matchId: string; you?: number }>({
          op: 'room-create',
          code,
        });
        return { code: res.code, matchId: res.matchId, you: toSlot(res.you ?? 1) };
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && e.message === 'code-taken') continue;
        throw e;
      }
    }
    throw (lastErr instanceof Error ? lastErr : new Error('room-create-failed'));
  }

  /** Join an existing room by code; caller becomes guest (player 2). */
  async joinRoom(code: string): Promise<JoinRoomResult> {
    await this.uid();
    const res = await this.callMatchmake<{ matchId: string; you?: number; code: string }>({
      op: 'room-join',
      code,
    });
    return { matchId: res.matchId, you: toSlot(res.you ?? 2), code: res.code ?? code };
  }

  async roomStatus(code: string): Promise<{ exists: boolean; matchId?: string; status?: string }> {
    // Routed through the Edge Function (service role) so the `rooms` table needs
    // no world-readable SELECT policy — the room code stays a shared secret that
    // can't be enumerated by other authenticated clients.
    try {
      const res = await this.callMatchmake<{ exists: boolean; matchId?: string; status?: string }>({
        op: 'room-status',
        code,
      });
      return { exists: !!res.exists, matchId: res.matchId, status: res.status };
    } catch {
      return { exists: false };
    }
  }

  // ── Matchmaking ──────────────────────────────────────────────────────────
  async queue(): Promise<QueueResult> {
    await this.uid();
    const res = await this.callMatchmake<
      { paired: true; matchId: string; you?: number } | { paired: false; position: number }
    >({ op: 'queue' });
    if (res.paired) {
      return { paired: true, matchId: res.matchId, you: toSlot(res.you) };
    }
    return { paired: false, position: res.position ?? 1 };
  }

  async leaveQueue(): Promise<void> {
    const uid = await this.uid().catch(() => null);
    if (!uid) return;
    // Best-effort via the function (service role); fall back to a direct delete
    // of our own row (allowed by the `queue_own` RLS policy).
    try {
      await this.callMatchmake<{ ok: boolean }>({ op: 'leave' });
    } catch {
      await this.sb.from('matchmaking_queue').delete().eq('user_id', uid);
    }
  }

  async lobbyMe(): Promise<{
    state: 'idle' | 'queued' | 'in_match';
    matchId?: string;
    you?: PlayerSlot;
    position?: number;
    status?: string;
  }> {
    const uid = await this.uid().catch(() => null);
    if (!uid) return { state: 'idle' };

    // 1) An active (non-finished) match the caller participates in wins — this
    //    is how a queued player learns they've been paired by the opponent.
    const { data: matchRows } = await this.sb
      .from('matches')
      .select('id, player1, player2, status')
      .or(`player1.eq.${uid},player2.eq.${uid}`)
      .neq('status', 'finished')
      .neq('status', 'aborted')
      .order('updated_at', { ascending: false })
      .limit(1);
    const match = (matchRows as
      | { id: string; player1: string; player2: string | null; status: string }[]
      | null)?.[0];
    if (match) {
      const you: PlayerSlot = match.player1 === uid ? 1 : 2;
      return { state: 'in_match', matchId: match.id, you, status: match.status };
    }

    // 2) Still in the queue?
    const { data: queued } = await this.sb
      .from('matchmaking_queue')
      .select('user_id')
      .eq('user_id', uid)
      .maybeSingle();
    if (queued) return { state: 'queued' };

    return { state: 'idle' };
  }

  async rematch(matchId: string): Promise<RematchResult> {
    await this.uid();
    const res = await this.callMatchmake<
      | { ready: true; matchId: string; you?: number }
      | { ready: false; waiting: true; you?: number; matchId: null }
    >({ op: 'rematch', matchId });
    if (res.ready) {
      return { ready: true, matchId: res.matchId, you: toSlot(res.you) };
    }
    return { ready: false, waiting: true, you: toSlot(res.you), matchId: null };
  }
}
