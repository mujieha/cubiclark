// The session log (design §8: `time · agent · event · result`): one test per kind of line, that
// none of them carries anything but names and reduced targets, and the cap.

import { describe, expect, test } from 'vitest'
import { reduce } from '../src/core/reducer.js'
import type { AgentEvent, World } from '../src/core/types.js'
import { emptyWorld, MAX_LOG_LINES } from '../src/core/world.js'

const A = 'agent-a'
const H = 'agent-h'
const T = (n: number): string => new Date(Date.parse('2026-01-15T10:00:00Z') + n * 1000).toISOString()

function run(events: AgentEvent[], start: World = emptyWorld(T(0), '/root')): World {
  return events.reduce(reduce, start)
}
const meta = (agentId = A, kind: 'session' | 'subagent' = 'session'): AgentEvent => ({ t: 'agent_meta', ts: T(0), agentId, kind, cwd: '/home/user/projects/demo' })
const logOf = (world: World, kind?: string) => world.log.filter((line) => kind === undefined || line.kind === kind).map((line) => ({ agentId: line.agentId, kind: line.kind, text: line.text, ts: line.ts }))

describe('the kinds of line', () => {
  test('prompt', () => {
    expect(logOf(run([meta(), { t: 'prompt', ts: T(1), agentId: A }]))).toEqual([{ agentId: A, kind: 'prompt', text: 'prompt', ts: T(1) }])
  })

  test('a tool: name, reduced target and how it ended', () => {
    const start: AgentEvent = { t: 'tool_start', ts: T(1), agentId: A, toolUseId: 'u1', name: 'Read', target: 'README.md' }
    const ok = run([meta(), start, { t: 'tool_end', ts: T(2), agentId: A, toolUseId: 'u1', isError: false, denied: false }])
    expect(logOf(ok, 'tool')).toEqual([{ agentId: A, kind: 'tool', text: 'Read README.md · ok', ts: T(2) }])

    const failed = run([meta(), start, { t: 'tool_end', ts: T(2), agentId: A, toolUseId: 'u1', isError: true, denied: false }])
    expect(logOf(failed, 'tool')[0]?.text).toBe('Read README.md · error')

    const denied = run([meta(), start, { t: 'tool_end', ts: T(2), agentId: A, toolUseId: 'u1', isError: true, denied: true }])
    expect(logOf(denied, 'tool')[0]?.text).toBe('Read README.md · denied')
    expect(logOf(denied, 'permission')).toEqual([{ agentId: A, kind: 'permission', text: 'permission denied', ts: T(2) }]) // unchanged
  })

  test('a tool with no target is just its name', () => {
    const w = run([meta(), { t: 'tool_start', ts: T(1), agentId: A, toolUseId: 'u1', name: 'TodoWrite' }, { t: 'tool_end', ts: T(2), agentId: A, toolUseId: 'u1', isError: false, denied: false }])
    expect(logOf(w, 'tool')[0]?.text).toBe('TodoWrite · ok')
  })

  test('a result for a tool this World never saw open has no line, and a duplicate result has none either', () => {
    const orphan = run([meta(), { t: 'tool_end', ts: T(2), agentId: A, toolUseId: 'never', isError: false, denied: false }])
    expect(logOf(orphan, 'tool')).toEqual([])
    const start: AgentEvent = { t: 'tool_start', ts: T(1), agentId: A, toolUseId: 'u1', name: 'Bash', target: 'npm' }
    const end: AgentEvent = { t: 'tool_end', ts: T(2), agentId: A, toolUseId: 'u1', isError: false, denied: false }
    const twice = run([meta(), start, end, { ...end, ts: T(3) }, start])
    expect(logOf(twice, 'tool')).toHaveLength(1)
  })

  test('turn done for a session, finished for a helper', () => {
    expect(logOf(run([meta(), { t: 'turn_end', ts: T(1), agentId: A }]), 'turn')).toEqual([{ agentId: A, kind: 'turn', text: 'turn done', ts: T(1) }])
    const helper = run([meta(A), meta(H, 'subagent'), { t: 'turn_end', ts: T(1), agentId: H }])
    expect(logOf(helper, 'turn')).toEqual([{ agentId: H, kind: 'turn', text: 'finished', ts: T(1) }])
  })

  test('a session starting: fresh ones only, with their source', () => {
    expect(logOf(run([{ t: 'session_start', ts: T(1), agentId: A, source: 'startup' }]), 'session')).toEqual([
      { agentId: A, kind: 'session', text: 'session started (startup)', ts: T(1) },
    ])
    expect(logOf(run([{ t: 'session_start', ts: T(1), agentId: A, source: 'compact' }]), 'session')).toEqual([])
  })

  test('a session ending, with its reason when there is one', () => {
    expect(logOf(run([meta(), { t: 'session_end', ts: T(1), agentId: A, reason: 'clear' }]), 'session')).toEqual([
      { agentId: A, kind: 'session', text: 'session ended (clear)', ts: T(1) },
    ])
    expect(logOf(run([meta(), { t: 'session_end', ts: T(1), agentId: A }]), 'session')[0]?.text).toBe('session ended')
  })

  test('a session ending logs one line for it, not one per helper it takes with it', () => {
    const w = run([meta(A), meta(H, 'subagent'), { t: 'agent_meta', ts: T(0), agentId: H, parentId: A }, { t: 'session_end', ts: T(1), agentId: A }])
    expect(logOf(w, 'session')).toHaveLength(1)
    expect(w.agents[H]?.state).toBe('ended')
  })

  test('a subagent starting: once, with its type', () => {
    const link: AgentEvent = { t: 'subagent_link', ts: T(1), agentId: H, parentId: A, agentType: 'Explore', spawnToolUseId: 'u1' }
    const w = run([meta(A), link])
    expect(logOf(w, 'subagent')).toEqual([{ agentId: H, kind: 'subagent', text: 'started Explore', ts: T(1) }])
    expect(logOf(reduce(w, { ...link, ts: T(5) }), 'subagent')).toHaveLength(1) // a re-link is not news
    expect(logOf(run([meta(A), { t: 'subagent_link', ts: T(1), agentId: H, parentId: A }]), 'subagent')[0]?.text).toBe('started subagent')
  })

  test('a permission wait, with the tool when known', () => {
    expect(logOf(run([meta(), { t: 'permission_wait', ts: T(1), agentId: A, toolName: 'Bash' }]), 'permission')).toEqual([
      { agentId: A, kind: 'permission', text: 'waiting for permission (Bash)', ts: T(1) },
    ])
    expect(logOf(run([meta(), { t: 'permission_wait', ts: T(1), agentId: A }]), 'permission')[0]?.text).toBe('waiting for permission')
  })

  test('errors: retrying, rate limited, overloaded, and a terminal failure', () => {
    const error = (patch: Partial<Extract<AgentEvent, { t: 'api_error' }>>): World =>
      run([meta(), { t: 'api_error', ts: T(1), agentId: A, kind: 'other', retrying: false, ...patch }])
    expect(logOf(error({ retrying: true }), 'error')[0]?.text).toBe('retrying after an error')
    expect(logOf(error({ kind: 'rate_limit' }), 'error')[0]?.text).toBe('rate limited')
    expect(logOf(error({ kind: 'overloaded' }), 'error')[0]?.text).toBe('overloaded')
    expect(logOf(error({ kind: 'other' }), 'error')[0]?.text).toBe('failed: other')
  })

  test('compaction lines are unchanged', () => {
    expect(logOf(run([meta(), { t: 'compaction', ts: T(1), agentId: A, trigger: 'auto' }]), 'compaction')[0]?.text).toBe('compacted (auto)')
  })
})

