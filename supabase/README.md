# Supabase backend (scaffold)

Online features for Knights & Castles. The desktop app (SwiftHTMLRunner) serves
the web build from `kcapp://app` and proxies `/api/*` to the **local** game AI
backend — the AI does **not** go through Supabase.

## Layout
- `migrations/0001_progress.sql` — cross-device campaign progress (+ RLS). **Ready.**
- `migrations/0002_online.sql` — `rooms`, `matchmaking_queue`, `matches` (+ RLS, Realtime). **Scaffold.**
- `functions/match-action/` — authoritative move handler (validate + applyAction + write state). **Scaffold (TODO: vendor @kc/game-rules).**
- `functions/_shared/cors.ts` — shared CORS headers.

## Client wiring
- `packages/web/src/net/supabase.ts` — shared client (URL/anon key from `.env`).
- `packages/web/src/api/client.ts` — auth + progress (live); lobby delegates to…
- `packages/web/src/net/lobby.ts` — rooms (live), queue/rematch (TODO).
- `packages/web/src/net/supabase-match-client.ts` — realtime match transport (scaffold).

## Apply
```bash
# SQL: paste migrations into Studio → SQL Editor, or:
supabase db push
# Functions:
supabase functions deploy match-action
supabase secrets set OLLAMA_BASE_URL=...   # only if a function ever needs it
```

## Dashboard toggles still needed
- Authentication → Providers: enable **Anonymous**; configure **Google**.
- Authentication → Email: decide on email confirmation (off = simpler desktop UX).
