/**
 * Server-authoritative 60s turn timer: when the current player goes idle the
 * server auto-ends their turn and broadcasts the update. Uses fake timers so
 * we don't actually wait a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armTurnTimer,
  attachSocket,
  dropMatch,
  getTurnEndsAt,
  registerMatch,
  type MatchSocket,
} from '../match/registry.js';
import { createMatch, joinMatch } from '../match/state.js';

describe('turn timer (60s auto end-turn)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function liveMatch(): { id: string } {
    const id = `tt-${Math.random().toString(36).slice(2)}`;
    const rec = createMatch(id, 123, 1);
    joinMatch(rec, 'p1', 1);
    joinMatch(rec, 'p2', 2); // in_progress
    registerMatch(rec);
    return { id };
  }

  it('auto-ends the current turn after 60s of inactivity and re-arms', () => {
    const { id } = liveMatch();
    const sent: unknown[] = [];
    const socket: MatchSocket = {
      userId: 'p1',
      player: 1,
      send: (d) => sent.push(JSON.parse(d)),
      close: () => {},
    };
    attachSocket(id, socket);

    armTurnTimer(id);
    const deadline = getTurnEndsAt(id);
    expect(deadline).toBeGreaterThan(Date.now());

    vi.advanceTimersByTime(60_000);

    const autoEnded = sent.find(
      (m) => (m as { type?: string; autoEnded?: boolean }).autoEnded === true,
    ) as { state: { currentPlayer: number } } | undefined;
    expect(autoEnded).toBeDefined();
    // Turn flipped to player 2 and a fresh deadline is set.
    expect(autoEnded!.state.currentPlayer).toBe(2);
    expect(getTurnEndsAt(id)).toBeGreaterThan(Date.now());

    dropMatch(id);
  });

  it('clears the deadline when the match is dropped', () => {
    const { id } = liveMatch();
    armTurnTimer(id);
    expect(getTurnEndsAt(id)).not.toBeNull();
    dropMatch(id);
    expect(getTurnEndsAt(id)).toBeNull();
  });
});
