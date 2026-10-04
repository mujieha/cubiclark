// The office's fixture worlds are what they claim to be, and the checked-in JSON is current.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AGENT_STATES } from '../src/core/types.js'
import type { World } from '../src/core/types.js'
import { emptyScreen } from '../src/core/view.js'
import { hiddenText, visibleAgents, withVisibleAgents } from '../src/core/visible.js'
import { WORLD_FIXTURES, worldSessionId, worldSubagentId } from '../scripts/world-fixture-lib.js'

const WORLDS_DIR = fileURLToPath(new URL('./fixtures/worlds/', import.meta.url))

function fixture(name: string): World {
  const build = WORLD_FIXTURES[name]
  if (!build) throw new Error(`no world fixture named ${name}`)
  return build()
}

describe('the state worlds', () => {
  test.each(AGENT_STATES)('state-%s holds one session in exactly that state', (state) => {
    const world = fixture(`state-${state}`)
    expect(world.agents[worldSessionId(1)]?.state).toBe(state)
    const others = Object.values(world.agents).filter((agent) => agent.id !== worldSessionId(1))
    expect(others.length).toBe(state === 'delegating' ? 1 : 0)
  })

  test('there is one state-* world per state', () => {
    expect(Object.keys(WORLD_FIXTURES).filter((name) => name.startsWith('state-'))).toHaveLength(AGENT_STATES.length)
  })

  test('the stuck session has been quiet for 12 minutes and the rate-limited one has a quota reset', () => {
    const stuck = fixture('state-stuck')
    const quiet = Date.parse(stuck.clock) - Date.parse(stuck.agents[worldSessionId(1)]?.lastActivity ?? '')
    expect(quiet).toBe(12 * 60_000)
    expect(fixture('state-rate_limited').quota?.resets5h).toBeDefined()
    expect(fixture('state-thinking').quota).toBeUndefined()
  })

  test('the failed session carries an error message', () => {
    expect(fixture('state-failed').agents[worldSessionId(1)]?.error?.message).toContain('API Error')
  })
})

describe('the big worlds', () => {
  test('all-states covers every state', () => {
    const states = new Set(Object.values(fixture('all-states').agents).map((agent) => agent.state))
    for (const state of AGENT_STATES) expect(states.has(state)).toBe(true)
  })

  test('crowd-50 has 50 agents', () => {
    expect(Object.keys(fixture('crowd-50').agents)).toHaveLength(50)
  })

  test('crowd-100 has 100 agents: 60 live sessions, 30 subagents under 20 of them, 10 that left', () => {
    const agents = Object.values(fixture('crowd-100').agents)
    expect(agents).toHaveLength(100)
    expect(agents.filter((agent) => agent.kind === 'subagent')).toHaveLength(30)
    expect(agents.filter((agent) => agent.state === 'finished' || agent.state === 'ended')).toHaveLength(10)
    expect(new Set(agents.filter((agent) => agent.kind === 'subagent').map((agent) => agent.parentId)).size).toBe(20)
    expect(new Set(agents.map((agent) => agent.project)).size).toBeGreaterThanOrEqual(8)
  })

  test('crowd-250-idle has 250 agents: 40 working, 200 waiting for you, 10 that left', () => {
    const world = fixture('crowd-250-idle')
    const agents = Object.values(world.agents)
    expect(agents).toHaveLength(250)
    const idle = agents.filter((agent) => agent.state === 'waiting_user')
    const left = agents.filter((agent) => agent.state === 'finished' || agent.state === 'ended' || agent.state === 'failed')
    expect(idle).toHaveLength(200)
    expect(left.map((agent) => agent.state).sort()).toEqual(['ended', 'ended', 'ended', 'ended', 'failed', 'failed', 'finished', 'finished', 'finished', 'finished'])
    expect(agents.length - idle.length - left.length).toBe(40)
    expect(agents.filter((agent) => agent.kind === 'subagent')).toHaveLength(10)
    expect(new Set(agents.map((agent) => agent.project)).size).toBe(8)
    // the idle ones are ranked by how recently they were active: session 31 a minute ago, 32 two minutes ago
    const quiet = (id: string): number => Date.parse(world.clock) - Date.parse(world.agents[id]?.lastActivity ?? '')
    expect(quiet(worldSessionId(31))).toBe(60_000)
    expect(quiet(worldSessionId(230))).toBe(200 * 60_000)
    expect(agents.filter((agent) => agent.state === 'failed').every((agent) => agent.error?.message !== undefined)).toBe(true)
  })

  test('crowd-250-idle shows 49 with the defaults: the 40 working, five idle sessions, four that left a moment ago', () => {
    const world = fixture('crowd-250-idle')
    const now = Date.parse(world.clock)
    const shown = visibleAgents(world, now)
    expect(shown.ids.size).toBe(49)
    expect(shown.hidden).toEqual({ idle: 195, finished: 6, stuck: 0 })
    expect(hiddenText(shown.hidden)).toBe('195 idle not shown · 6 finished not shown')
    for (let k = 31; k <= 35; k++) expect(shown.ids.has(worldSessionId(k))).toBe(true)
    expect(shown.ids.has(worldSessionId(36))).toBe(false)
    expect(visibleAgents(world, now, { idleDesks: 0 }).ids.size).toBe(44)
    expect(visibleAgents(world, now, { idleDesks: 12 }).ids.size).toBe(56)
    expect(visibleAgents(world, now, { idleDesks: 1000 }).ids.size).toBe(244)
    expect(Object.keys(withVisibleAgents(world, shown).agents)).toHaveLength(49)
  })

  test('every subagent has its parent in the world, except the rooms world orphan', () => {
    for (const [name, build] of Object.entries(WORLD_FIXTURES)) {
      const world = build()
      for (const agent of Object.values(world.agents)) {
        if (agent.parentId === undefined) continue
        const orphanInRooms = name === 'rooms' && agent.parentId === worldSubagentId(99)
        if (!orphanInRooms) expect(world.agents[agent.parentId], `${name}: ${agent.id}`).toBeDefined()
      }
    }
  })

  test('nothing in any world leaks a full path or a tool id', () => {
    for (const build of Object.values(WORLD_FIXTURES)) {
      const text = JSON.stringify(build())
      expect(text).not.toContain('/home/user/projects')
      expect(text).not.toContain('toolu_')
    }
  })
})

describe('the empty worlds', () => {
  test.each([
    ['empty-starting', 'no-data'],
    ['empty-unreadable', 'unreadable'],
    ['empty-no-collector', 'no-collector'],
    ['empty-no-agents', 'no-agents'],
  ] as const)('%s maps to the %s screen', (name, screen) => {
    expect(emptyScreen(fixture(name))).toBe(screen)
  })
})

describe('the checked-in JSON', () => {
  test.each(Object.keys(WORLD_FIXTURES))('%s.json is what its builder produces', async (name) => {
    const onDisk = await readFile(`${WORLDS_DIR}${name}.json`, 'utf8')
    expect(JSON.parse(onDisk)).toEqual(JSON.parse(JSON.stringify(fixture(name))))
  })
})
