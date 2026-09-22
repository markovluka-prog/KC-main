-- Cross-device campaign progress. The API also creates this table lazily
-- (CREATE TABLE IF NOT EXISTS) on first use, so no manual migration step is
-- required — this file documents the schema for reference/consistency.

CREATE TABLE IF NOT EXISTS user_progress (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
