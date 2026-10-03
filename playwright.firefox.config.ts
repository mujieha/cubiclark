import { defineConfig, devices } from '@playwright/test'

// An optional run of the office's behaviour specs in Firefox: `npm run test:e2e:firefox`. It is not
// part of CI or of the acceptance (the screenshot baselines are Chromium's, so they are ignored
// here, and only the specs that assert behaviour run). Design §7 targets current Chrome and Firefox.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: ['office-parity.spec.ts', 'office-motion.spec.ts', 'office-behaviour.spec.ts'],
  // The same leak check as the Chromium run (playwright.config.ts).
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  ignoreSnapshots: true,
  use: {
    ...devices['Desktop Firefox'],
    viewport: { width: 1280, height: 1024 },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
  },
})
