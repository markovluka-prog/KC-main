import { defineConfig } from 'vitest/config';

/**
 * Separate config for the beam-vs-greedy arena (scripts/arena.js, plan step
 * 7). Plays real full games and can take a while at higher game counts, so it
 * must never run as part of `pnpm test` — the default vitest config only
 * includes `src/**\/*.test.ts`, and this one includes only the arena script.
 */
export default defineConfig({
  test: {
    include: ['scripts/arena.ts'],
    environment: 'node',
    // One long-running "test"; no parallelism and no timeout pressure.
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
