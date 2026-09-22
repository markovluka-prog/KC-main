-- AI Q-learning brain hosted on Supabase.
--
-- `ai_brain` stores versioned Q-tables (the learned policy). The brain is NOT
-- secret, so clients may read the latest row directly (public SELECT); all
-- writes go through service-role Edge Functions (`ai-upload`, `ai-train`) which
-- bypass RLS — there is intentionally no client INSERT/UPDATE policy, mirroring
-- the `matches`/`rooms` model in 0002/0003.
--
-- `ai_match_log` accumulates finished real matches' action trajectories so the
-- scheduled `ai-train` function can replay them into the brain. It is written
-- and read ONLY by service-role functions (no client policies at all).
--
-- Run in Supabase Studio → SQL Editor (or `supabase db push`).

-- ── AI brain (versioned Q-tables) ────────────────────────────────────────────
create table if not exists public.ai_brain (
  version    int     primary key,            -- monotonic; newest = max(version)
  q          jsonb   not null,               -- Q-table as a number[] (len = table_size)
  table_size int     not null,               -- guards against feature-layout drift
  games      bigint  not null default 0,     -- total games this brain learned from
  source     text    not null,               -- 'selfplay' | 'realgames' | 'merged'
  created_at timestamptz not null default now()
);

alter table public.ai_brain enable row level security;

-- The brain is public knowledge: any visitor (even anonymous) may read it so
-- the client AI can fetch the latest policy. Writes are service-role only.
drop policy if exists "ai_brain_select_public" on public.ai_brain;
create policy "ai_brain_select_public"
  on public.ai_brain for select
  using (true);

-- ── Real-match training log ──────────────────────────────────────────────────
-- One row per finished match. `transitions` is the action trajectory the
-- ai-train function replays: an ordered list of every ServerAction applied,
-- with the seed/cursor needed to rebuild deterministic state. `processed`
-- flips true once ai-train has folded it into a brain version.
create table if not exists public.ai_match_log (
  id          uuid primary key default gen_random_uuid(),
  match_id    uuid references public.matches (id) on delete set null,
  winner      smallint,                      -- 1 | 2 | null (draw/aborted)
  seed        bigint not null,               -- GameState.rngSeed at match start
  transitions jsonb  not null,               -- ServerAction[] in applied order
  processed   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists ai_match_log_unprocessed
  on public.ai_match_log (created_at)
  where not processed;

alter table public.ai_match_log enable row level security;
-- No client policies: RLS-enabled with zero policies denies all client access,
-- exactly like `matches`. Only service-role functions touch this table.

-- ── Action trail on matches (for training replay) ────────────────────────────
-- `match-action` appends every applied ServerAction here as the match plays,
-- so when it finishes we can copy the full trajectory into `ai_match_log` for
-- the trainer to replay deterministically. Stays server-only (no client policy
-- references it; clients only SELECT state/status/winner). Defaults to [] so the
-- append is a simple concat.
alter table public.matches
  add column if not exists action_log jsonb not null default '[]'::jsonb;
