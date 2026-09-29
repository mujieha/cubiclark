import { defineConfig } from 'vitest/config'

// Tests never touch the real ~/.claude or ~/.agent-office: HOME and CLAUDE_CONFIG_DIR are
// overridden to a directory that does not exist, so any code path that forgets to take an
// explicit root and falls back to the real home fails loudly instead of reading real data.
const unusedHome = '/tmp/agent-office-test-home-does-not-exist'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    env: {
      HOME: unusedHome,
      CLAUDE_CONFIG_DIR: `${unusedHome}/.claude`,
    },
  },
})
