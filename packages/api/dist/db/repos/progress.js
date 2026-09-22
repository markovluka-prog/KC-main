let ensured = false;
export async function ensureProgressTable(db) {
    if (ensured)
        return;
    await db.query(`CREATE TABLE IF NOT EXISTS user_progress (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
    ensured = true;
}
export async function getProgress(db, userId) {
    await ensureProgressTable(db);
    const r = await db.query('SELECT data FROM user_progress WHERE user_id = $1', [
        userId,
    ]);
    return r.rows[0]?.data ?? null;
}
export async function upsertProgress(db, userId, data) {
    await ensureProgressTable(db);
    await db.query(`INSERT INTO user_progress (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [userId, JSON.stringify(data)]);
}
