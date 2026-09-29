// `replay` over the fixture day, stepped by hand with an injected real clock: the agents already
// there when the window opens are present at once, the rest arrive on the replay clock, adapter data
// follows that clock, and `claude agents` (which describes the present) is not asked.

import { chmod, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DAY_END, DAY_SESSIONS } from '../scripts/day-fixture-lib.js'
import { statusBar } from '../src/core/hud.js'
import { startReplay, type RunningReplay } from '../src/server/replay.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const S = DAY_SESSIONS
const END_MS = Date.parse(DAY_END)
const HOUR = 3_600_000
const START_MS = END_MS - 3 * HOUR // 14:59:50

let root: string
let real = 5_000_000
let replay: RunningReplay

async function start(sinceMs = 3 * HOUR, speed = 10): Promise<RunningReplay> {
  return startReplay({
    root: join(root, 'day', 'home'),
    fixtureMode: true,
    stateDir: join(root, 'day', 'state'),
    configPath: join(root, 'day', 'state', 'config.json'),
    home: '/home/user',
    sinceMs,
    speed,
    port: 0,
    open: false,
    realNowMs: () => real,
    manual: true,
  })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubiclark-replay-'))
  await cp(join(FIXTURES, 'day'), join(root, 'day'), { recursive: true })
  await cp(join(FIXTURES, 'bin'), join(root, 'bin'), { recursive: true })
  await chmod(join(root, 'day', 'state', 'config.json'), 0o600)
  replay = await start()
})
afterAll(async () => {
  await replay.close()
  await rm(root, { recursive: true, force: true })
})

/** Moves the real clock, then plays what the replay clock has reached. */
function advance(realMs: number): void {
  real += realMs
  replay.step()
}

describe('the window opens', () => {
  test('the clock is at the start; replay progress says so', () => {
    const world = replay.getWorld()
    expect(world.clock).toBe(new Date(START_MS).toISOString())
    expect(world.replay).toEqual({ sinceTs: new Date(START_MS).toISOString(), endTs: DAY_END.replace('Z', '.000Z'), speed: 10, done: false })
    expect(Object.fromEntries(statusBar(world).map((s) => [s.id, s.text])).replay).toBe('replay 10× · 14:59:50Z')
  })

  test('the agents that were already there are present at once; the ones that come later are not', () => {
    const agents = replay.getWorld().agents
    for (const id of [S.s0, S.s1, S.s2, S.s4, S.s5]) expect(agents[id], id).toBeDefined()
    expect(agents[S.s6], 'S6 starts at 15:00:00').toBeUndefined()
    expect(agents[S.s3], 'S3 starts at 17:20:00').toBeUndefined()
    expect(agents[S.s1]?.state).toBe('ended') // its SessionEnd hook line (12:41) is before the window
  })

  test('adapter data is as of the clock: tasks cut, quota from the sample before it', () => {
    const world = replay.getWorld()
    expect(Object.fromEntries(Object.entries(world.tasks).map(([id, task]) => [id, task.phase]))).toEqual({
      'demo-login': 'building',
      'demo-search': 'building', // its PR line is at the end of the day
      'shop-export': 'planning', // dispatched on the plan model and paused; blocked only at the end
      'demo-docs': 'done',
    })
    expect(world.tasks['shop-cart']).toBeUndefined() // dispatched at 17:20
    expect(world.quota).toMatchObject({ p5h: 10, p7d: 35 })
  })

  test('claude agents is not asked in a replay', () => {
    const adapters = replay.getWorld().sources.adapters ?? []
    expect(adapters.map((a) => [a.id, a.status])).toEqual([
      ['task-folders', 'live'],
      ['quota-samples', 'live'],
      ['claude-agents', 'off'],
    ])
    expect(Object.values(replay.getWorld().agents).every((a) => a.cli === undefined)).toBe(true)
  })
})

describe('playback', () => {
  test('at 10x, one real second is ten seconds: S6 (10 s in) arrives after a step of 1.1 s', () => {
    advance(500) // 5 s of replay: not yet
    expect(replay.getWorld().agents[S.s6]).toBeUndefined()
    advance(600) // 11 s
    expect(replay.getWorld().agents[S.s6]).toBeDefined()
    expect(replay.getWorld().clock).toBe(new Date(START_MS + 11_000).toISOString())
  })

  test('a step releases nothing twice', () => {
    const before = replay.getWorld().log.length
    replay.step()
    replay.step()
    expect(replay.getWorld().log.length).toBe(before)
  })

  test('mid-way: a task appears at its own time, and the quota follows the samples', () => {
    // 17:25 is 2 h 25 min 10 s after the start: 14 5 real seconds at 10x
    real = 5_000_000 + Math.round((Date.parse('2026-01-16T17:25:00Z') - START_MS) / 10)
    replay.step()
    const world = replay.getWorld()
    expect(world.tasks['shop-cart']?.phase).toBe('planning')
    expect(world.agents[S.s3]).toBeDefined()
    expect(world.quota).toMatchObject({ p5h: 52, p7d: 39 })
    expect(world.tasks['demo-search']?.phase).toBe('building')
    expect(world.replay?.done).toBe(false)
  })

  test('at the end it is done, the world is the day\'s, and tasks show their final phases', () => {
    real = 5_000_000 + Math.round((END_MS - START_MS) / 10) + 100
    replay.step()
    const world = replay.getWorld()
    expect(world.replay?.done).toBe(true)
    expect(world.clock).toBe(new Date(END_MS).toISOString())
    expect(Object.fromEntries(Object.entries(world.tasks).map(([id, task]) => [id, task.phase]))).toEqual({
      'demo-login': 'building',
      'shop-cart': 'planning',
      'demo-search': 'review',
      'shop-export': 'blocked',
      'demo-docs': 'done',
    })
    expect(world.quota).toMatchObject({ p5h: 62, p7d: 40 })
    expect(world.agents[S.s0]).toMatchObject({ state: 'running', role: 'orchestrator' })
    expect(world.agents[S.s3]?.state).toBe('thinking') // the CLI's permission prompt is not replayed
    expect(Object.fromEntries(statusBar(world).map((s) => [s.id, s.text])).replay).toBe('replay 10× · 17:59:50Z · done')
  })

  test('once done it stays done', () => {
    real += 10_000
    replay.step()
    expect(replay.getWorld().replay?.done).toBe(true)
    expect(replay.getWorld().clock).toBe(new Date(END_MS).toISOString())
  })
})

describe('other windows', () => {
  test('a window that opens after everything has happened: all of it is before, nothing is left to play', async () => {
    real = 9_000_000
    const late = await start(60_000) // the last minute: only S0's final command (17:59:50) is in it
    try {
      const world = late.getWorld()
      expect(Object.keys(world.agents)).toHaveLength(8)
      expect(world.agents[S.s6]?.state).toBe('waiting_user')
      real += 7_000 // 70 s at 10x: past the end
      late.step()
      expect(late.getWorld().replay?.done).toBe(true)
    } finally {
      await late.close()
    }
  })

  test('a fixture home with nothing in it replays an empty world and still finishes', async () => {
    real = 9_500_000
    const empty = await startReplay({ root: join(root, 'nowhere'), fixtureMode: true, home: '/home/user', sinceMs: HOUR, speed: 1000, port: 0, open: false, realNowMs: () => real, manual: true })
    try {
      expect(Object.keys(empty.getWorld().agents)).toEqual([])
      real += 10_000
      empty.step()
      expect(empty.getWorld().replay?.done).toBe(true)
    } finally {
      await empty.close()
    }
  })
})
