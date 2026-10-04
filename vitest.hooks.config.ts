import { defineConfig } from 'vitest/config'

// The hooks suite runs against the built dist/ (it spawns the real collector and CLI), so it is
// kept out of `npm test`. Same rule as vitest.config.ts: never the real ~/.claude or
// ~/.cubiclark. Files run one after another because the benchmark must not compete for CPU.
const unusedHome = '/tmp/cubiclark-test-home-does-not-exist'

export default defineConfig({
  test: {
    include: ['test/hooks/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    fileParallelism: false,
    env: {
      HOME: unusedHome,
      CLAUDE_CONFIG_DIR: `${unusedHome}/.claude`,
      CUBICLARK_HOME: `${unusedHome}/.cubiclark`,
      TZ: 'UTC',
    },
  },
})
