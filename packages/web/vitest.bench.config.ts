import { defineConfig } from 'vitest/config';

/**
 * Separate config for the AI strength bench. The bench plays real games and
 * takes minutes, so it must never run as part of `pnpm test` — the default
 * config excludes scripts/, and this one includes only the bench.
 */
export default defineConfig({
  test: {
    include: ['scripts/ai-bench.ts'],
    environment: 'node',
    // One long-running "test"; no parallelism and no timeout pressure.
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
