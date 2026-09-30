// Who is in view: the one rule the office, the list, the panel and every agent count share.

import { describe, expect, test } from 'vitest'
import { layout } from '../src/core/office/layout.js'
import { reconcileActors } from '../src/core/office/motion.js'
import { AGENT_STATES, type Agent, type AgentState, type World } from '../src/core/types.js'
import {
  DEFAULT_IDLE_DESKS,
  FAILED_GRACE_MS,
  FINISHED_GRACE_MS,
  MAX_IDLE_DESKS,
  hiddenText,
  parseIdleDesks,
  visibleAgents,
  withVisibleAgents,
} from '../src/core/visible.js'
import { emptyWorld } from '../src/core/world.js'

const T0 = Date.parse('2026-01-15T10:00:00.000Z')
const MIN = 60_000
const isoAt = (ms: number): string => new Date(ms).toISOString()

function agent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    kind: 'session',
    project: 'demo',
    cwd: 'demo',
    state: 'thinking',
    stateSince: isoAt(T0 - 5 * MIN),
    lastActivity: isoAt(T0 - MIN),
    counters: { prompts: 0, tools: 0, compactions: 0, subagents: 0 },
    openTools: [],
    ...overrides,
  } as Agent
}

function worldWith(...agents: Agent[]): World {
  const world = emptyWorld(isoAt(T0), '/root')
  return { ...world, agents: Object.fromEntries(agents.map((a) => [a.id, a])) }
}

/** Idle sessions i0 (the most recently active) to i<count-1>, `minutes` apart. */
function idleSessions(count: number, overrides: Partial<Agent> = {}): Agent[] {
  return Array.from({ length: count }, (_, i) =>
    agent({ id: `i${i}`, state: 'waiting_user', lastActivity: isoAt(T0 - (i + 1) * MIN), ...overrides })
  )
}

const idsOf = (world: World, options = {}): string[] => [...visibleAgents(world, T0, options).ids].sort()

describe('visibleAgents: who works is always shown', () => {
  const WORKING = AGENT_STATES.filter((s) => s !== 'waiting_user' && s !== 'finished' && s !== 'ended' && s !== 'failed')

  test('twelve states are neither idle nor terminal, and every agent in them is shown, even with no idle desk', () => {
    expect(WORKING).toHaveLength(12)
    const agents = WORKING.flatMap((state) => Array.from({ length: 20 }, (_, i) => agent({ id: `${state}-${i}`, state })))
    const world = worldWith(...agents)
    const visible = visibleAgents(world, T0, { idleDesks: 0 })
    expect(visible.ids.size).toBe(agents.length)
    expect(visible.hidden).toEqual({ idle: 0, finished: 0 })
  })

  test('a stuck agent is shown however long it has been stuck', () => {
    const world = worldWith(agent({ id: 'a', state: 'stuck', stateSince: isoAt(T0 - 48 * 60 * MIN), lastActivity: isoAt(T0 - 48 * 60 * MIN) }))
    expect(idsOf(world, { idleDesks: 0 })).toEqual(['a'])
  })
})

