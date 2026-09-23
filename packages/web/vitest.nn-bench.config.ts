import { defineConfig } from 'vitest/config';

/** Separate config for the neural-net A/B bench (see scripts/nn-bench.ts).
 *  Mirrors vitest.bench.config.ts — must never run as part of `pnpm test`. */
export default defineConfig({
  test: {
    include: ['scripts/nn-bench.ts'],
    environment: 'node',
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
