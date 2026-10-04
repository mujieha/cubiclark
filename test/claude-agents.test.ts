// `claude agents --json` parsed from the documented fields, and the adapter that runs it. Only the
// stand-in test/fixtures/bin/claude is ever run: the real command would print real sessions.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parseAgentsJson } from '../src/core/adapters/claude-agents.js'
import { sessionId } from '../scripts/fixture-lib.js'
import type { AdapterEnv } from '../src/core/adapters/types.js'
import { ClaudeAgentsAdapter, execFileRunner, type CommandRunner } from '../src/server/adapters/claude-agents.js'
import { createAdapters } from '../src/server/adapters/registry.js'

const BIN_DIR = fileURLToPath(new URL('./fixtures/bin/', import.meta.url))
const FAKE = `${BIN_DIR}claude`

describe('parseAgentsJson over the fixture', () => {
  test('four sessions with the documented fields, one element that is not an object', async () => {
    const parsed = parseAgentsJson(await readFile(`${BIN_DIR}agents.json`, 'utf8'))
    expect(parsed.error).toBeUndefined()
    expect(parsed.unparsed).toBe(1)
    expect(parsed.sessions).toEqual([
      { sessionId: sessionId('2'), cwd: '/home/user/projects/demo', kind: 'background', state: 'working', status: 'busy', name: 'demo-worker', startedAt: '2026-01-16T08:00:00.000Z' },
      {
        sessionId: sessionId('5'),
        cwd: '/home/user/projects/shop',
        kind: 'background',
        state: 'blocked',
        status: 'waiting',
        waitingFor: 'permission prompt',
        name: 'shop-worker',
        startedAt: '2026-01-16T08:01:00.000Z',
      },
      { cwd: '/home/user/projects/demo', kind: 'interactive', status: 'idle', name: 'interactive session', startedAt: '2026-01-16T08:02:00.000Z' },
      { sessionId: sessionId('6'), cwd: '/home/user/projects/shop', kind: 'background', state: 'other', startedAt: '2026-01-16T08:03:00.000Z' },
    ])
  })
})

describe('parseAgentsJson is total', () => {
  test('not JSON, and JSON that is not an array, are errors with no sessions', () => {
    for (const text of ['', 'nope', '{"a":1}', '"x"', 'null']) {
      expect(parseAgentsJson(text)).toEqual({ sessions: [], unparsed: 0, error: 'claude agents --json did not print a JSON array' })
    }
  })
  test('an empty array is no sessions and no error', () => {
    expect(parseAgentsJson('[]')).toEqual({ sessions: [], unparsed: 0 })
  })
  test('a session id that is not a UUID is dropped; unknown fields are ignored; strings are capped', () => {
    const [session] = parseAgentsJson(JSON.stringify([{ sessionId: 'not-a-uuid', name: 'x'.repeat(100), secret: 'nope', state: 'working', kind: 'weird' }])).sessions
    expect(session).toEqual({ name: 'x'.repeat(40), state: 'working' })
  })
  // C4: a name becomes an agent's label, so it obeys the label rule (no control character, no `/` or `\`,
  // bidi and format characters included); status and waitingFor are text on the page too.
  test('a name that breaks the label rule is dropped, not shown (C4)', () => {
    const bidi = String.fromCodePoint(0x202e)
    const names = ['a/b', 'a\\b', `a${bidi}evil`, 'a\u0007b', 'a\u009bb', 'a​b', 'line\nbreak']
    const sessions = parseAgentsJson(JSON.stringify(names.map((name) => ({ name, state: 'working' })))).sessions
    expect(sessions).toEqual(names.map(() => ({ state: 'working' })))
    expect(parseAgentsJson(JSON.stringify([{ name: 'demo-worker' }])).sessions).toEqual([{ name: 'demo-worker' }])
  })
  test('a status or waitingFor value with a control character is dropped (C4)', () => {
    const [session] = parseAgentsJson(
      JSON.stringify([{ status: 'wait\u001b]52;c;x\u0007ing', waitingFor: `ok${String.fromCodePoint(0x202e)}`, name: 'w' }])
    ).sessions
    expect(session).toEqual({ name: 'w' })
    expect(parseAgentsJson(JSON.stringify([{ status: 'waiting', waitingFor: 'permission prompt' }])).sessions).toEqual([
      { status: 'waiting', waitingFor: 'permission prompt' },
    ])
  })
  test('each documented state is kept and every other value is "other"', () => {
    const states = ['working', 'blocked', 'done', 'failed', 'stopped', 'exploding']
    const parsed = parseAgentsJson(JSON.stringify(states.map((state) => ({ state })))).sessions.map((s) => s.state)
    expect(parsed).toEqual(['working', 'blocked', 'done', 'failed', 'stopped', 'other'])
  })
})