describe('visibleAgents: the sessions waiting for you', () => {
  test('at most five are shown, the five most recently active, and the rest are counted', () => {
    const world = worldWith(...idleSessions(8))
    const visible = visibleAgents(world, T0)
    expect([...visible.ids].sort()).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
    expect(visible.hidden).toEqual({ idle: 3, finished: 0 })
    expect(DEFAULT_IDLE_DESKS).toBe(5)
  })

  test('the order does not depend on how the World lists them', () => {
    const forward = worldWith(...idleSessions(8))
    const backward = worldWith(...idleSessions(8).reverse())
    expect(idsOf(backward)).toEqual(idsOf(forward))
  })

  test('background workers and teammates are idle agents like sessions', () => {
    const mixed = [
      agent({ id: 'b0', kind: 'background', state: 'waiting_user', lastActivity: isoAt(T0 - 1 * MIN) }),
      agent({ id: 's0', kind: 'session', state: 'waiting_user', lastActivity: isoAt(T0 - 2 * MIN) }),
      agent({ id: 'b1', kind: 'background', state: 'waiting_user', lastActivity: isoAt(T0 - 3 * MIN) }),
      agent({ id: 's1', kind: 'session', state: 'waiting_user', lastActivity: isoAt(T0 - 4 * MIN) }),
      agent({ id: 't0', kind: 'teammate', state: 'waiting_user', lastActivity: isoAt(T0 - 5 * MIN) }),
      agent({ id: 'b2', kind: 'background', state: 'waiting_user', lastActivity: isoAt(T0 - 6 * MIN) }),
    ]
    const visible = visibleAgents(worldWith(...mixed), T0)
    expect([...visible.ids].sort()).toEqual(['b0', 'b1', 's0', 's1', 't0'])
    expect(visible.hidden.idle).toBe(1)
  })

  test('agents with the same last activity are ranked by id', () => {
    const same = ['d', 'b', 'a', 'c'].map((id) => agent({ id, state: 'waiting_user', lastActivity: isoAt(T0 - MIN) }))
    expect(idsOf(worldWith(...same), { idleDesks: 2 })).toEqual(['a', 'b'])
  })

  test('an unreadable last activity ranks as the oldest', () => {
    const world = worldWith(
      agent({ id: 'bad', state: 'waiting_user', lastActivity: 'not a time' }),
      agent({ id: 'old', state: 'waiting_user', lastActivity: isoAt(T0 - 600 * MIN) })
    )
    expect(idsOf(world, { idleDesks: 1 })).toEqual(['old'])
  })

  test('idleDesks 0 hides every idle agent, 12 shows up to twelve', () => {
    const world = worldWith(...idleSessions(20))
    expect(visibleAgents(world, T0, { idleDesks: 0 })).toMatchObject({ hidden: { idle: 20 } })
    expect(visibleAgents(world, T0, { idleDesks: 0 }).ids.size).toBe(0)
    expect(visibleAgents(world, T0, { idleDesks: 12 }).ids.size).toBe(12)
    expect(visibleAgents(world, T0, { idleDesks: 12 }).hidden.idle).toBe(8)
    expect(visibleAgents(world, T0, { idleDesks: MAX_IDLE_DESKS }).ids.size).toBe(20)
  })

  test.each([-1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])('an idleDesks of %s falls back to five', (bad) => {
    expect(visibleAgents(worldWith(...idleSessions(9)), T0, { idleDesks: bad }).ids.size).toBe(5)
  })

  test('an idle agent that becomes active is shown on the same tick', () => {
    const before = worldWith(...idleSessions(8))
    expect(visibleAgents(before, T0).ids.has('i7')).toBe(false)
    const after: World = { ...before, agents: { ...before.agents, i7: agent({ id: 'i7', state: 'thinking', lastActivity: isoAt(T0) }) } }
    expect(visibleAgents(after, T0).ids.has('i7')).toBe(true)
    // and it did not push a working agent out, or take an idle desk from anyone
    expect(visibleAgents(after, T0).hidden.idle).toBe(2)
    expect(idsOf(after)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i7'])
  })

  test('an idle agent that is active again takes a desk from the least recent one', () => {
    const before = worldWith(...idleSessions(6))
    expect(idsOf(before)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
    const touched: World = { ...before, agents: { ...before.agents, i5: { ...before.agents.i5, lastActivity: isoAt(T0) } as Agent } }
    expect(idsOf(touched)).toEqual(['i0', 'i1', 'i2', 'i3', 'i5'])
  })
})

describe('visibleAgents: finished, ended and failed agents leave after a while', () => {
  const stoppedAgo = (state: AgentState, ms: number): Agent => agent({ id: 'x', state, stateSince: isoAt(T0 - ms) })

  test.each(['finished', 'ended'] as const)('%s: shown at 9 min 59 s, still shown at exactly 10 min, gone at 10 min 1 s', (state) => {
    expect(FINISHED_GRACE_MS).toBe(10 * MIN)
    expect(visibleAgents(worldWith(stoppedAgo(state, 10 * MIN - 1000)), T0).ids.has('x')).toBe(true)
    expect(visibleAgents(worldWith(stoppedAgo(state, 10 * MIN)), T0).ids.has('x')).toBe(true)
    const gone = visibleAgents(worldWith(stoppedAgo(state, 10 * MIN + 1000)), T0)
    expect(gone.ids.has('x')).toBe(false)
    expect(gone.hidden).toEqual({ idle: 0, finished: 1 })
  })

  test('failed: shown for thirty minutes, since it needs attention', () => {
    expect(FAILED_GRACE_MS).toBe(30 * MIN)
    expect(visibleAgents(worldWith(stoppedAgo('failed', 29 * MIN)), T0).ids.has('x')).toBe(true)
    expect(visibleAgents(worldWith(stoppedAgo('failed', 31 * MIN)), T0).hidden.finished).toBe(1)
  })

  test('the grace times can be given', () => {
    expect(visibleAgents(worldWith(stoppedAgo('ended', 2 * MIN)), T0, { finishedGraceMs: MIN }).ids.has('x')).toBe(false)
    expect(visibleAgents(worldWith(stoppedAgo('failed', 2 * MIN)), T0, { failedGraceMs: MIN }).ids.has('x')).toBe(false)
    expect(visibleAgents(worldWith(stoppedAgo('ended', 20 * MIN)), T0, { finishedGraceMs: 60 * MIN }).ids.has('x')).toBe(true)
  })

  test('a time that cannot be read fails open: the agent is shown, not lost', () => {
    const world = worldWith(agent({ id: 'x', state: 'ended', stateSince: 'garbage' }))
    expect(visibleAgents(world, T0).ids.has('x')).toBe(true)
  })

  test('idle agents and finished agents are counted apart', () => {
    const world = worldWith(...idleSessions(7), agent({ id: 'e1', state: 'ended', stateSince: isoAt(T0 - 20 * MIN) }), agent({ id: 'e2', state: 'finished', stateSince: isoAt(T0 - 3 * MIN) }))
    expect(visibleAgents(world, T0)).toMatchObject({ hidden: { idle: 2, finished: 1 } })
    expect(idsOf(world)).toContain('e2')
  })
})

describe('visibleAgents: a helper keeps its parent', () => {
  test('an idle parent beyond the top five stays while a subagent of it works, and does not use up a desk', () => {
    const idle = idleSessions(8)
    const helper = agent({ id: 'h', kind: 'subagent', parentId: 'i7', state: 'searching' })
    const visible = visibleAgents(worldWith(...idle, helper), T0)
    expect([...visible.ids].sort()).toEqual(['h', 'i0', 'i1', 'i2', 'i3', 'i4', 'i7'])
    expect(visible.hidden.idle).toBe(2)
  })

  test('a chain of idle ancestors is kept up to the root', () => {
    const idle = idleSessions(8)
    const middle = agent({ id: 'm', kind: 'subagent', parentId: 'i7', state: 'waiting_user', lastActivity: isoAt(T0 - 900 * MIN) })
    const helper = agent({ id: 'h', kind: 'subagent', parentId: 'm', state: 'reading' })
    const visible = visibleAgents(worldWith(...idle, middle, helper), T0)
    expect(visible.ids.has('m')).toBe(true)
    expect(visible.ids.has('i7')).toBe(true)
    expect(visible.hidden.idle).toBe(2)
  })

  test('a parent that has ended stays hidden: the helper sits at a desk of its own anyway', () => {
    const parent = agent({ id: 'p', state: 'ended', stateSince: isoAt(T0 - 20 * MIN) })
    const helper = agent({ id: 'h', kind: 'subagent', parentId: 'p', state: 'searching' })
    const visible = visibleAgents(worldWith(parent, helper), T0)
    expect([...visible.ids]).toEqual(['h'])
    expect(visible.hidden.finished).toBe(1)
  })

  test('the climb does not go past an ended parent to an idle grandparent', () => {
    const grand = agent({ id: 'g', state: 'waiting_user', lastActivity: isoAt(T0 - 900 * MIN) })
    const parent = agent({ id: 'p', kind: 'subagent', parentId: 'g', state: 'ended', stateSince: isoAt(T0 - 20 * MIN) })
    const helper = agent({ id: 'h', kind: 'subagent', parentId: 'p', state: 'searching' })
    expect(idsOf(worldWith(...idleSessions(5), grand, parent, helper))).not.toContain('g')
  })

  test('a finished helper does not bring its idle parent back', () => {
    const idle = idleSessions(6)
    const helper = agent({ id: 'h', kind: 'subagent', parentId: 'i5', state: 'finished', stateSince: isoAt(T0 - 2 * MIN) })
    expect(idsOf(worldWith(...idle, helper))).not.toContain('i5')
  })

  test('a cycle of parents ends', () => {
    const a = agent({ id: 'a', kind: 'subagent', parentId: 'b', state: 'searching' })
    const b = agent({ id: 'b', kind: 'subagent', parentId: 'a', state: 'waiting_user', lastActivity: isoAt(T0 - 900 * MIN) })
    const visible = visibleAgents(worldWith(...idleSessions(5), a, b), T0)
    expect(visible.ids.has('b')).toBe(true)
  })

  test('a parent that is not in the World is no problem', () => {
    const orphan = agent({ id: 'o', kind: 'subagent', parentId: 'gone', state: 'searching' })
    expect(idsOf(worldWith(orphan))).toEqual(['o'])
  })
})

describe('withVisibleAgents', () => {
  test('is the very same World when nothing is hidden', () => {
    const world = worldWith(agent({ id: 'a' }), agent({ id: 'b', state: 'running' }))
    expect(withVisibleAgents(world, visibleAgents(world, T0))).toBe(world)
  })

  test('drops only agents: the log, the tasks, the sources and the clock are the same values', () => {
    const base = worldWith(...idleSessions(8))
    const world: World = { ...base, log: [{ ts: isoAt(T0), agentId: 'i7', kind: 'prompt', text: 'prompt' }] }
    const view = withVisibleAgents(world, visibleAgents(world, T0))
    expect(Object.keys(view.agents)).toHaveLength(5)
    expect(view.log).toBe(world.log)
    expect(view.tasks).toBe(world.tasks)
    expect(view.sources).toBe(world.sources)
    expect(view.diagnostics).toBe(world.diagnostics)
    expect(view.clock).toBe(world.clock)
    // the World it came from is untouched
    expect(Object.keys(world.agents)).toHaveLength(8)
  })
})

describe('hiddenText', () => {
  test('says only what is hidden', () => {
    expect(hiddenText({ idle: 0, finished: 0 })).toBeUndefined()
    expect(hiddenText(undefined)).toBeUndefined()
    expect(hiddenText({ idle: 3, finished: 0 })).toBe('3 idle not shown')
    expect(hiddenText({ idle: 0, finished: 2 })).toBe('2 finished not shown')
    expect(hiddenText({ idle: 195, finished: 6 })).toBe('195 idle not shown · 6 finished not shown')
  })
})

describe('parseIdleDesks', () => {
  test('a whole number from 0 to 1000', () => {
    expect(parseIdleDesks(0)).toBe(0)
    expect(parseIdleDesks(5)).toBe(5)
    expect(parseIdleDesks(1000)).toBe(1000)
  })
  test.each([-1, 1.5, 1001, Number.NaN, '5', undefined, null, {}])('%s is nothing', (bad) => {
    expect(parseIdleDesks(bad)).toBeUndefined()
  })
})

describe('an agent that is shown again arrives like a newcomer, and one that goes leaves silently', () => {
  const FIRST = { reducedMotion: false, firstSnapshot: true }
  const LATER = { reducedMotion: false, firstSnapshot: false }
  const viewOf = (world: World): World => withVisibleAgents(world, visibleAgents(world, T0))

  test('the sixth idle session walks in from the door the moment it is active', () => {
    const idle = idleSessions(6)
    const before = viewOf(worldWith(...idle))
    expect(Object.keys(before.agents)).not.toContain('i5')
    const layoutBefore = layout(before)
    const actors = reconcileActors(new Map(), undefined, layoutBefore, { nowMs: 0, ...FIRST })
    expect(actors.has('i5')).toBe(false)

    const awake: World = { ...worldWith(...idle), agents: { ...worldWith(...idle).agents, i5: agent({ id: 'i5', state: 'thinking', lastActivity: isoAt(T0) }) } }
    const layoutAfter = layout(viewOf(awake), layoutBefore)
    const next = reconcileActors(actors, layoutBefore, layoutAfter, { nowMs: 1000, ...LATER })
    const arriving = next.get('i5')
    expect(arriving?.phase).toBe('arriving')
    expect(arriving?.path[0]).toEqual(layoutAfter.door)
    // and the agents that were there stay where they were
    for (const id of ['i0', 'i1', 'i2', 'i3', 'i4']) expect(next.get(id)?.phase).toBe('seated')
  })

  test('the least recent idle session leaves with no walk-out and no place on the board', () => {
    const idle = idleSessions(5)
    const before = viewOf(worldWith(...idle))
    const layoutBefore = layout(before)
    const actors = reconcileActors(new Map(), undefined, layoutBefore, { nowMs: 0, ...FIRST })
    expect(actors.get('i4')?.phase).toBe('seated')

    // a sixth session becomes the most recently active: i4 falls out of the five
    const six = worldWith(...idle, agent({ id: 'new', state: 'waiting_user', lastActivity: isoAt(T0) }))
    const after = viewOf(six)
    expect(Object.keys(after.agents)).not.toContain('i4')
    const layoutAfter = layout(after, layoutBefore)
    expect(layoutAfter.placements.some((p) => p.agentId === 'i4')).toBe(false)
    expect(layoutAfter.placements.filter((p) => p.kind === 'board')).toEqual([])
    const next = reconcileActors(actors, layoutBefore, layoutAfter, { nowMs: 1000, ...LATER })
    expect(next.has('i4')).toBe(false)
    expect([...next.values()].some((a) => a.phase === 'leaving' || a.phase === 'departed')).toBe(false)
  })
})
