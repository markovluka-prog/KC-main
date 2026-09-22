import { defineConfig } from 'vitest/config';

// Coverage targets (Phase 2 T2.9): aim >80% on game-rules. The package is
// pure functions only — easy to cover. Reports written to coverage/ and
// uploaded as a CI artifact by .github/workflows/ci.yml.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        'src/index.ts',
        // types.ts is pure TS type declarations — no executable code to cover.
        'src/types.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
