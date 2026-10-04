import { describe, expect, test } from 'vitest'
import { tick } from '../src/core/tick.js'
import type { Agent, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

function agent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    kind: 'session',
    project: 'demo',
    cwd: '/home/user/projects/demo',
    state: 'thinking',
    stateSince: 't0',
    lastActivity: 't0',
    counters: { prompts: 0, tools: 0, compactions: 0, subagents: 0 },
    openTools: [],
    ...overrides,
  } as Agent
}

function worldWith(...agents: Agent[]): World {
  let world = emptyWorld('t0', '/root')
  for (const a of agents) world = { ...world, agents: { ...world.agents, [a.id]: a } }
  return world
}

const T0 = Date.parse('2026-01-15T10:00:00.000Z')
const isoAt = (ms: number): string => new Date(ms).toISOString()

describe('tick: stuck', () => {
  test('an actively-working agent goes stuck after 10 minutes of silence', () => {
    const world = worldWith(agent({ id: 'a1', state: 'running', lastActivity: isoAt(T0) }))
    const next = tick(world, T0 + 10 * 60 * 1000 + 1)
    expect(next.agents.a1?.state).toBe('stuck')
  })

  test('not yet stuck one second before the threshold', () => {
    const world = worldWith(agent({ id: 'a1', state: 'running', lastActivity: isoAt(T0) }))
    const next = tick(world, T0 + 10 * 60 * 1000 - 1000)
    expect(next.agents.a1?.state).toBe('running')
  })

  test('waiting_user is never stuck, no matter how long it has been silent', () => {
    const world = worldWith(agent({ id: 'a1', state: 'waiting_user', lastActivity: isoAt(T0) }))
    const next = tick(world, T0 + 24 * 60 * 60 * 1000)
    expect(next.agents.a1?.state).toBe('waiting_user')
  })

  test('rate_limited is never stuck', () => {
    const world = worldWith(agent({ id: 'a1', state: 'rate_limited', lastActivity: isoAt(T0) }))
    const next = tick(world, T0 + 24 * 60 * 60 * 1000)
    expect(next.agents.a1?.state).toBe('rate_limited')
  })

  test('delegating with a live child is not stuck, even if the parent itself has been idle', () => {
    const now = T0 + 700_000
    const world = worldWith(
      agent({ id: 'parent', state: 'delegating', lastActivity: isoAt(T0) }),
      agent({ id: 'child', parentId: 'parent', kind: 'subagent', state: 'searching', lastActivity: isoAt(now - 1000) })
    )
    const next = tick(world, now)
    expect(next.agents.parent?.state).toBe('delegating')
  })

  test('delegating with no live child (all children terminal) does go stuck', () => {
    const now = T0 + 700_000
    const world = worldWith(
      agent({ id: 'parent', state: 'delegating', lastActivity: isoAt(T0) }),
      agent({ id: 'child', parentId: 'parent', kind: 'subagent', state: 'finished', lastActivity: isoAt(T0) })
    )
    const next = tick(world, now)
    expect(next.agents.parent?.state).toBe('stuck')
  })
})

describe('tick: inferred permission wait', () => {
  test('a non-exempt open tool with no later activity infers waiting_permission after 7s in default mode', () => {
    const world = worldWith(
      agent({
        id: 'a1',
        state: 'running',
        lastActivity: isoAt(T0),
        permissionMode: 'default',
        openTools: [{ id: 't1', name: 'Bash', target: 'rm', since: isoAt(T0) }],
      })
    )
    const next = tick(world, T0 + 7000)
    expect(next.agents.a1?.state).toBe('waiting_permission')
    expect(next.agents.a1?.stateEvidence).toBe('inferred')
  })

  test('no inference on a hooked agent: real PermissionRequest signals replace the guess', () => {
    const world = worldWith(
      agent({
        id: 'a1',
        state: 'running',
        lastActivity: isoAt(T0),
        permissionMode: 'default',
        hooked: { lastTs: isoAt(T0), tools: true },
        openTools: [{ id: 't1', name: 'Bash', target: 'rm', since: isoAt(T0) }],
      })
    )
    const next = tick(world, T0 + 60_000)
    expect(next.agents.a1?.state).toBe('running')
  })

  test('no inference under bypassPermissions', () => {
    const world = worldWith(
      agent({
        id: 'a1',
        state: 'running',
        lastActivity: isoAt(T0),
        permissionMode: 'bypassPermissions',
        openTools: [{ id: 't1', name: 'Bash', target: 'rm', since: isoAt(T0) }],
      })
    )
    const next = tick(world, T0 + 60_000)
    expect(next.agents.a1?.state).toBe('running')
  })

  test('no inference for a permission-exempt tool', () => {
    const world = worldWith(
      agent({
        id: 'a1',
        state: 'reading',
        lastActivity: isoAt(T0),
        permissionMode: 'default',
        openTools: [{ id: 't1', name: 'Read', target: 'a.ts', since: isoAt(T0) }],
      })
    )
    const next = tick(world, T0 + 60_000)
    expect(next.agents.a1?.state).toBe('reading')
  })

  test('a later event (lastActivity past the tool\'s own since) suppresses the inference', () => {
    const world = worldWith(
      agent({
        id: 'a1',
        state: 'running',
        lastActivity: isoAt(T0 + 5000), // something else happened 5s after the tool opened
        permissionMode: 'default',
        openTools: [{ id: 't1', name: 'Bash', target: 'rm', since: isoAt(T0) }],
      })
    )
    const next = tick(world, T0 + 60_000)
    expect(next.agents.a1?.state).toBe('running')
  })

  test('an inferred wait clears itself once the tool closes with no other event', () => {
    const world = worldWith(
      agent({
        id: 'a1',
        state: 'waiting_permission',
        stateEvidence: 'inferred',
        lastActivity: isoAt(T0),
        permissionMode: 'default',
        openTools: [],
      })
    )
    const next = tick(world, T0 + 60_000)
    expect(next.agents.a1?.state).toBe('thinking')
  })
})

describe('tick: identity when nothing changes', () => {
  test('returns the same World reference', () => {
    const world = worldWith(agent({ id: 'a1', state: 'waiting_user', lastActivity: isoAt(T0) }))
    const next = tick(world, T0 + 1000)
    expect(next).toBe(world)
  })
})
