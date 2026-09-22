/**
 * Phase 3 — users + identities + sessions repos. Raw SQL via pg, no ORM
 * to keep the surface tight. Each repo function takes a Pool or Client
 * (Client used when inside a transaction).
 */
import type { Pool, PoolClient } from 'pg';
import crypto from 'node:crypto';

export interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  email_verified_at: Date | null;
  is_guest: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

export interface IdentityRow {
  id: string;
  user_id: string;
  provider: 'password' | 'google' | 'apple';
  provider_sub: string;
  password_hash: string | null;
  created_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  refreshed_at: Date;
  created_at: Date;
  ua: string | null;
  ip: string | null;
  revoked_at: Date | null;
}

type Db = Pool | PoolClient;

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const r = await db.query<UserRow>('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
  return r.rows[0] ?? null;
}

export async function findUserById(db: Db, id: string): Promise<UserRow | null> {
  const r = await db.query<UserRow>('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return r.rows[0] ?? null;
}

export async function createUserWithPassword(
  db: Db,
  email: string,
  passwordHash: string,
  displayName: string,
): Promise<UserRow> {
  const u = await db.query<UserRow>(
    'INSERT INTO users (display_name, email) VALUES ($1, $2) RETURNING *',
    [displayName, email],
  );
  const user = u.rows[0]!;
  await db.query(
    "INSERT INTO identities (user_id, provider, provider_sub, password_hash) VALUES ($1, 'password', $2, $3)",
    [user.id, email, passwordHash],
  );
  return user;
}

/**
 * Phase 3 T3.6 — Google OIDC: find or create a user by Google `sub` claim.
 */
export async function findOrCreateGoogleUser(
  db: Db,
  googleSub: string,
  profile: { email: string | null; displayName: string },
): Promise<UserRow> {
  const existing = await db.query<UserRow>(
    `SELECT u.* FROM users u
     INNER JOIN identities i ON i.user_id = u.id
     WHERE i.provider = 'google' AND i.provider_sub = $1
     LIMIT 1`,
    [googleSub],
  );
  if (existing.rows[0]) return existing.rows[0];
  // Create new user. Email may be null (Google account without verified email
  // — unusual but possible). We trust Google's `email_verified` claim, so if
  // we got an email it's already verified.
  const userInsert = await db.query<UserRow>(
    `INSERT INTO users (display_name, email, email_verified_at)
     VALUES ($1, $2, $3) RETURNING *`,
    [profile.displayName, profile.email, profile.email ? new Date() : null],
  );
  const user = userInsert.rows[0]!;
  await db.query(
    `INSERT INTO identities (user_id, provider, provider_sub)
     VALUES ($1, 'google', $2)`,
    [user.id, googleSub],
  );
  return user;
}

export async function findPasswordIdentity(
  db: Db,
  email: string,
): Promise<{ user: UserRow; identity: IdentityRow } | null> {
  const r = await db.query<UserRow & IdentityRow>(
    `SELECT u.id AS user_id, u.display_name, u.email, u.email_verified_at, u.is_guest,
            u.created_at, u.last_login_at,
            i.id, i.provider, i.provider_sub, i.password_hash, i.created_at AS identity_created_at
     FROM users u
     INNER JOIN identities i ON i.user_id = u.id
     WHERE i.provider = 'password' AND u.email = $1
     LIMIT 1`,
    [email],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    user: {
      id: (row as unknown as { user_id: string }).user_id,
      display_name: row.display_name,
      email: row.email,
      email_verified_at: row.email_verified_at,
      is_guest: row.is_guest,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    },
    identity: {
      id: row.id,
      user_id: (row as unknown as { user_id: string }).user_id,
      provider: row.provider,
      provider_sub: row.provider_sub,
      password_hash: row.password_hash,
      created_at: (row as unknown as { identity_created_at: Date }).identity_created_at,
    },
  };
}

export async function touchLastLogin(db: Db, userId: string): Promise<void> {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

/**
 * Phase 3 T3.9 — hash a refresh-token plaintext to bytes for the sessions
 * table. SHA-256 is fine here: tokens are 32+ random bytes, no need for
 * argon2 / bcrypt slowness for opaque random strings.
 */
export function hashRefreshToken(plain: string): Buffer {
  return crypto.createHash('sha256').update(plain).digest();
}

export interface CreateSessionOpts {
  userId: string;
  refreshToken: string; // plaintext — only the hash is stored
  expiresAt: Date;
  ua?: string | null;
  ip?: string | null;
}

export async function createSession(db: Db, opts: CreateSessionOpts): Promise<SessionRow> {
  const hash = hashRefreshToken(opts.refreshToken);
  const r = await db.query<SessionRow>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ua, ip)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [opts.userId, hash, opts.expiresAt, opts.ua ?? null, opts.ip ?? null],
  );
  return r.rows[0]!;
}

export async function findActiveSessionByToken(
  db: Db,
  refreshToken: string,
): Promise<SessionRow | null> {
  const hash = hashRefreshToken(refreshToken);
  const r = await db.query<SessionRow>(
    `SELECT * FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [hash],
  );
  return r.rows[0] ?? null;
}

export async function rotateSessionToken(
  db: Db,
  sessionId: string,
  newToken: string,
  newExpiresAt: Date,
): Promise<SessionRow | null> {
  const newHash = hashRefreshToken(newToken);
  const r = await db.query<SessionRow>(
    `UPDATE sessions
     SET token_hash = $1, refreshed_at = now(), expires_at = $2
     WHERE id = $3 AND revoked_at IS NULL
     RETURNING *`,
    [newHash, newExpiresAt, sessionId],
  );
  return r.rows[0] ?? null;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}
