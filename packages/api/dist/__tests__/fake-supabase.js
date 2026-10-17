export const db = { matches: [], clock: 0 };
/** Set before an update is applied — lets a test inject a concurrent write. */
export const hooks = { beforeUpdate: null };
export function createClient(_url, _key, opts) {
    const auth = opts?.global?.headers?.Authorization ?? '';
    return {
        auth: {
            async getUser() {
                const id = auth.startsWith('Bearer ') ? auth.slice(7) : '';
                return { data: { user: id ? { id } : null } };
            },
        },
        from(table) {
            if (table !== 'matches')
                throw new Error(`unexpected table ${table}`);
            const filters = [];
            const match = (r) => filters.every(([k, v]) => r[k] === v);
            return {
                select() {
                    const q = {
                        eq(k, v) {
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
                update(patch) {
                    const q = {
                        eq(k, v) {
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
