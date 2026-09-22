-- Phase 4 T4.1 — realtime PvP match tables. Event-sourced: every action
-- recorded as a match_event, full state reconstructable by replay.

CREATE TYPE match_status AS ENUM ('created', 'waiting', 'in_progress', 'finished', 'aborted');

CREATE TABLE matches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status          match_status NOT NULL DEFAULT 'created',
  rules_version   INTEGER NOT NULL,
  rng_seed        BIGINT NOT NULL,
  winner          INTEGER, -- 1 or 2, null until finished
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  finished_reason TEXT
);
CREATE INDEX ix_matches_status ON matches(status);

CREATE TABLE match_participants (
  match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_index    INTEGER NOT NULL CHECK (player_index IN (1, 2)),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id),
  UNIQUE (match_id, player_index)
);
CREATE INDEX ix_match_participants_user ON match_participants(user_id);

CREATE TABLE match_events (
  match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  action          JSONB NOT NULL,
  rng_cursor_after INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE match_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id        UUID REFERENCES matches(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at    TIMESTAMPTZ
);
CREATE INDEX ix_match_invites_invitee ON match_invites(invitee_id, status);
