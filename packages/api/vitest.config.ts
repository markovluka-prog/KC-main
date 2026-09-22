import { defineConfig } from 'vitest/config';

// Phase 3 T3.20 — backend tests. Pure-logic suites (ELO, validators,
// matchmaking, state machine) run in Node with no DB. Postgres-backed
// integration tests live under tests/ and require a dockerised PG to
// be running (out of scope for this skeleton).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**'],
    environment: 'node',
  },
});
