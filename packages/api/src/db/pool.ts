/**
 * Phase 3 T3.4 — pg connection pool. On Cloud Run, DATABASE_URL is a
 * Unix-socket DSN to Cloud SQL Auth Proxy; locally it's a TCP URL.
 */
import pg from 'pg';
import { loadEnv } from '../env.js';

const env = loadEnv();

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === 'production' ? 10 : 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function pingDb(): Promise<boolean> {
  try {
    const res = await pool.query<{ ok: number }>('SELECT 1 as ok');
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
