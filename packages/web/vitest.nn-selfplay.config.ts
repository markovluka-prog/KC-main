import { defineConfig } from 'vitest/config';

/**
 * Separate config for the neural-net self-play data generator (see
 * scripts/nn-selfplay.ts). Mirrors vitest.bench.config.ts: this plays dozens
 * of full headless games and can run for a long time, so it must never be
 * part of `pnpm test`.
 */
export default defineConfig({
  test: {
    include: ['scripts/nn-selfplay.ts'],
    environment: 'node',
    testTimeout: 24 * 60 * 60 * 1000,
    hookTimeout: 24 * 60 * 60 * 1000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
