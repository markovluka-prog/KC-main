-- Online play: rooms (code invites), matchmaking queue, and authoritative matches.
-- SCAFFOLD — review RLS before production. Authoritative writes to `matches`
-- happen in the `match-action` Edge Function (service role, bypasses RLS).
-- Run in Supabase Studio → SQL Editor (or `supabase db push`).

-- ── Matches ──────────────────────────────────────────────────────────────────
create table if not exists public.matches (
  id           uuid primary key default gen_random_uuid(),
  player1      uuid not null references auth.users (id) on delete cascade,
  player2      uuid          references auth.users (id) on delete set null,
  state        jsonb not null,                  -- serialized GameState
  status       text  not null default 'created',-- created|waiting|in_progress|finished|aborted
  winner       smallint,                        -- 1 | 2 | null
  turn_ends_at timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.matches enable row level security;

-- Participants may read their match; all writes go through the Edge Function.
drop policy if exists "matches_select_participant" on public.matches;
create policy "matches_select_participant"
  on public.matches for select
  using (auth.uid() = player1 or auth.uid() = player2);

-- ── Rooms (code invites) ─────────────────────────────────────────────────────
create table if not exists public.rooms (
  code       text primary key,                  -- short shareable code
  host_id    uuid not null references auth.users (id) on delete cascade,
  guest_id   uuid          references auth.users (id) on delete set null,
  match_id   uuid          references public.matches (id) on delete set null,
  status     text not null default 'waiting',   -- waiting|ready|closed
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

-- Anyone signed in can look up a room by code (to join). TODO: tighten if codes
-- should be private to participants only.
drop policy if exists "rooms_select_authed" on public.rooms;
create policy "rooms_select_authed"
  on public.rooms for select
  using (auth.role() = 'authenticated');

drop policy if exists "rooms_insert_host" on public.rooms;
create policy "rooms_insert_host"
  on public.rooms for insert
  with check (auth.uid() = host_id);

-- Host or the joining guest may update the room (join / close).
drop policy if exists "rooms_update_participant" on public.rooms;
create policy "rooms_update_participant"
  on public.rooms for update
  using (auth.uid() = host_id or auth.uid() = guest_id or guest_id is null)
  with check (auth.uid() = host_id or auth.uid() = guest_id);

-- ── Matchmaking queue ────────────────────────────────────────────────────────
create table if not exists public.matchmaking_queue (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  enqueued_at timestamptz not null default now()
);

alter table public.matchmaking_queue enable row level security;

drop policy if exists "queue_own" on public.matchmaking_queue;
create policy "queue_own"
  on public.matchmaking_queue for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Realtime ─────────────────────────────────────────────────────────────────
-- Push match/room row changes to subscribed clients.
alter publication supabase_realtime add table public.matches;
alter publication supabase_realtime add table public.rooms;
