import { defineConfig, devices } from '@playwright/test'

// No webServer here: each spec spawns its own `node dist/cli.js` (via test/e2e/helpers.ts) so it
// can control --fixture-home and read the run token per test, rather than sharing one server.
//
// Screenshots are compared to committed baselines with zero tolerance, so everything that could
// change a pixel is pinned: a fixed viewport (at 1280 px the office scale is 2), one device pixel
// ratio, UTC and en-US. The baselines are macOS + Chromium (README, Known limits).
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0 },
    toMatchSnapshot: { maxDiffPixels: 0 },
  },
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 1024 },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
  },
})
