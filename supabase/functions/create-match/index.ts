/**
 * create-match (Supabase Edge Function, Deno) — internal.
 *
 * Builds a fresh, deterministic match (seeded board roster + map) and inserts a
 * `matches` row. Invoked server-to-server by the `matchmake` function under the
 * service-role key (clients never call it directly — they go through matchmake).
 *
 * Body: { player1: uuid, player2: uuid, seed?: number } -> { matchId }
 * If player1 === player2 (a room host placeholder), the match starts 'waiting'
 * until the guest is promoted on room-join; otherwise 'in_progress'.
 *
 * Mirrors packages/api/src/match/state.ts `createMatch`. Deploy:
 *   supabase functions deploy create-match
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { createMatchSetup } from '../_shared/game-rules/setup.ts';
import { createInitialState } from '../_shared/game-rules/apply.ts';

interface Body {
  player1?: string;
  player2?: string;
  seed?: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Internal-only: require the service-role key (matchmake calls us with it).
    if (req.headers.get('Authorization') !== `Bearer ${serviceKey}`) {
      return json({ error: 'forbidden' }, 403);
    }

    const { player1, player2, seed } = (await req.json().catch(() => ({}))) as Body;
    if (!player1 || !player2) return json({ error: 'bad-request', message: 'player1/player2 required' }, 400);

    const s = typeof seed === 'number' ? seed : Math.floor(Math.random() * 0xffffffff) >>> 0;
    const setup = createMatchSetup(s);
    const state = createInitialState({
      mode: 'pvp',
      seed: s,
      units: setup.units,
      towers: setup.towers,
      ruins: setup.ruins,
      ruins2: setup.ruins2,
      terrain: setup.terrain,
      castleP1Col: setup.castleP1Col,
      castleP2Col: setup.castleP2Col,
      hiddenPickups: setup.hiddenPickups, // buried artifacts/gear (seeded scatter)
    });

    const status = player1 === player2 ? 'waiting' : 'in_progress';
    const admin = createClient(supabaseUrl, serviceKey);
    const { data, error } = await admin
      .from('matches')
      .insert({ player1, player2, state, status })
      .select('id')
      .single();
    if (error || !data) return json({ error: 'insert-failed', message: error?.message }, 500);

    return json({ matchId: (data as { id: string }).id });
  } catch (e) {
    return json({ error: 'internal', message: String(e) }, 500);
  }
});
