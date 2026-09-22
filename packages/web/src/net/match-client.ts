/**
 * Track A (A4) — thin WebSocket client for a server-authoritative online match.
 *
 * Wraps the `/ws/v1/match/:matchId?token=` socket: forwards typed server
 * frames to callbacks, sends ServerActions, and transparently reconnects with
 * exponential backoff inside the server's 30s disconnect grace window. The
 * game bridge (main.ts) owns all gameplay logic; this class only moves frames.
 */
import type { GameState, GameEvent, ServerAction } from '@kc/game-rules';

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type OnlineMatchStatus = 'created' | 'waiting' | 'in_progress' | 'finished' | 'aborted';

export interface StateUpdateMsg {
  type: 'state-update';
  state: GameState;
  events: GameEvent[];
  status: OnlineMatchStatus;
  you?: 1 | 2;
  turnEndsAt?: number | null;
}
export interface ErrorMsg {
  type: 'error';
  code: string;
  message?: string;
}
export interface AbortedMsg {
  type: 'match-aborted';
  reason: string;
  winner: 1 | 2 | null;
}
export interface RematchMsg {
  type: 'rematch';
  matchId: string;
}
export type ServerMessage = StateUpdateMsg | ErrorMsg | AbortedMsg | RematchMsg;

export interface MatchClientCallbacks {
  onStateUpdate?(msg: StateUpdateMsg): void;
  onError?(msg: ErrorMsg): void;
  onAborted?(msg: AbortedMsg): void;
  onRematch?(msg: RematchMsg): void;
  onConnChange?(state: ConnState): void;
}

export interface MatchClientOpts {
  matchId: string;
  token: string;
  callbacks: MatchClientCallbacks;
  /** Override the ws origin (e.g. "ws://localhost:8080"); defaults to the page. */
  wsBase?: string;
  /** Reconnect budget in ms; must stay under the server's 30s grace. */
  maxReconnectMs?: number;
  /** Injectable WebSocket implementation for tests. */
  WebSocketImpl?: typeof WebSocket;
}

const WS_OPEN = 1; // WebSocket.OPEN

export class MatchClient {
  private ws: WebSocket | null = null;
  private connState: ConnState = 'closed';
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectStartedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: MatchClientOpts) {
    this.WS = opts.WebSocketImpl ?? (globalThis as { WebSocket: typeof WebSocket }).WebSocket;
  }

  get state(): ConnState {
    return this.connState;
  }

  /** Open the socket (idempotent — no-op if already connecting/open). */
  connect(): void {
    if (this.ws) return;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.reconnectStartedAt = 0;
    this.open();
  }

  url(): string {
    const base = this.opts.wsBase ?? defaultWsBase();
    const { matchId, token } = this.opts;
    return `${base}/ws/v1/match/${encodeURIComponent(matchId)}?token=${encodeURIComponent(token)}`;
  }

  /** Send a server action. Returns false if the socket isn't open. */
  send(action: ServerAction): boolean {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(action));
      return true;
    }
    return false;
  }

  /** Intentional close — suppresses reconnect. */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'client-close');
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.setConn('closed');
  }

  private open(): void {
    this.setConn(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = (): void => {
      this.reconnectAttempt = 0;
      this.reconnectStartedAt = 0;
      this.setConn('open');
    };
    ws.onmessage = (ev: MessageEvent): void => this.handleMessage(ev.data);
    ws.onerror = (): void => {
      /* a close event follows; reconnect handled there */
    };
    ws.onclose = (): void => {
      this.ws = null;
      if (this.intentionalClose) {
        this.setConn('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'state-update':
        this.opts.callbacks.onStateUpdate?.(msg);
        break;
      case 'error':
        this.opts.callbacks.onError?.(msg);
        break;
      case 'match-aborted':
        this.opts.callbacks.onAborted?.(msg);
        break;
      case 'rematch':
        this.opts.callbacks.onRematch?.(msg);
        break;
      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    const maxMs = this.opts.maxReconnectMs ?? 28_000; // under the 30s server grace
    if (this.reconnectStartedAt === 0) this.reconnectStartedAt = Date.now();
    if (Date.now() - this.reconnectStartedAt >= maxMs) {
      this.setConn('closed');
      return;
    }
    this.setConn('reconnecting');
    const delay = Math.min(4000, 250 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private setConn(s: ConnState): void {
    if (this.connState === s) return;
    this.connState = s;
    this.opts.callbacks.onConnChange?.(s);
  }
}

function defaultWsBase(): string {
  const loc = (globalThis as { location?: Location }).location;
  const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc?.host ?? 'localhost';
  return `${proto}//${host}`;
}
