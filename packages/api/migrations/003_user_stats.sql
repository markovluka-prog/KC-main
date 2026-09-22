-- Phase 5 T5.1 — leaderboard + achievements + per-user stats.

CREATE TABLE user_stats (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  elo             INTEGER NOT NULL DEFAULT 1200,
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  draws           INTEGER NOT NULL DEFAULT 0,
  games_played    INTEGER NOT NULL DEFAULT 0,
  last_match_at   TIMESTAMPTZ,
  -- T5.6 anti-abuse: flag set when ELO climbs >100 in 10 matches.
  suspicious      BOOLEAN NOT NULL DEFAULT FALSE,
  suspicious_reason TEXT
);
CREATE INDEX ix_user_stats_elo ON user_stats(elo DESC);

CREATE TABLE achievements (
  code            TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  icon            TEXT,
  hidden          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE user_achievements (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_code TEXT NOT NULL REFERENCES achievements(code) ON DELETE CASCADE,
  awarded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  match_id        UUID REFERENCES matches(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, achievement_code)
);
CREATE INDEX ix_user_achievements_user ON user_achievements(user_id);
