// Every adapter's detect() is false, and does not throw, when its source is absent or broken; and
// snapshot() over the same sources resolves with an error instead of rejecting.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AdapterEnv, OrchestrationAdapter } from '../src/core/adapters/types.js'
import { createAdapters } from '../src/server/adapters/registry.js'

const env: AdapterEnv = { nowMs: () => Date.parse('2026-01-16T09:00:00Z'), home: '/home/user' }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-detect-'))
})
afterEach(async () => {
  await chmod(join(dir, 'locked'), 0o755).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

function taskFolders(root: string): OrchestrationAdapter {
  return createAdapters({ taskFolders: { roots: [root], orchestratorCwds: [], windowHours: null } }, env)[0] as OrchestrationAdapter
}
function quota(file: string): OrchestrationAdapter {
  return createAdapters({ quotaSamples: { file } }, env)[0] as OrchestrationAdapter
}
function agents(bin: string): OrchestrationAdapter {
  return createAdapters({ claudeAgents: { bin, pollMs: 15_000 } }, env)[0] as OrchestrationAdapter
}

async function brokenSources(): Promise<[string, OrchestrationAdapter][]> {
  await writeFile(join(dir, 'a-file'), 'x')
  await mkdir(join(dir, 'locked'))
  await chmod(join(dir, 'locked'), 0)
  await mkdir(join(dir, 'a-dir'))
  await writeFile(join(dir, 'exit1.sh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await writeFile(join(dir, 'not-executable'), '#!/bin/sh\necho 1\n', { mode: 0o644 })
  return [
    ['task-folders: a root that does not exist', taskFolders(join(dir, 'nowhere'))],
    ['task-folders: a root that is a file', taskFolders(join(dir, 'a-file'))],
    ['task-folders: a root that cannot be listed', taskFolders(join(dir, 'locked'))],
    ['quota-samples: a path that does not exist', quota(join(dir, 'nowhere.jsonl'))],
    ['quota-samples: a path that is a directory', quota(join(dir, 'a-dir'))],
    ['quota-samples: a glob in a directory that does not exist', quota(join(dir, 'nowhere', 'samples-*.jsonl'))],
    ['quota-samples: a glob that matches nothing', quota(join(dir, 'samples-*.jsonl'))],
    ['claude-agents: a program that does not exist', agents(join(dir, 'no-such-claude'))],
    ['claude-agents: a program that exits 1', agents(join(dir, 'exit1.sh'))],
    ['claude-agents: a path that is a directory', agents(join(dir, 'a-dir'))],
    ['claude-agents: a file that is not executable', agents(join(dir, 'not-executable'))],
  ]
}

describe('detect() is false, never a throw, without its source', () => {
  test('eleven kinds of absent or broken source', async () => {
    const cases = await brokenSources()
    expect(cases).toHaveLength(11)
    for (const [label, adapter] of cases) {
      await expect(adapter.detect(env), label).resolves.toBe(false)
    }
  })

  test('snapshot() over the same sources resolves, with an error or an empty result', async () => {
    for (const [label, adapter] of await brokenSources()) {
      const snap = await adapter.snapshot()
      expect(snap.diagnostics.errors.length, label).toBeGreaterThan(0)
      // an error names no absolute path
      expect(JSON.stringify(snap.diagnostics.errors), label).not.toContain(dir)
    }
  })

  test('a present source is detected', async () => {
    await mkdir(join(dir, 'tasks'))
    await writeFile(join(dir, 'samples-1.jsonl'), '')
    await writeFile(join(dir, 'fake-claude'), '#!/bin/sh\necho "2.1.285 (Claude Code)"\n', { mode: 0o755 })
    await expect(taskFolders(join(dir, 'tasks')).detect(env)).resolves.toBe(true)
    await expect(quota(join(dir, 'samples-*.jsonl')).detect(env)).resolves.toBe(true)
    await expect(agents(join(dir, 'fake-claude')).detect(env)).resolves.toBe(true)
  })
})
