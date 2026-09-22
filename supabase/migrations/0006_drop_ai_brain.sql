-- Remove the AI Q-learning brain infrastructure (added in 0004/0005).
--
-- The tabular Q-brain never actually learned (≈90% self-play draws, flat
-- win-rate over 219k games), so it was replaced in the client by a phase/goal
-- strategy planner (see packages/web/src/game/ai.ts). This migration drops the
-- server-side brain entirely: the `ai_brain` / `ai_match_log` tables and the
-- `matches.action_log` trajectory column that fed the trainer.
--
-- Online play (matchmake / create-match / match-action) is unaffected: it never
-- read these for gameplay, only appended training data, and match-action has
-- been updated in the same change to stop touching them.
--
-- The ai-brain / ai-upload / ai-train Edge Functions are deleted separately
-- (`supabase functions delete ...`); nothing else references these objects.

-- Drop the training log first (it references matches via FK).
drop table if exists public.ai_match_log;

-- Drop the versioned brain table.
drop table if exists public.ai_brain;

-- Drop the per-match action trail that only existed to feed the trainer.
alter table public.matches
  drop column if exists action_log;