describe('what a line can contain', () => {
  test('only names, a reduced target, the source and the reason: nothing from a prompt or an error message', () => {
    const w = run([
      meta(),
      { t: 'prompt', ts: T(1), agentId: A },
      { t: 'tool_start', ts: T(2), agentId: A, toolUseId: 'u1', name: 'Bash', target: 'npm' },
      { t: 'tool_end', ts: T(3), agentId: A, toolUseId: 'u1', isError: true, denied: false },
      { t: 'api_error', ts: T(4), agentId: A, kind: 'other', retrying: false, message: 'SECRET-VALUE-FROM-THE-API' },
    ])
    expect(JSON.stringify(w.log)).not.toContain('SECRET-VALUE-FROM-THE-API')
    expect(w.log.map((line) => line.text)).toEqual(['prompt', 'Bash npm · error', 'failed: other'])
  })
})

describe('the cap', () => {
  test('the log keeps the newest MAX_LOG_LINES (500) lines', () => {
    expect(MAX_LOG_LINES).toBe(500)
    const events: AgentEvent[] = [meta()]
    for (let i = 0; i < 510; i++) events.push({ t: 'prompt', ts: T(i + 1), agentId: A })
    const w = run(events)
    expect(w.log).toHaveLength(500)
    expect(w.log[0]?.ts).toBe(T(11))
    expect(w.log[499]?.ts).toBe(T(510))
  })
})
