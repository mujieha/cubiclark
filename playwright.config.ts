import { defineConfig, devices } from '@playwright/test'

// No webServer here: each spec spawns its own `node dist/cli.js` (via test/e2e/helpers.ts) so it
// can control --fixture-home and read the run token per test, rather than sharing one server.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
  },
})
