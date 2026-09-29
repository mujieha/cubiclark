// The office's fixture worlds are what they claim to be, and the checked-in JSON is current.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AGENT_STATES } from '../src/core/types.js'
import type { World } from '../src/core/types.js'
import { emptyScreen } from '../src/core/view.js'
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
