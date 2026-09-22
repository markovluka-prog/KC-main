/**
 * Phase 4 T4.5 — match state machine.
 *
 *   created  → waiting (when player 1 joins)
 *   waiting  → in_progress (when player 2 joins)
 *   in_progress → finished (winner determined by applyAction)
 *   in_progress → aborted (disconnect grace expired, resign, anti-cheat)
 *
 * In-memory + Postgres event log. On Cloud Run restart, state is rebuilt
 * by replaying `match_events` for active matches.
 */
import {
  applyAction,
  createInitialState,
  createMatchSetup,
  type GameState,
  mulberry32,
  type Rng,
  type ServerAction,
  type ValidationError,
} from '@kc/game-rules';

export type MatchStatus = 'created' | 'waiting' | 'in_progress' | 'finished' | 'aborted';

export interface MatchRecord {
  id: string;
  status: MatchStatus;
  state: GameState;
  rng: Rng;
  /** seq counter — next match_event index. */
  nextSeq: number;
  participants: Record<1 | 2, { userId: string; joinedAt: number } | null>;
  finishedReason: string | null;
}

export function createMatch(id: string, seed: number, rulesVersion: number): MatchRecord {
  // Seed the board + map deterministically so the server is the source of truth
  // (createInitialState alone yields an empty 0-unit game → instant winner).
  const setup = createMatchSetup(seed);
  const state = createInitialState({
    mode: 'pvp',
    seed,
    units: setup.units,
    towers: setup.towers,
    ruins: setup.ruins,
    // BUGFIX: setup generates a second ruins area but it was dropped here, so
    // searching ruins2 was impossible in online matches. Forward it.
    ruins2: setup.ruins2,
    terrain: setup.terrain,
    castleP1Col: setup.castleP1Col,
    castleP2Col: setup.castleP2Col,
    // Hidden artifacts/gear buried by the seeded scatter — server-owned so both
    // peers agree on what's under every cell.
    hiddenPickups: setup.hiddenPickups,
  });
  state.rulesVersion = rulesVersion;
  return {
    id,
    status: 'created',
    state,
    rng: mulberry32(seed),
    nextSeq: 0,
    participants: { 1: null, 2: null },
    finishedReason: null,
  };
}

export function joinMatch(match: MatchRecord, userId: string, slot: 1 | 2): MatchRecord {
  if (match.participants[slot] && match.participants[slot]!.userId !== userId) {
    throw new Error(`slot ${slot} already taken`);
  }
  match.participants[slot] = { userId, joinedAt: Date.now() };
  const occupiedCount = (match.participants[1] ? 1 : 0) + (match.participants[2] ? 1 : 0);
  if (occupiedCount === 1) match.status = 'waiting';
  if (occupiedCount === 2) match.status = 'in_progress';
  return match;
}

export interface ActionDispatchResult {
  ok: boolean;
  error?: ValidationError;
  events: unknown[];
  status: MatchStatus;
}

/**
 * Phase 4 T4.7 — server-authoritative action validation. Wraps `applyAction`
 * and updates the match record on success. Anti-cheat: rejects actions when
 * the user is not the current player.
 */
export function dispatchAction(
  match: MatchRecord,
  fromUserId: string,
  action: ServerAction,
): ActionDispatchResult {
  if (match.status !== 'in_progress') {
    return {
      ok: false,
      error: { code: 'game-over', message: `match is ${match.status}` },
      events: [],
      status: match.status,
    };
  }
  // Anti-cheat baseline (T4.10): check ownership.
  const requiredPlayer = match.state.currentPlayer;
  const expectedUserId = match.participants[requiredPlayer as 1 | 2]?.userId;
  // 'end-turn' / 'resign' allow the player to act; spell/draw/equip/search
  // are tied to the unit, which is owned by the current player.
  if (action.kind !== 'resign' && expectedUserId !== fromUserId) {
    return {
      ok: false,
      error: { code: 'wrong-turn', message: 'not your turn' },
      events: [],
      status: match.status,
    };
  }
  if (action.kind === 'resign' && action.player !== requiredPlayer) {
    // Resign-as-the-other-player blocked.
    const p1 = match.participants[1]?.userId;
    const p2 = match.participants[2]?.userId;
    if (action.player === 1 && fromUserId !== p1) {
      return {
        ok: false,
        error: { code: 'wrong-turn', message: 'cannot resign for opponent' },
        events: [],
        status: match.status,
      };
    }
    if (action.player === 2 && fromUserId !== p2) {
      return {
        ok: false,
        error: { code: 'wrong-turn', message: 'cannot resign for opponent' },
        events: [],
        status: match.status,
      };
    }
  }
  const res = applyAction(match.state, action, match.rng);
  if (!res.ok) {
    return { ok: false, error: res.error, events: [], status: match.status };
  }
  match.state = res.value;
  match.nextSeq += 1;
  if (match.state.winner !== null) {
    match.status = 'finished';
    match.finishedReason = action.kind === 'resign' ? 'resign' : 'wipe';
  }
  return { ok: true, events: res.events, status: match.status };
}

export function abortMatch(match: MatchRecord, reason: string): void {
  if (match.status === 'finished' || match.status === 'aborted') return;
  match.status = 'aborted';
  match.finishedReason = reason;
}
