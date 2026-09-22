/**
 * Authoritative matchmaking + rematch (Supabase Edge Function, Deno).
 *
 * The browser client (packages/web/src/net/lobby.ts) invokes this with a JSON
 * body `{ op: 'queue' | 'rematch' | 'leave', matchId? }`. All writes that the
 * RLS policies forbid from the client (creating matches, pairing two distinct
 * users out of the queue) happen here under the service-role key.
 *
 *   op:'queue'    → add the caller to `matchmaking_queue`; if another player is
 *                   already waiting, atomically pair them: create a match
 *                   (delegated to the `create-match` function, owned by agent A),
 *                   clear both queue rows, and return the pairing. Otherwise
 *                   return the caller's 1-based queue position.
 *   op:'leave'    → remove the caller from the queue.
 *   op:'rematch'  → record a rematch vote for `matchId`. The first voter parks a
 *                   rematch "room"; the second voter (the other participant of
 *                   the finished match) consumes it and a fresh match is created
 *                   for the same two players.
 *
 * Match creation is delegated to the `create-match` Edge Function so the server
 * reducer (`createInitialState`) stays in one place (agent A owns it):
 *   POST create-match { player1, player2 } -> { matchId }
 *
 * Deploy: `supabase functions deploy matchmake`
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { createMatchSetup } from '../_shared/game-rules/setup.ts';
import { createInitialState } from '../_shared/game-rules/apply.ts';

type Op = 'queue' | 'leave' | 'rematch' | 'room-create' | 'room-join' | 'room-status';

interface Body {
  op?: Op;
  matchId?: string;
  /** room-create: the host-generated room code. room-join: the code to join. */
  code?: string;
}

interface QueueRow {
  user_id: string;
  enqueued_at: string;
}

/** Deterministic rematch-room code for a finished match (shared by both peers). */
const rematchCode = (matchId: string): string => `RM-${matchId}`;

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

    // Identify the caller from their JWT (anon client bound to the bearer token).
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData.user;
    if (!user) return json({ error: 'unauthenticated' }, 401);
    const me = user.id;

    // Service-role client: bypasses RLS for the privileged matchmaking writes.
    const admin = createClient(supabaseUrl, serviceKey);

    const body = ((await req.json().catch(() => ({}))) ?? {}) as Body;
    const op: Op = body.op ?? 'queue';

    if (op === 'leave') {
      await admin.from('matchmaking_queue').delete().eq('user_id', me);
      return json({ ok: true });
    }

    if (op === 'rematch') {
      return await handleRematch(admin, supabaseUrl, serviceKey, authHeader, me, body.matchId);
    }

    if (op === 'room-create') {
      return await handleRoomCreate(admin, supabaseUrl, serviceKey, me, body.code);
    }

    if (op === 'room-join') {
      return await handleRoomJoin(admin, me, body.code);
    }

    if (op === 'room-status') {
      return await handleRoomStatus(admin, body.code);
    }

    // op === 'queue'
    return await handleQueue(admin, supabaseUrl, serviceKey, authHeader, me);
  } catch (e) {
    return json({ error: 'internal', message: String(e) }, 500);
  }
});

/**
 * Create a fresh deterministic match row directly via the service-role admin
 * client. Match-state construction is done in-process with the vendored
 * game-rules — no extra function-to-function HTTP hop (which the gateway rejects
 * for service-key callers). player1 === player2 is a room-host placeholder that
 * starts 'waiting' until the guest is promoted on room-join.
 */