describe('ClaudeAgentsAdapter with the stand-in binary', () => {
  let now = Date.parse('2026-01-16T09:00:00Z')
  const env: AdapterEnv = { nowMs: () => now, home: '/home/user' }

  test('detect is true for the stand-in and snapshot returns its sessions', async () => {
    const adapter = new ClaudeAgentsAdapter({ bin: FAKE, pollMs: 15_000 }, env)
    expect(await adapter.detect()).toBe(true)
    const snap = await adapter.snapshot()
    expect(snap.cliSessions).toHaveLength(4)
    expect(snap.cliFetchedAt).toBe('2026-01-16T09:00:00.000Z')
    expect(snap.diagnostics).toEqual({ unparsed: 1, errors: [] })
    expect(adapter.lastSessionCount).toBe(4)
  })

  test('it asks at most once per pollMs, however often it is asked, and never below 15 s', async () => {
    let calls = 0
    const counting: CommandRunner = async (bin, args, timeoutMs) => {
      if (args[0] === 'agents') calls += 1
      return execFileRunner(bin, args, timeoutMs)
    }
    now = Date.parse('2026-01-16T09:00:00Z')
    const adapter = new ClaudeAgentsAdapter({ bin: FAKE, pollMs: 1000 }, env, counting)
    expect(adapter.pollMs).toBe(15_000)
    const first = await adapter.snapshot()
    now += 14_000
    expect(await adapter.snapshot()).toBe(first)
    expect(calls).toBe(1)
    now += 2000
    await adapter.snapshot()
    expect(calls).toBe(2)
  })

  test('a runner that times out, or exits non-zero, gives an error in diagnostics, never a throw', async () => {
    const timingOut: CommandRunner = () => Promise.reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))
    const a = new ClaudeAgentsAdapter({ bin: 'claude', pollMs: 15_000 }, env, timingOut)
    const snap = await a.snapshot()
    expect(snap.cliSessions).toEqual([])
    expect(snap.diagnostics.errors).toEqual(['cannot run claude agents --json: ETIMEDOUT'])
    expect(a.lastError).toBeDefined()

    const failing: CommandRunner = async () => ({ stdout: '', code: 2 })
    const b = new ClaudeAgentsAdapter({ bin: 'claude', pollMs: 15_000 }, env, failing)
    expect((await b.snapshot()).diagnostics.errors).toEqual(['claude agents --json exited with code 2'])

    const garbage: CommandRunner = async () => ({ stdout: 'hello', code: 0 })
    const c = new ClaudeAgentsAdapter({ bin: 'claude', pollMs: 15_000 }, env, garbage)
    expect((await c.snapshot()).diagnostics.errors).toEqual(['claude agents --json did not print a JSON array'])
  })
})

describe('off unless configured', () => {
  const env: AdapterEnv = { nowMs: () => 0, home: '/home/user' }
  test('createAdapters makes no claude-agents adapter without its configuration', () => {
    expect(createAdapters({}, env).map((a) => a.id)).toEqual([])
    expect(createAdapters({ quotaSamples: { file: '/x/y.jsonl' } }, env).map((a) => a.id)).toEqual(['quota-samples'])
    expect(createAdapters({ claudeAgents: { bin: 'claude', pollMs: 15_000 } }, env).map((a) => a.id)).toEqual(['claude-agents'])
  })
})
