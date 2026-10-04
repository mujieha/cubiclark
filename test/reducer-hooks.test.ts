// Phase 2 reducer behaviour: the hook events, and the order-proof tool dedup that makes async
// hook processes (which can append PostToolUse before PreToolUse) safe. Every case feeds
// literal events straight into reduce().

import { describe, expect, test } from 'vitest'
import { reduce } from '../src/core/reducer.js'
import type { AgentEvent, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

const T = (n: number): string => new Date(Date.parse('2026-01-15T10:00:00.000Z') + n * 1000).toISOString()

function run(events: AgentEvent[], from: World = emptyWorld(T(0), '/root')): World {
  return events.reduce((w, e) => reduce(w, e), from)
}

const toolStart = (n: number, id: string, agentId = 's1', name = 'Bash', target?: string): AgentEvent => ({
  t: 'tool_start',
  ts: T(n),
  agentId,
  toolUseId: id,
  name,
  target,
})
const toolEnd = (n: number, id: string, agentId = 's1', denied = false): AgentEvent => ({
  t: 'tool_end',
  ts: T(n),
  agentId,
  toolUseId: id,
  isError: false,
  denied,
})
const prompt = (n: number, agentId = 's1'): AgentEvent => ({ t: 'prompt', ts: T(n), agentId })

describe('order-proof tool dedup', () => {
  test('the same tool_start twice counts one tool and opens one', () => {
    const world = run([toolStart(1, 't1'), toolStart(2, 't1')])
    expect(world.agents.s1?.counters.tools).toBe(1)
    expect(world.agents.s1?.openTools).toHaveLength(1)
  })

  test('tool_end before tool_start (async race) leaves no open tool and does not change state', () => {
    const world = run([prompt(1), toolEnd(2, 't1'), toolStart(3, 't1')])
    expect(world.agents.s1?.openTools).toEqual([])
    expect(world.agents.s1?.state).toBe('thinking')
    expect(world.agents.s1?.counters.tools).toBe(0)
  })

  test('tool_end for an unknown id while waiting_user does not change the state', () => {
    const world = run([prompt(1), { t: 'turn_end', ts: T(2), agentId: 's1' }, toolEnd(3, 'never-opened')])
    expect(world.agents.s1?.state).toBe('waiting_user')
  })

  test('a denied tool_end for an unknown id still logs the denial', () => {
    const world = run([prompt(1), toolEnd(2, 'x', 's1', true)])
    expect(world.log.some((l) => l.kind === 'permission')).toBe(true)
  })

  test('closedToolIds keeps only the newest 64 ids', () => {
    const events: AgentEvent[] = []
    for (let i = 0; i < 70; i++) events.push(toolStart(i, `t${i}`), toolEnd(i, `t${i}`))
    const world = run(events)
    expect(world.agents.s1?.closedToolIds).toHaveLength(64)
    expect(world.agents.s1?.closedToolIds?.[63]).toBe('t69')
    expect(world.agents.s1?.closedToolIds).not.toContain('t0')
  })

  test('a normal open then close still returns the agent to thinking', () => {
    const world = run([prompt(1), toolStart(2, 't1', 's1', 'Read', 'a.ts'), toolEnd(3, 't1')])
    expect(world.agents.s1?.state).toBe('thinking')
    expect(world.agents.s1?.currentTool).toBeUndefined()
  })
})

describe('hook_seen', () => {
  test('creates the agent and marks it hooked', () => {
    const world = run([{ t: 'hook_seen', ts: T(1), agentId: 's1', tools: true, cwd: '/home/user/projects/demo' }])
    expect(world.agents.s1).toMatchObject({ hooked: { lastTs: T(1), tools: true }, project: 'demo' })
  })

  test('a new subagent takes its kind and parent; an existing agent keeps its kind', () => {
    let world = run([{ t: 'hook_seen', ts: T(1), agentId: 'a1', tools: false, kind: 'subagent', parentId: 's1' }])
    expect(world.agents.a1).toMatchObject({ kind: 'subagent', parentId: 's1' })
    world = run([{ t: 'hook_seen', ts: T(2), agentId: 's1', tools: false }], world)
    expect(world.agents.s1?.kind).toBe('session')
  })

  test('does not touch lastActivity or state on an existing agent', () => {
    let world = run([prompt(1)])
    const before = world.agents.s1
    world = run([{ t: 'hook_seen', ts: T(9), agentId: 's1', tools: false }], world)
    expect(world.agents.s1?.lastActivity).toBe(before?.lastActivity)
    expect(world.agents.s1?.state).toBe(before?.state)
  })

  test('keeps the newest lastTs and ORs the tools flag', () => {
    let world = run([{ t: 'hook_seen', ts: T(5), agentId: 's1', tools: true }])
    world = run([{ t: 'hook_seen', ts: T(2), agentId: 's1', tools: false }], world)
    expect(world.agents.s1?.hooked).toEqual({ lastTs: T(5), tools: true })
  })

  test('records effort and permission mode', () => {
    const world = run([{ t: 'hook_seen', ts: T(1), agentId: 's1', tools: false, effort: 'high', permissionMode: 'plan' }])
    expect(world.agents.s1).toMatchObject({ effort: 'high', permissionMode: 'plan' })
  })
})

describe('session_start and session_end', () => {
  test('startup puts the session in waiting_user and fills the model only when absent', () => {
    let world = run([{ t: 'session_start', ts: T(1), agentId: 's1', source: 'startup', model: 'claude-opus-5-5' }])
    expect(world.agents.s1).toMatchObject({ state: 'waiting_user', model: 'claude-opus-5-5' })
    world = run([{ t: 'session_start', ts: T(2), agentId: 's1', source: 'resume', model: 'claude-sonnet-5-5' }], world)
    expect(world.agents.s1?.model).toBe('claude-opus-5-5')
  })

  test('source compact does not change the state', () => {
    let world = run([prompt(1)])
    world = run([{ t: 'session_start', ts: T(2), agentId: 's1', source: 'compact' }], world)
    expect(world.agents.s1?.state).toBe('thinking')
  })

  test('session_end ends the session and its live children, not finished ones', () => {
    const world = run([
      prompt(1),
      { t: 'subagent_link', ts: T(2), agentId: 'live', parentId: 's1', agentType: 'Explore' },
      { t: 'subagent_link', ts: T(2), agentId: 'done', parentId: 's1', agentType: 'Plan' },
      { t: 'turn_end', ts: T(3), agentId: 'done' },
      { t: 'session_end', ts: T(4), agentId: 's1', reason: 'other' },
    ])
    expect(world.agents.s1?.state).toBe('ended')
    expect(world.agents.live?.state).toBe('ended')
    expect(world.agents.done?.state).toBe('finished')
  })
})

describe('permission_wait, compacting, compacted', () => {
  test('permission_wait is an observed waiting_permission with the tool named', () => {
    const world = run([prompt(1), { t: 'permission_wait', ts: T(2), agentId: 's1', toolName: 'Bash' }])
    expect(world.agents.s1).toMatchObject({
      state: 'waiting_permission',
      stateEvidence: 'observed',
      currentTool: { name: 'Bash' },
    })
  })

  test('compacting, then compacted manual returns to waiting_user and auto to thinking', () => {
    let world = run([prompt(1), { t: 'compacting', ts: T(2), agentId: 's1', trigger: 'auto' }])
    expect(world.agents.s1?.state).toBe('compacting')
    const manual = run([{ t: 'compacted', ts: T(3), agentId: 's1', trigger: 'manual' }], world)
    expect(manual.agents.s1?.state).toBe('waiting_user')
    world = run([{ t: 'compacted', ts: T(3), agentId: 's1', trigger: 'auto' }], world)
    expect(world.agents.s1?.state).toBe('thinking')
  })
})

describe('assistant fillOnly and diagnostics', () => {
  test('a fillOnly assistant event sets the model but keeps a waiting_user state', () => {
    let world = run([prompt(1), { t: 'turn_end', ts: T(2), agentId: 's1' }])
    world = run(
      [{ t: 'assistant', ts: T(3), agentId: 's1', model: 'claude-opus-5-5', tokensOut: 5, thinking: false, text: true, fillOnly: true }],
      world
    )
    expect(world.agents.s1).toMatchObject({ model: 'claude-opus-5-5', state: 'waiting_user' })
    expect(world.agents.s1?.counters.tokensOut).toBe(5)
  })

  test('diagnostics adds unknownHookShapes', () => {
    const world = run([
      { t: 'diagnostics', ts: T(1), unparsed: 0, unknownTypes: {}, versions: [], unknownHookShapes: 2 },
    ])
    expect(world.diagnostics.unknownHookShapes).toBe(2)
  })
})
