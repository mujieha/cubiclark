// R2-3: a crafted sidecar (or hook line) must not make an agent its own ancestor, nor re-parent it into
// another session; and the list (agentRows) shows every agent exactly once, whatever the parent map says.
// Ids are invented.

import { describe, expect, test } from 'vitest'
import { initialHookNormState, normaliseHookLine } from '../src/core/hooks/normalise.js'
import { reduce } from '../src/core/reducer.js'
import { agentRows } from '../src/core/view.js'
import { emptyWorld } from '../src/core/world.js'
import type { AgentEvent, World } from '../src/core/types.js'

const T0 = '2026-10-03T10:00:00.000Z'
const NOW = Date.parse('2026-10-03T10:00:30.000Z')
const S = 'session-one'
const S2 = 'session-two'
const A = 'a0b1c2d3e4f5a6b7c'
const B = 'b0b1c2d3e4f5a6b7c'
const H = 'c0b1c2d3e4f5a6b7c'

function run(events: AgentEvent[], from: World = emptyWorld(T0, '/root')): World {
  return events.reduce((w, e) => reduce(w, e), from)
}

const prompt = (agentId: string): AgentEvent => ({ t: 'prompt', ts: T0, agentId })
const link = (agentId: string, parentId: string, spawnToolUseId?: string): AgentEvent => ({
  t: 'subagent_link',
  ts: T0,
  agentId,
  parentId,
  agentType: 'general-purpose',
  ...(spawnToolUseId ? { spawnToolUseId } : {}),
})
const tool = (agentId: string, toolUseId: string, name: string): AgentEvent => ({ t: 'tool_start', ts: T0, agentId, toolUseId, name })

const ids = (world: World): string[] => agentRows(world, NOW).map((row) => row.id)

describe('a link that would make an agent its own parent (R2-3)', () => {
  test('the probe: a meta file naming a tool the agent itself has open leaves it under its session, and in the list', () => {
    const world = run([prompt(S), link(A, S), tool(A, 'toolu_X', 'Bash'), link(A, S, 'toolu_X')])
    expect(world.agents[A]?.parentId).toBe(S)
    expect(ids(world).sort()).toEqual([A, S].sort())
    expect(ids(world)).toHaveLength(Object.keys(world.agents).length)
  })

  test('a link naming a tool of the agent\'s own child leaves it where it was, and both stay in the list', () => {
    let world = run([prompt(S), link(A, S), tool(A, 'toolu_A', 'Agent'), link(B, S, 'toolu_A'), tool(B, 'toolu_B', 'Bash')])
    expect(world.agents[B]?.parentId).toBe(A) // a nested subagent still goes under the helper that started it
    world = run([link(A, S, 'toolu_B')], world)
    expect(world.agents[A]?.parentId).toBe(S)
    expect(world.agents[B]?.parentId).toBe(A)
    expect(ids(world)).toHaveLength(3)
  })

  test('a link never takes a helper of another session as its parent', () => {
    const world = run([prompt(S), prompt(S2), link(H, S2), tool(H, 'toolu_H', 'Agent'), link(A, S, 'toolu_H')])
    expect(world.agents[A]?.parentId).toBe(S)
  })

  test('an agent_meta or a hook_seen whose parent is the agent itself leaves no parent', () => {
    const meta = run([{ t: 'agent_meta', ts: T0, agentId: A, parentId: A, kind: 'subagent' }])
    expect(meta.agents[A]?.parentId).toBeUndefined()
    const seen = run([{ t: 'hook_seen', ts: T0, agentId: A, tools: false, kind: 'subagent', parentId: A }])
    expect(seen.agents[A]?.parentId).toBeUndefined()
  })

  test('a SubagentStart hook line whose agent id is its session id makes no event', () => {
    const line = JSON.stringify({ v: 1, ts: T0, e: 'SubagentStart', sid: S, aid: S, at: 'Explore' })
    const result = normaliseHookLine(line, initialHookNormState())
    expect(result.events).toEqual([])
    expect(result.unknownShape).toBe(true)
  })

  test('a normal nested subagent is still parented to the helper that started it', () => {
    const world = run([prompt(S), link(A, S), tool(A, 'toolu_A', 'Agent'), link(B, S, 'toolu_A')])
    expect(world.agents[B]?.parentId).toBe(A)
    expect(ids(world)).toEqual([S, A, B])
  })
})