async function createMatch(
  admin: SupabaseClient,
  player1: string,
  player2: string,
): Promise<string> {
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const setup = createMatchSetup(seed);
  const state = createInitialState({
    mode: 'pvp',
    seed,
    units: setup.units,
    towers: setup.towers,
    ruins: setup.ruins,
    ruins2: setup.ruins2, // BUGFIX: was omitted → online matches lost the 2nd ruins
    terrain: setup.terrain,
    castleP1Col: setup.castleP1Col,
    castleP2Col: setup.castleP2Col,
    hiddenPickups: setup.hiddenPickups, // buried artifacts/gear (seeded scatter)
  });
  const status = player1 === player2 ? 'waiting' : 'in_progress';
  const { data, error } = await admin
    .from('matches')
    .insert({ player1, player2, state, status })
    .select('id')
    .single();
  if (error || !data) throw new Error(`match insert failed: ${error?.message ?? 'unknown'}`);
  return (data as { id: string }).id;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/** Pair the caller with a waiting opponent, or enqueue and report position. */
async function handleQueue(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceKey: string,
  _authHeader: string,
  me: string,
): Promise<Response> {
  // Ensure we're in the queue (idempotent — primary key is user_id).
  await admin
    .from('matchmaking_queue')
    .upsert({ user_id: me, enqueued_at: new Date().toISOString() }, { onConflict: 'user_id' });

  // Look for the oldest *other* waiting player.
  const { data: waiting, error: qErr } = await admin
    .from('matchmaking_queue')
    .select('user_id, enqueued_at')
    .neq('user_id', me)
    .order('enqueued_at', { ascending: true })
    .limit(1);
  if (qErr) return jsonResponse({ error: 'queue-read-failed', message: qErr.message }, 500);

  const opponent = (waiting as QueueRow[] | null)?.[0];
  if (opponent) {
    // Atomically claim BOTH rows. If another invocation already grabbed either
    // row, our delete affects <2 rows → we bail and fall back to "still queued".
    const { data: claimed, error: delErr } = await admin
      .from('matchmaking_queue')
      .delete()
      .in('user_id', [me, opponent.user_id])
      .select('user_id');
    if (delErr) return jsonResponse({ error: 'pair-failed', message: delErr.message }, 500);

    const claimedIds = (claimed as { user_id: string }[] | null) ?? [];
    const haveBoth =
      claimedIds.some((r) => r.user_id === me) &&
      claimedIds.some((r) => r.user_id === opponent.user_id);

    if (haveBoth) {
      // The earlier-enqueued opponent becomes player 1; the caller is player 2.
      const player1 = opponent.user_id;
      const player2 = me;
      const matchId = await createMatch(admin, player1, player2);
      const you = me === player1 ? 1 : 2;
      return jsonResponse({ paired: true, matchId, you });
    }

    // Lost the race: re-enqueue ourselves if we got deleted, then report queued.
    if (claimedIds.some((r) => r.user_id === me)) {
      await admin
        .from('matchmaking_queue')
        .upsert({ user_id: me, enqueued_at: new Date().toISOString() }, { onConflict: 'user_id' });
    }
  }

  // Not paired (yet) — report a 1-based position by enqueue order.
  const position = await queuePosition(admin, me);
  return jsonResponse({ paired: false, position });
}

/** 1-based position of `me` in the queue ordered by enqueue time. */
async function queuePosition(admin: SupabaseClient, me: string): Promise<number> {
  const { data } = await admin
    .from('matchmaking_queue')
    .select('user_id')
    .order('enqueued_at', { ascending: true });
  const rows = (data as { user_id: string }[] | null) ?? [];
  const idx = rows.findIndex((r) => r.user_id === me);
  return idx >= 0 ? idx + 1 : 1;
}

/**
 * Rematch vote. Both participants of `matchId` may vote. The first vote parks a
 * deterministic rematch room (code `RM-<matchId>`); the second vote consumes it
 * and a fresh match for the same pair is created. The result mirrors the queue:
 *   { ready:false, waiting:true }  — first voter, still waiting
 *   { ready:true,  matchId, you }  — pair complete
 */
async function handleRematch(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceKey: string,
  _authHeader: string,
  me: string,
  matchId?: string,
): Promise<Response> {
  if (!matchId) return jsonResponse({ error: 'bad-request', message: 'matchId required' }, 400);

  // Authorise: caller must have been a participant of the finished match.
  const { data: prev, error: mErr } = await admin
    .from('matches')
    .select('id, player1, player2')
    .eq('id', matchId)
    .maybeSingle();
  if (mErr || !prev) return jsonResponse({ error: 'match-not-found' }, 404);
  const match = prev as { player1: string; player2: string | null };
  if (match.player1 !== me && match.player2 !== me) {
    return jsonResponse({ error: 'not-participant' }, 403);
  }

  const code = rematchCode(matchId);

  // Has the other player already parked a rematch room for this match?
  const { data: roomData } = await admin
    .from('rooms')
    .select('code, host_id, guest_id, match_id, status')
    .eq('code', code)
    .maybeSingle();
  const room = roomData as
    | { host_id: string; guest_id: string | null; match_id: string | null; status: string }
    | null;

  if (room && room.host_id !== me) {
    // We're the second voter → finalise the rematch.
    if (room.match_id) {
      // Already created (e.g. duplicate second vote) — just report it.
      const you = matchPlayerSlot(match, me, room);
      return jsonResponse({ ready: true, matchId: room.match_id, you });
    }
    // Preserve the original side assignment so the rematch feels symmetric:
    // whoever was player1 before stays player1.
    const player1 = match.player1 ?? room.host_id;
    const player2 = match.player2 ?? me;
    const newMatchId = await createMatch(admin, player1, player2);
    await admin
      .from('rooms')
      .update({ guest_id: me, match_id: newMatchId, status: 'ready' })
      .eq('code', code);
    const you = me === player1 ? 1 : 2;
    return jsonResponse({ ready: true, matchId: newMatchId, you });
  }

  if (room && room.host_id === me) {
    // We already voted; nothing new yet. If somehow finalised, report it.
    if (room.match_id) {
      const you = me === match.player1 ? 1 : 2;
      return jsonResponse({ ready: true, matchId: room.match_id, you });
    }
    const you = me === match.player1 ? 1 : 2;
    return jsonResponse({ ready: false, waiting: true, you, matchId: null });
  }

  // First voter → park the rematch room.
  await admin
    .from('rooms')
    .upsert(
      { code, host_id: me, status: 'waiting', match_id: null, guest_id: null },
      { onConflict: 'code' },
    );
  const you = me === match.player1 ? 1 : 2;
  return jsonResponse({ ready: false, waiting: true, you, matchId: null });
}

function matchPlayerSlot(
  match: { player1: string; player2: string | null },
  me: string,
  room: { host_id: string },
): 1 | 2 {
  const player1 = match.player1 ?? room.host_id;
  return me === player1 ? 1 : 2;
}

/**
 * Code-invite room creation. The match is created up front (player1 = host,
 * player2 = host as a placeholder) so the host has a stable matchId to subscribe
 * to immediately — main.ts calls startOnlineMatch once and never re-fetches the
 * id. The guest's slot is filled in on `room-join`. Returns { code, matchId }.
 */
async function handleRoomCreate(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceKey: string,
  me: string,
  code?: string,
): Promise<Response> {
  if (!code) return jsonResponse({ error: 'bad-request', message: 'code required' }, 400);

  // Reject a code collision with an existing open room.
  const { data: existing } = await admin
    .from('rooms')
    .select('code')
    .eq('code', code)
    .maybeSingle();
  if (existing) return jsonResponse({ error: 'code-taken' }, 409);

  const matchId = await createMatch(admin, me, me);
  const { error } = await admin
    .from('rooms')
    .insert({ code, host_id: me, match_id: matchId, status: 'waiting' });
  if (error) return jsonResponse({ error: 'room-create-failed', message: error.message }, 500);

  return jsonResponse({ code, matchId, you: 1 });
}

/**
 * Join a code-invite room as the guest (player 2). Claims the open room and sets
 * the match's player2 to the guest (service role — matches has no client UPDATE
 * policy) so the guest can read the row via RLS / Realtime. Returns { matchId }.
 */
async function handleRoomJoin(
  admin: SupabaseClient,
  me: string,
  code?: string,
): Promise<Response> {
  if (!code) return jsonResponse({ error: 'bad-request', message: 'code required' }, 400);

  const { data: roomData } = await admin
    .from('rooms')
    .select('code, host_id, guest_id, match_id, status')
    .eq('code', code)
    .maybeSingle();
  const room = roomData as
    | { host_id: string; guest_id: string | null; match_id: string | null; status: string }
    | null;
  if (!room || !room.match_id) return jsonResponse({ error: 'room-not-found' }, 404);

  // Idempotent re-join by the same guest.
  if (room.guest_id && room.guest_id === me) {
    return jsonResponse({ matchId: room.match_id, you: 2, code });
  }
  if (room.guest_id && room.guest_id !== me) return jsonResponse({ error: 'room-full' }, 409);
  if (room.host_id === me) return jsonResponse({ error: 'own-room' }, 409);

  // Atomically claim the open guest slot.
  const { data: claimed, error: claimErr } = await admin
    .from('rooms')
    .update({ guest_id: me, status: 'ready' })
    .eq('code', code)
    .is('guest_id', null)
    .select('code')
    .maybeSingle();
  if (claimErr) return jsonResponse({ error: 'join-failed', message: claimErr.message }, 500);
  if (!claimed) return jsonResponse({ error: 'room-full' }, 409);

  // Promote the guest into the match (and start it) so RLS lets them read it.
  const { error: upErr } = await admin
    .from('matches')
    .update({ player2: me, status: 'in_progress' })
    .eq('id', room.match_id);
  if (upErr) return jsonResponse({ error: 'match-update-failed', message: upErr.message }, 500);

  return jsonResponse({ matchId: room.match_id, you: 2, code });
}

/**
 * Read a room's status by code, server-side (service role). The host polls this
 * to learn when a guest has joined. Routed through the function so the `rooms`
 * table needs NO client-facing SELECT policy — otherwise any authenticated user
 * could enumerate every room code (the code is meant to be the shared secret).
 */
async function handleRoomStatus(admin: SupabaseClient, code?: string): Promise<Response> {
  if (!code) return jsonResponse({ error: 'bad-request', message: 'code required' }, 400);
  const { data } = await admin
    .from('rooms')
    .select('match_id, status')
    .eq('code', code)
    .maybeSingle();
  const row = data as { match_id?: string; status?: string } | null;
  if (!row) return jsonResponse({ exists: false });
  return jsonResponse({ exists: true, matchId: row.match_id, status: row.status });
}
