/**
 * In-memory stand-in for supabase-js, just enough for the match-action Edge
 * Function: auth.getUser() from the bearer token, and select/update on the
 * `matches` table with .eq() filters (the update honours every .eq(), which is
 * what makes the function's compare-and-set observable).
 */
export interface FakeRow {
  id: string;
  player1: string;
  player2: string | null;
  state: unknown;
  status: string;
  winner: number | null;
  updated_at: string;
}

export const db: { matches: FakeRow[]; clock: number } = { matches: [], clock: 0 };

/** Set before an update is applied — lets a test inject a concurrent write. */
export const hooks: { beforeUpdate: (() => void) | null } = { beforeUpdate: null };

export function createClient(_url: string, _key: string, opts?: { global?: { headers?: Record<string, string> } }) {
  const auth = opts?.global?.headers?.Authorization ?? '';
  return {
    auth: {
      async getUser() {
        const id = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        return { data: { user: id ? { id } : null } };
      },
    },
    from(table: string) {
      if (table !== 'matches') throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, unknown]> = [];
      const match = (r: FakeRow) => filters.every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
      return {
        select() {
          const q = {
            eq(k: string, v: unknown) {
              filters.push([k, v]);
              return q;
            },
            async maybeSingle() {
              const row = db.matches.find(match);
              return { data: row ? structuredClone(row) : null, error: null };
            },
          };
          return q;
        },
        update(patch: Partial<FakeRow>) {
          const q = {
            eq(k: string, v: unknown) {
              filters.push([k, v]);
              return q;
            },
            async select() {
              hooks.beforeUpdate?.();
              const rows = db.matches.filter(match);
              for (const r of rows) {
                Object.assign(r, structuredClone(patch));
                db.clock += 1;
                r.updated_at = `t${db.clock}`;
              }
              return { data: rows.map((r) => ({ id: r.id })), error: null };
            },
          };
          return q;
        },
      };
    },
  };
}
