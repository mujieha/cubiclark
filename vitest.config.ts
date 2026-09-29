import { defineConfig } from 'vitest/config'

// Tests never touch the real ~/.claude or ~/.cubiclark: HOME, CLAUDE_CONFIG_DIR and
// CUBICLARK_HOME are overridden to a directory that does not exist, so any code path that
// forgets to take an explicit root and falls back to the real home fails loudly instead of
// reading real data.
const unusedHome = '/tmp/cubiclark-test-home-does-not-exist'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/hooks/**'],
    environment: 'node',
    env: {
      HOME: unusedHome,
      CLAUDE_CONFIG_DIR: `${unusedHome}/.claude`,
      CUBICLARK_HOME: `${unusedHome}/.cubiclark`,
      // LOG.md note lines carry a local date and time; a fixed zone keeps their tests exact.
      TZ: 'UTC',
    },
  },
})
