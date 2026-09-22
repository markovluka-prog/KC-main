-- Harden `rooms` access (security review, mirrors the Vocabulary Race "code is
-- the secret" model). All legitimate room reads/writes go through the
-- `matchmake` Edge Function under the service-role key, which bypasses RLS.
-- The client never touches the table directly anymore (roomStatus is now the
-- `room-status` op), so every client-facing policy here is pure attack surface.
--
-- Removed:
--   * rooms_update_participant — the `or guest_id is null` clause let ANY
--     authenticated user UPDATE any waiting room (claim/close/hijack match_id).
--   * rooms_insert_host        — clients never insert rooms directly.
--   * rooms_select_authed      — world-readable: any signed-in user could
--     enumerate every room code (the code is meant to be a shared secret).
--
-- With RLS still enabled and no policies, the table denies all client access by
-- default — exactly like `matches`. Run in SQL Editor (or `supabase db push`).

drop policy if exists "rooms_update_participant" on public.rooms;
drop policy if exists "rooms_insert_host"        on public.rooms;
drop policy if exists "rooms_select_authed"      on public.rooms;

-- `rooms` is no longer read by any client (no SELECT policy) and no client
-- subscribes to it over Realtime — drop it from the publication to shrink the
-- surface. `matches` stays published (participants subscribe to their row).
-- Guarded so re-running the migration is idempotent (ALTER PUBLICATION ... DROP
-- TABLE has no IF EXISTS).
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'rooms'
  ) then
    execute 'alter publication supabase_realtime drop table public.rooms';
  end if;
end $$;
