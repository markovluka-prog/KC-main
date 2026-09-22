-- Phase 3 T3.3 — initial schema (NR-1).
-- Matches master-plan §8.4. ADDITIVE-ONLY after first prod migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        VARCHAR(40) NOT NULL,
  email               CITEXT UNIQUE,
  email_verified_at   TIMESTAMPTZ,
  is_guest            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ
);
CREATE INDEX ix_users_email ON users(email) WHERE email IS NOT NULL;

CREATE TYPE identity_provider AS ENUM ('password', 'google', 'apple');

CREATE TABLE identities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        identity_provider NOT NULL,
  provider_sub    TEXT NOT NULL,
  password_hash   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_sub),
  CHECK ((provider = 'password' AND password_hash IS NOT NULL)
      OR (provider <> 'password' AND password_hash IS NULL))
);
CREATE INDEX ix_identities_user ON identities(user_id);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      BYTEA NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ua              TEXT,
  ip              INET,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE email_verifications (
  token_hash      BYTEA PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ
);

CREATE TABLE password_resets (
  token_hash      BYTEA PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ
);
