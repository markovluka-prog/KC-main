/**
 * Cross-device campaign progress store. Single JSONB blob per user — the
 * client owns the shape ({ chapters: [{ games: [{ tasks: boolean[] }] }] }),
 * the server just persists and returns it.
 *
 * The table is created lazily on first use so the feature deploys without a
 * manual migration step (this repo runs `CREATE TABLE IF NOT EXISTS` once).
 */
import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

let ensured = false;

export async function ensureProgressTable(db: Db): Promise<void> {
  if (ensured) return;
  await db.query(`CREATE TABLE IF NOT EXISTS user_progress (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  ensured = true;
}

export async function getProgress(db: Db, userId: string): Promise<unknown | null> {
  await ensureProgressTable(db);
  const r = await db.query<{ data: unknown }>('SELECT data FROM user_progress WHERE user_id = $1', [
    userId,
  ]);
  return r.rows[0]?.data ?? null;
}

export async function upsertProgress(db: Db, userId: string, data: unknown): Promise<void> {
  await ensureProgressTable(db);
  await db.query(
    `INSERT INTO user_progress (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, JSON.stringify(data)],
  );
}
