import { defineConfig } from 'vitest/config';

// Vitest config for @kc/web — covers the AI search module via a mock
// AIGameAPI. e2e tests live under tests/e2e/ and are run by Playwright.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**'],
    environment: 'node',
  },
});
