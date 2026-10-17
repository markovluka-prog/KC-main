import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// Phase 3 T3.20 — backend tests. Pure-logic suites (ELO, validators,
// matchmaking, state machine) run in Node with no DB. Postgres-backed
// integration tests live under tests/ and require a dockerised PG to
// be running (out of scope for this skeleton).
export default defineConfig({
  resolve: {
    // The Supabase Edge Functions import supabase-js from esm.sh (Deno).
    // Under Node tests that URL is swapped for an in-memory fake so the real
    // function code can run — see src/__tests__/supabase-match-action.test.ts.
    alias: [
      {
        find: 'https://esm.sh/@supabase/supabase-js@2',
        replacement: fileURLToPath(new URL('./src/__tests__/fake-supabase.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**'],
    environment: 'node',
  },
});
