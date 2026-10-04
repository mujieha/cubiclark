import { defineConfig, devices } from '@playwright/test'

// No webServer here: each spec spawns its own `node dist/cli.js` (via test/e2e/helpers.ts) so it
// can control --fixture-home and read the run token per test, rather than sharing one server.
//
// Screenshots are compared to committed baselines with zero tolerance, so everything that could
// change a pixel is pinned: a fixed viewport, one device pixel ratio, UTC and en-US. The baselines
// are macOS + Chromium (README, Known limits). At 1600 px the HUD panel (380 px) leaves the office
// column 1172 px, so the office scale is still 2, as it was at 1280 px before the panel existed.
export default defineConfig({
  testDir: 'test/e2e',
  // tmp/e2e-pids/ is emptied before the run, and the run fails if a server the tests spawned is still
  // alive after it (test/e2e/helpers.ts writes the pids).
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0 },
    toMatchSnapshot: { maxDiffPixels: 0 },
  },
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1600, height: 1024 },
    deviceScaleFactor: 1,
    // Pinned: `auto` follows the operating system, and every baseline is the day theme unless a spec
    // chooses another.
    colorScheme: 'light',
    timezoneId: 'UTC',
    locale: 'en-US',
  },
})
