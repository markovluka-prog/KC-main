-- AI brain v2: rich features + SPARSE Q-table.
--
-- The Q-table moved from a fixed dense array (720 floats) to a sparse map keyed
-- on a richer 9-feature vector. `ai_brain.q` (jsonb) now holds [key, value]
-- entries instead of a number[]; `table_size` now means "number of learned
-- states" (sparse count), and a new `feature_version` column lets the client and
-- trainers reject a brain trained against a different feature layout.
--
-- Old v1 (dense, feature_version implicitly 1) brains are incompatible, so we
-- drop existing rows — the self-play worker republishes a fresh v2 brain on its
-- next upload. Safe: the brain is regenerated training state, not user data.
--
-- Run in Supabase Studio → SQL Editor (or apply via `supabase db query --linked
-- --file supabase/migrations/0005_ai_brain_sparse.sql`).

alter table public.ai_brain
  add column if not exists feature_version int not null default 1;

-- Wipe incompatible v1 brains; the worker uploads a v2 brain immediately after.
delete from public.ai_brain where feature_version < 2;

-- ai_match_log rows logged before this change reference no brain weights, only
-- raw action trajectories, so they remain replayable under the new features —
-- no need to clear them. (ai-train re-derives feature keys from the actions.)
