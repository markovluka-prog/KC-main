import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MatchClient,
  type ConnState,
  type MatchClientOpts,
  type ServerMessage,
} from '../match-client.js';

/** Minimal WebSocket stand-in the MatchClient can drive in tests. */
class MockWS {
  static OPEN = 1;
  static instances: MockWS[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  // test helpers
  _open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  _msg(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  _serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function makeClient(over: Partial<MatchClientOpts> = {}) {
  const updates: ServerMessage[] = [];
  const conns: ConnState[] = [];
  const client = new MatchClient({
    matchId: 'm1',
    token: 'tok',
    wsBase: 'ws://test',
    WebSocketImpl: MockWS as unknown as typeof WebSocket,
    callbacks: {
      onStateUpdate: (m) => updates.push(m),
      onConnChange: (s) => conns.push(s),
    },
    ...over,
  });
  return { client, updates, conns };
}

beforeEach(() => {
  MockWS.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MatchClient', () => {
  it('builds the correct ws URL with token query', () => {
    const { client } = makeClient();
    expect(client.url()).toBe('ws://test/ws/v1/match/m1?token=tok');
  });

  it('emits connecting → open and routes state-update frames', () => {
    const { client, updates, conns } = makeClient();
    client.connect();
    expect(conns).toContain('connecting');
    const sock = MockWS.instances[0]!;
    sock._open();
    expect(conns).toContain('open');
    sock._msg({
      type: 'state-update',
      state: {},
      events: [],
      status: 'in_progress',
      you: 2,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.type).toBe('state-update');
    expect((updates[0] as { you?: number }).you).toBe(2);
  });

  it('only sends when the socket is open', () => {
    const { client } = makeClient();
    client.connect();
    const sock = MockWS.instances[0]!;
    // Not open yet → refused.
    expect(client.send({ kind: 'end-turn' })).toBe(false);
    sock._open();
    expect(client.send({ kind: 'end-turn' })).toBe(true);
    expect(JSON.parse(sock.sent[0]!)).toEqual({ kind: 'end-turn' });
  });

  it('reconnects with backoff after an unexpected close', () => {
    vi.useFakeTimers();
    const { client, conns } = makeClient();
    client.connect();
    MockWS.instances[0]!._open();
    MockWS.instances[0]!._serverClose();
    expect(conns).toContain('reconnecting');
    expect(MockWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(300); // first backoff is 250ms
    expect(MockWS.instances).toHaveLength(2);
  });

  it('does not reconnect after an intentional close', () => {
    vi.useFakeTimers();
    const { client, conns } = makeClient();
    client.connect();
    MockWS.instances[0]!._open();
    client.close();
    expect(conns[conns.length - 1]).toBe('closed');
    vi.advanceTimersByTime(5000);
    expect(MockWS.instances).toHaveLength(1);
  });
});
