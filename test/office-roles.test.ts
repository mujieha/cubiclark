import { describe, expect, test } from 'vitest'
import { roomsWorld, worldSessionId as s, worldSubagentId as sub } from '../scripts/world-fixture-lib.js'
import { accessoryFor, assignRoom, effectiveRole, helperAnchor, modelFamily } from '../src/core/office/roles.js'
import type { Agent, AgentRole, World } from '../src/core/types.js'
import { emptyWorld, ensureAgent, updateAgent } from '../src/core/world.js'

const T = '2026-01-15T10:30:00.000Z'

/** A world from agent patches; every agent defaults to a live session. */
function worldOf(...patches: (Partial<Agent> & { id: string })[]): World {
  let world = emptyWorld(T, '/root')
  for (const patch of patches) {
    world = ensureAgent(world, patch.id, T)
    world = updateAgent(world, patch.id, (agent) => ({ ...agent, project: 'demo', state: 'thinking', ...patch }))
  }
  return world
}

function agentIn(world: World, id: string): Agent {
  const agent = world.agents[id]
  if (!agent) throw new Error(`no agent ${id}`)
  return agent
}

describe('modelFamily', () => {
  test.each([
    ['claude-opus-5-5', 'opus'],
    ['claude-sonnet-5-5', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-fable-5-1', 'fable'],
    [undefined, 'other'],
    ['gpt-x', 'other'],
  ] as const)('%s is %s', (model, family) => {
    expect(modelFamily(model)).toBe(family)
  })
})

describe('effectiveRole, first match wins', () => {
  test('1. an explicit orchestrator, planner or reviewer role beats everything after it', () => {
    const world = worldOf({ id: 'a', role: 'planner', label: 'code-reviewer', taskId: 't' })
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('planner')
  })

  test('1 over 2. an explicit reviewer that also started a background session stays a reviewer', () => {
    const world = worldOf({ id: 'a', role: 'reviewer' }, { id: 'bg', kind: 'background', parentId: 'a' })
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('reviewer')
  })

  test('2. a session that started a background session is an orchestrator', () => {
    const world = worldOf({ id: 'a', role: 'builder' }, { id: 'bg', kind: 'background', parentId: 'a' })
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('orchestrator')
    expect(effectiveRole(agentIn(world, 'bg'), world)).toBe('builder')
  })

  test('2 over 3. an orchestrator whose task is planning is still an orchestrator', () => {
    let world = worldOf({ id: 'a', taskId: 't' }, { id: 'bg', kind: 'background', parentId: 'a' })
    world = { ...world, tasks: { t: { id: 't', phase: 'planning', timeline: [] } } }
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('orchestrator')
  })

  test('3. an agent whose task is in the planning phase is a planner', () => {
    let world = worldOf({ id: 'a', taskId: 't' }, { id: 'b', taskId: 'u' })
    world = { ...world, tasks: { t: { id: 't', phase: 'planning', timeline: [] }, u: { id: 'u', phase: 'building', timeline: [] } } }
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('planner')
    expect(effectiveRole(agentIn(world, 'b'), world)).toBe('builder')
  })

  test('3 over 4. a planning-phase agent labelled review is a planner', () => {
    let world = worldOf({ id: 'a', taskId: 't', label: 'code-reviewer' })
    world = { ...world, tasks: { t: { id: 't', phase: 'planning', timeline: [] } } }
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('planner')
  })

  test('4. a label that says review or verify makes a reviewer', () => {
    const world = worldOf({ id: 'a', label: 'code-reviewer' }, { id: 'b', label: 'Verifier' }, { id: 'c', label: 'Explore' })
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('reviewer')
    expect(effectiveRole(agentIn(world, 'b'), world)).toBe('reviewer')
    expect(effectiveRole(agentIn(world, 'c'), world)).toBe('builder')
  })

  test('4 over 5. a labelled reviewer with an explorer role is a reviewer', () => {
    const world = worldOf({ id: 'a', label: 'review-helper', role: 'explorer', kind: 'subagent' })
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('reviewer')
  })

  test('5. any other explicit role is kept', () => {
    const world = worldOf({ id: 'a', role: 'explorer', kind: 'subagent' }, { id: 'b', role: 'other' })
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('explorer')
    expect(effectiveRole(agentIn(world, 'b'), world)).toBe('other')
  })

  test('6. a session or background worker is a builder; a helper without a role has none', () => {
    const world = worldOf({ id: 'a' }, { id: 'b', kind: 'background' }, { id: 'c', kind: 'subagent' }, { id: 'd', kind: 'teammate' })
    expect(effectiveRole(agentIn(world, 'a'), world)).toBe('builder')
    expect(effectiveRole(agentIn(world, 'b'), world)).toBe('builder')
    expect(effectiveRole(agentIn(world, 'c'), world)).toBeUndefined()
    expect(effectiveRole(agentIn(world, 'd'), world)).toBeUndefined()
  })
})

describe('assignRoom, first match wins', () => {
  const world = roomsWorld()
  const room = (id: string): string => assignRoom(agentIn(world, id), world)

  test('the orchestrator and the derived one go to the manager, the planners to planning', () => {
    expect(room(s(1))).toBe('manager')
    expect(room(s(2))).toBe('manager')
    expect(room(s(4))).toBe('planning')
    expect(room(s(5))).toBe('planning')
  })

  test('a Plan subagent goes to planning, a reviewer subagent to review (not to a stool)', () => {
    expect(room(sub(6))).toBe('planning')
    expect(room(sub(1))).toBe('review')
  })

  test('builders go to the project floor, and so does an orphan subagent', () => {
    expect(room(s(3))).toBe('floor')
    expect(room(s(6))).toBe('floor')
    expect(room(s(7))).toBe('floor')
    expect(room(sub(5))).toBe('floor')
  })

  test('an explorer, a nested explorer and a teammate are helpers', () => {
    expect(room(sub(2))).toBe('helper')
    expect(room(sub(3))).toBe('helper')
    expect(room(s(8))).toBe('helper')
  })

  test('finished and ended agents go to the board', () => {
    expect(room(s(9))).toBe('board')
    expect(room(s(10))).toBe('board')
  })

  test('a failed agent stays at its desk, and so does a stuck one', () => {
    const failed = worldOf({ id: 'a', state: 'failed' }, { id: 'b', state: 'stuck' })
    expect(assignRoom(agentIn(failed, 'a'), failed)).toBe('floor')
    expect(assignRoom(agentIn(failed, 'b'), failed)).toBe('floor')
  })

  test('a finished orchestrator is on the board, not in the manager office', () => {
    const done = worldOf({ id: 'a', role: 'orchestrator', state: 'finished' })
    expect(assignRoom(agentIn(done, 'a'), done)).toBe('board')
  })
})

describe('helperAnchor', () => {
  test('a subagent is anchored to its parent', () => {
    const world = worldOf({ id: 'p' }, { id: 'c', kind: 'subagent', parentId: 'p' })
    expect(helperAnchor(agentIn(world, 'c'), world)).toBe('p')
  })

  test('a nested subagent is anchored to the root desk, not to its helper parent', () => {
    const world = roomsWorld()
    expect(helperAnchor(agentIn(world, sub(3)), world)).toBe(s(6))
  })

  test('the child of an orphan sits by the orphan, which has a desk of its own', () => {
    const world = worldOf(
      { id: 'orphan', kind: 'subagent', parentId: 'gone' },
      { id: 'child', kind: 'subagent', parentId: 'orphan' }
    )
    expect(helperAnchor(agentIn(world, 'orphan'), world)).toBeUndefined()
    expect(helperAnchor(agentIn(world, 'child'), world)).toBe('orphan')
  })

  test('a cycle has no anchor, so both go to the floor', () => {
    const world = worldOf({ id: 'a', kind: 'subagent', parentId: 'b' }, { id: 'b', kind: 'subagent', parentId: 'a' })
    expect(helperAnchor(agentIn(world, 'a'), world)).toBeUndefined()
    expect(assignRoom(agentIn(world, 'a'), world)).toBe('floor')
    expect(assignRoom(agentIn(world, 'b'), world)).toBe('floor')
  })

  test('a parent that has left the office is not an anchor', () => {
    const world = worldOf({ id: 'p', state: 'finished' }, { id: 'c', kind: 'subagent', parentId: 'p' })
    expect(helperAnchor(agentIn(world, 'c'), world)).toBeUndefined()
    expect(assignRoom(agentIn(world, 'c'), world)).toBe('floor')
  })

  test('a chain longer than the step limit is unanchored rather than an endless walk', () => {
    const chain = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      kind: 'subagent' as const,
      parentId: i === 11 ? 'root' : `n${i + 1}`,
    }))
    const world = worldOf({ id: 'root' }, ...chain)
    expect(helperAnchor(agentIn(world, 'n0'), world)).toBeUndefined()
    expect(helperAnchor(agentIn(world, 'n10'), world)).toBe('root')
  })

  test('a session is never anchored', () => {
    const world = worldOf({ id: 'p' }, { id: 'c', parentId: 'p' })
    expect(helperAnchor(agentIn(world, 'c'), world)).toBeUndefined()
  })
})

describe('accessoryFor', () => {
  test.each([
    ['orchestrator', 'tie'],
    ['planner', 'clipboard'],
    ['reviewer', 'magnifier'],
    ['builder', 'headphones'],
    ['explorer', 'cap'],
    ['other', 'none'],
    [undefined, 'none'],
  ] as [AgentRole | undefined, string][])('%s wears %s', (role, accessory) => {
    expect(accessoryFor(role)).toBe(accessory)
  })
})
