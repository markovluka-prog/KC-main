/**
 * SCAFFOLD — server-authoritative online match over Supabase.
 *
 * Transport model (replaces the raw WebSocket MatchClient):
 *   - send(action)  → POST to the `match-action` Edge Function, which validates
 *                     (parseAction) + applies (applyAction) + writes the new
 *                     GameState into `public.matches` (service role).
 *   - state updates ← Realtime `postgres_changes` on that match row are mapped
 *                     into the same `state-update` frame the UI already handles.
 *
 * Keeps MatchClientCallbacks so main.ts can switch to this with minimal change.
 * TODO (realtime phase): map row→events, abort/rematch frames, reconnect, auth.
 */
import type { ServerAction, GameState } from '@kc/game-rules';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
  ConnState,
  MatchClientCallbacks,
  OnlineMatchStatus,
  StateUpdateMsg,
} from './match-client.js';
import { getSupabase } from './supabase.js';

export interface SupabaseMatchOpts {
  matchId: string;
  you?: 1 | 2;
  callbacks: MatchClientCallbacks;
  /** This client's nickname, broadcast to the opponent on the match channel. */
  myNick?: string;
  /** Called when the opponent broadcasts their nickname. */
  onPeerNick?: (player: 1 | 2, nick: string) => void;
}

interface MatchRow {
  state: GameState;
  status: OnlineMatchStatus;
  turn_ends_at: string | null;
  winner: 1 | 2 | null;
}

export class SupabaseMatchClient {
  private readonly sb = getSupabase();
  private channel: RealtimeChannel | null = null;
  private connState: ConnState = 'closed';

  constructor(private readonly opts: SupabaseMatchOpts) {}

  get state(): ConnState {
    return this.connState;
  }

  connect(): void {
    if (this.channel) return;
    this.setConn('connecting');
    const channel = this.sb
      .channel(`match:${this.opts.matchId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'matches',
          filter: `id=eq.${this.opts.matchId}`,
        },
        (payload) => this.handleRow(payload.new as MatchRow),
      )
      // Lightweight nickname exchange over the same channel (no schema change):
      // each peer announces its display name; we surface the opponent's.
      .on('broadcast', { event: 'nick' }, ({ payload }) => {
        const p = payload as { player?: 1 | 2; nick?: string } | null;
        if (p && (p.player === 1 || p.player === 2) && typeof p.nick === 'string') {
          this.opts.onPeerNick?.(p.player, p.nick);
        }
      })
      .subscribe((status) => {
        this.setConn(status === 'SUBSCRIBED' ? 'open' : 'connecting');
        // Pull the current row once subscribed so both peers render the board
        // immediately (before the first action produces an UPDATE event).
        if (status === 'SUBSCRIBED') {
          void this.fetchInitial();
          // Announce our nickname so the opponent can label us.
          if (this.opts.myNick && this.opts.you) this.sendNick(this.opts.you, this.opts.myNick);
        }
      });
    this.channel = channel;
  }

  /** Broadcast this client's nickname to the opponent on the match channel. */
  sendNick(player: 1 | 2, nick: string): void {
    if (!this.channel || !nick) return;
    void this.channel.send({ type: 'broadcast', event: 'nick', payload: { player, nick } });
  }

  private async fetchInitial(): Promise<void> {
    const { data } = await this.sb
      .from('matches')
      .select('state, status, turn_ends_at, winner')
      .eq('id', this.opts.matchId)
      .maybeSingle();
    if (data) this.handleRow(data as MatchRow);
  }

  /**
   * Re-pull the authoritative row on demand. Used by the client to roll back an
   * optimistic turn when a batch submission is rejected.
   */
  async resync(): Promise<void> {
    return this.fetchInitial();
  }

  /** Authoritative: hand a single action to the Edge Function (e.g. resign). */
  async send(action: ServerAction): Promise<boolean> {
    const { error } = await this.sb.functions.invoke('match-action', {
      body: { matchId: this.opts.matchId, action },
    });
    if (error) this.opts.callbacks.onError?.({ type: 'error', code: 'send-failed', message: String(error) });
    return !error;
  }

  /**
   * Submit a whole turn as one batch. The Edge Function applies every action in
   * order and writes the final state once, so the opponent receives a single
   * Realtime UPDATE instead of one per sub-move.
   */
  async sendBatch(actions: ServerAction[]): Promise<boolean> {
    if (actions.length === 0) return true;
    const { error } = await this.sb.functions.invoke('match-action', {
      body: { matchId: this.opts.matchId, actions },
    });
    if (error) {
      this.opts.callbacks.onError?.({ type: 'error', code: 'send-failed', message: String(error) });
    }
    return !error;
  }

  close(): void {
    if (this.channel) {
      void this.sb.removeChannel(this.channel);
      this.channel = null;
    }
    this.setConn('closed');
  }

  private handleRow(row: MatchRow): void {
    const msg: StateUpdateMsg = {
      type: 'state-update',
      state: row.state,
      events: [], // TODO: derive/transport per-action events
      status: row.status,
      you: this.opts.you,
      turnEndsAt: row.turn_ends_at ? Date.parse(row.turn_ends_at) : null,
    };
    this.opts.callbacks.onStateUpdate?.(msg);
    if (row.status === 'aborted') {
      this.opts.callbacks.onAborted?.({ type: 'match-aborted', reason: 'aborted', winner: row.winner });
    }
  }

  private setConn(s: ConnState): void {
    if (this.connState === s) return;
    this.connState = s;
    this.opts.callbacks.onConnChange?.(s);
  }
}
