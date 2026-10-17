/**
 * match-action (Supabase Edge Function, Deno) — authoritative move handler.
 *
 * Flow (mirrors packages/api/src/match/state.ts `dispatchAction`):
 *   1. Authenticate the caller from the JWT.
 *   2. Load the match (service role — bypasses RLS).
 *   3. Anti-cheat: each action must come from the player whose turn it is
 *      (resign is checked against the resigning side).
 *   4. Rebuild the deterministic RNG from (rngSeed, rngCursor) ONCE and run
 *      applyAction(state, action, rng) for every action in the batch — the
 *      SAME reducer the client uses. Reusing one Rng across the batch keeps the
 *      cursor aligned with the client's optimistic seeded draws.
 *   5. Persist the FINAL state/status/winner; Realtime pushes the row to peers.
 *
 * Body (batch, preferred): { matchId, actions: ServerAction[] }
 * Body (single, legacy):   { matchId, action: ServerAction }
 *   -> { ok: true } | { error }
 *
 * The client plays an entire turn locally and submits it as one batch ending in
 * `{ kind: 'end-turn' }`; this collapses a turn into a single Realtime UPDATE so
 * the opponent sees one smooth replay instead of a per-sub-move flurry.
 *
 * Deploy: supabase functions deploy match-action
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { applyAction, type ServerAction } from '../_shared/game-rules/apply.ts';
import type { GameState } from '../_shared/game-rules/state.ts';
import type { Player } from '../_shared/game-rules/types.ts';
import { mulberry32 } from '../_shared/game-rules/rng.ts';

interface ActionBody {
  matchId: string;
  action?: ServerAction;
  actions?: ServerAction[];
}

const MAX_BATCH = 64; // generous ceiling: 3 units × moves + craft/equip + end-turn

interface MatchRow {
  id: string;
  player1: string;
  player2: string | null;
  state: GameState;
  status: string;
  winner: number | null;
  updated_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Caller identity (anon client bound to the user's JWT).
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData.user;
    if (!user) return json({ error: 'unauthenticated' }, 401);

    const body = (await req.json()) as ActionBody;
    const { matchId } = body;
    const actions: ServerAction[] = Array.isArray(body.actions)
      ? body.actions
      : body.action != null
        ? [body.action]
        : [];
    if (!matchId || actions.length === 0 || actions.length > MAX_BATCH) {
      return json({ error: 'bad-request' }, 400);
    }
    if (actions.some((a) => !a || typeof a.kind !== 'string')) {
      return json({ error: 'bad-request' }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const { data, error } = await admin
      .from('matches')
      .select('id, player1, player2, state, status, winner, updated_at')
      .eq('id', matchId)
      .maybeSingle();
    if (error || !data) return json({ error: 'match-not-found' }, 404);
    const match = data as MatchRow;

    if (match.player1 !== user.id && match.player2 !== user.id) {
      return json({ error: 'not-participant' }, 403);
    }
    if (match.status !== 'in_progress') {
      return json({ error: 'not-in-progress', status: match.status }, 409);
    }

    // Deterministic reducer — rebuild RNG aligned to the stored cursor ONCE and
    // reuse it across the whole batch so seeded draws stay in lockstep with the
    // client's optimistic play.
    let state: GameState = match.state;
    const rng = mulberry32(state.rngSeed, state.rngCursor);

    for (const action of actions) {
      // Anti-cheat: only the player whose turn it currently is may act
      // (re-checked each step; end-turn flips currentPlayer). Resign is per-side.
      const current = state.currentPlayer as Player;
      const expectedUserId = current === 1 ? match.player1 : match.player2;
      if (action.kind === 'resign') {
        const owner = action.player === 1 ? match.player1 : match.player2;
        if (owner !== user.id) return json({ error: 'cannot-resign-for-opponent' }, 403);
      } else if (expectedUserId !== user.id) {
        return json({ error: 'wrong-turn' }, 403);
      }

      const res = applyAction(state, action, rng);
      if (!res.ok) {
        // Reject the whole batch atomically — nothing is written, so the client
        // can refetch the authoritative row and roll back its optimistic turn.
        return json(
          { error: 'invalid-action', code: res.error.code, message: res.error.message },
          422,
        );
      }
      state = res.value;
    }

    let status = match.status;
    let winner = match.winner;
    if (state.winner !== null) {
      status = 'finished';
      winner = state.winner;
    }

    const { data: updated, error: upErr } = await admin
      .from('matches')
      .update({
        state,
        status,
        winner,
        updated_at: new Date().toISOString(),
      })
      .eq('id', matchId)
      // Compare-and-set: only write over the exact row this batch was applied
      // to. Two requests racing on one match used to both read the same
      // state and the later write silently discarded the earlier turn.
      .eq('updated_at', match.updated_at)
      .select('id');
    if (upErr) return json({ error: 'write-failed', message: upErr.message }, 500);
    if (!updated || updated.length === 0) return json({ error: 'stale-state' }, 409);

    return json({ ok: true });
  } catch (e) {
    return json({ error: 'internal', message: String(e) }, 500);
  }
});
