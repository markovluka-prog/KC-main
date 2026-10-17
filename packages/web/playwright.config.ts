import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for @kc/web e2e smoke tests.
 *
 * Strategy: spin up Vite dev-server before running tests, hit it with
 * Chromium-only by default. Firefox/WebKit can be enabled in CI when
 * needed — keeping the local matrix small for now.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    // The UI picks its language from navigator.language; the specs assert the
    // Russian UI, so pin it instead of inheriting the host's (often en-US).
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
      },
      // Only run the mobile-specific suite; smoke/verify tests are desktop-first.
      testMatch: '**/mobile-ui.spec.ts',
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
