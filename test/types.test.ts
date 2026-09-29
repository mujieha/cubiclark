import { describe, expect, test } from 'vitest'
import { AGENT_STATES } from '../src/core/types.js'
import { emptyWorld, ensureAgent, pushLog, pushSourceError, setState } from '../src/core/world.js'

describe('AGENT_STATES', () => {
  test('has exactly the 16 states of design §5, with no duplicates', () => {
    expect(AGENT_STATES).toHaveLength(16)
    expect(new Set(AGENT_STATES).size).toBe(16)
    expect(AGENT_STATES).toEqual([
      'starting',
      'thinking',
      'reading',
      'editing',
      'running',
      'searching',
      'browsing',
      'delegating',
      'waiting_permission',
      'waiting_user',
      'compacting',
      'stuck',
      'rate_limited',
      'failed',
      'finished',
      'ended',
    ])
  })
})

describe('emptyWorld', () => {
  test('has no agents, no diagnostics, and starting transcript status', () => {
    const world = emptyWorld('2026-01-15T10:00:00.000Z', '/fixture/home')
    expect(world.agents).toEqual({})
    expect(world.tasks).toEqual({})
    expect(world.log).toEqual([])
    expect(world.diagnostics).toEqual({
      unparsedLines: 0,
      unknownHookShapes: 0,
      sourceErrors: [],
      unknownTypes: {},
      versions: [],
    })
    expect(world.sources.transcripts).toEqual({
      status: 'starting',
      root: '/fixture/home',
      files: 0,
      inWindow: 0,
      windowHours: null,
    })
    expect(world.sources.hooks).toEqual({ status: 'not_installed', events: 0 })
    expect(world.clock).toBe('2026-01-15T10:00:00.000Z')
  })
})

describe('ensureAgent', () => {
  test('inserts a default agent in starting state', () => {
    const world = emptyWorld('t0', '/root')
    const next = ensureAgent(world, 'a1', 't0')
    expect(next.agents.a1).toMatchObject({
      id: 'a1',
      kind: 'session',
      state: 'starting',
      stateSince: 't0',
      lastActivity: 't0',
      counters: { prompts: 0, tools: 0, compactions: 0, subagents: 0 },
      openTools: [],
    })
  })

  test('returns the same World reference when the agent already exists', () => {
    const world = ensureAgent(emptyWorld('t0', '/root'), 'a1', 't0')
    const next = ensureAgent(world, 'a1', 't1')
    expect(next).toBe(world)
  })
})

describe('setState', () => {
  test('changes stateSince only when the state actually changes', () => {
    let world = ensureAgent(emptyWorld('t0', '/root'), 'a1', 't0')
    world = setState(world, 'a1', 'thinking', 't1')
    expect(world.agents.a1?.state).toBe('thinking')
    expect(world.agents.a1?.stateSince).toBe('t1')

    world = setState(world, 'a1', 'thinking', 't2')
    expect(world.agents.a1?.stateSince).toBe('t1')

    world = setState(world, 'a1', 'reading', 't3')
    expect(world.agents.a1?.stateSince).toBe('t3')
  })

  test('marks a state inferred only when asked', () => {
    let world = ensureAgent(emptyWorld('t0', '/root'), 'a1', 't0')
    world = setState(world, 'a1', 'waiting_permission', 't1', 'inferred')
    expect(world.agents.a1?.stateEvidence).toBe('inferred')
  })

  test('is a no-op World reference when the agent does not exist', () => {
    const world = emptyWorld('t0', '/root')
    expect(setState(world, 'missing', 'thinking', 't1')).toBe(world)
  })
})

describe('pushLog', () => {
  test('appends and caps at 300 lines, dropping the oldest', () => {
    let world = emptyWorld('t0', '/root')
    for (let i = 0; i < 305; i += 1) {
      world = pushLog(world, { ts: `t${i}`, agentId: 'a1', kind: 'note', text: `line ${i}` })
    }
    expect(world.log).toHaveLength(300)
    expect(world.log[0]?.text).toBe('line 5')
    expect(world.log[299]?.text).toBe('line 304')
  })
})

describe('pushSourceError', () => {
  test('appends and caps at 50 entries, dropping the oldest', () => {
    let world = emptyWorld('t0', '/root')
    for (let i = 0; i < 55; i += 1) {
      world = pushSourceError(world, `error ${i}`)
    }
    expect(world.diagnostics.sourceErrors).toHaveLength(50)
    expect(world.diagnostics.sourceErrors[0]).toBe('error 5')
  })
})
