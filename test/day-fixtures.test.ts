// The fixture day (scripts/day-fixture-lib.ts) becomes the World it is meant to: three tasks
// mid-flight with live agents, the planning room occupied, the orchestrator found by its cwd, the
// quota at the end of the day. Built the way the app builds it: the transcript and hook sources,
// the store, and the adapter host over the day's own config file.

import { chmod, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DAY_END, DAY_HELPER, DAY_SESSIONS } from '../scripts/day-fixture-lib.js'
import { quotaAt } from '../src/core/adapters/quota.js'
import { layout } from '../src/core/office/layout.js'
import { statusBar } from '../src/core/hud.js'
import type { World } from '../src/core/types.js'
import { AdapterHost } from '../src/server/adapters/host.js'
import { createAdapters } from '../src/server/adapters/registry.js'
import { loadConfig } from '../src/server/config-file.js'
import { HookSource } from '../src/server/hook-source.js'
import { Store } from '../src/server/store.js'
import { TranscriptSource } from '../src/server/transcript-source.js'

const DAY = fileURLToPath(new URL('./fixtures/day', import.meta.url))
const END_MS = Date.parse(DAY_END)
const S = DAY_SESSIONS

let root: string
let world: World
let adapterStatuses: ReturnType<AdapterHost['statuses']>

async function build(): Promise<World> {
  const nowMs = (): number => END_MS
  const store = new Store({ nowMs, transcriptsRoot: join(root, 'day', 'home') })
  const transcripts = new TranscriptSource({
    root: join(root, 'day', 'home'),
    sinceMs: null,
    windowHours: null,
    watch: false,
    pollMs: 3_600_000,
    onEvents: (events) => store.applyTranscriptEvents(events),
    nowMs,
  })
  await transcripts.start()
  const hooks = new HookSource({ eventsFile: join(root, 'day', 'state', 'events.jsonl'), sinceMs: null, watch: false, pollMs: 3_600_000, onEvents: (events) => store.applyEvents(events), nowMs })
  await hooks.start()

  const loaded = await loadConfig(join(root, 'day', 'state', 'config.json'), { home: '/home/user', fixtureMode: true })
  expect(loaded.warnings).toEqual([])
  const env = { nowMs, home: '/home/user' }
  const host = new AdapterHost({ adapters: createAdapters(loaded.config, env), env, onSnapshot: (snapshot) => store.setAdapterSnapshot(snapshot) })
  await host.start()
  store.mergeSources({ transcripts: transcripts.getStatus(), hooks: { status: 'live', events: hooks.getStats().events }, adapters: host.statuses() })
  store.tickNow()
  const result = store.getWorld()
  adapterStatuses = host.statuses()
  host.stop()
  transcripts.stop()
  hooks.stop()
  store.stop()
  return result
}

beforeAll(async () => {
  // A copy, so that the config file's mode is ours whatever the checkout's umask was. The day's
  // config names the stand-in claude beside it (../../bin/claude), so `bin/` comes along.
  root = await mkdtemp(join(tmpdir(), 'cubiclark-day-'))
  await cp(DAY, join(root, 'day'), { recursive: true })
  await cp(fileURLToPath(new URL('./fixtures/bin', import.meta.url)), join(root, 'bin'), { recursive: true })
  await chmod(join(root, 'day', 'state', 'config.json'), 0o600)
  world = await build()
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const agent = (id: string) => world.agents[id]

describe('the fixture day', () => {
  test('the clock stops at the newest record', () => {
    expect(world.clock).toBe(new Date(END_MS).toISOString())
  })

  test('five tasks; three of them mid-flight with live agents', () => {
    expect(Object.fromEntries(Object.entries(world.tasks).map(([id, task]) => [id, task.phase]))).toEqual({
      'demo-login': 'building',
      'shop-cart': 'planning',
      'demo-search': 'review',
      'shop-export': 'blocked',
      'demo-docs': 'done',
    })
    expect(agent(S.s2)).toMatchObject({ taskId: 'demo-login', state: 'editing' })
    expect(agent(S.s3)).toMatchObject({ taskId: 'shop-cart' })
    expect(agent(S.s4)).toMatchObject({ taskId: 'demo-search', state: 'waiting_user' })
  })

  test('demo-login: dispatched on opus, forked to sonnet, and the fork is the live session', () => {
    const task = world.tasks['demo-login']
    expect(task?.timeline.map((e) => [e.kind, e.model])).toEqual([
      ['dispatched', 'claude-opus-5-5'],
      ['forked', 'claude-sonnet-5-5'],
    ])
    expect(task?.currentSessionId).toBe(S.s2)
    expect(agent(S.s2)).toMatchObject({ role: 'builder', kind: 'background', effort: 'high', model: 'claude-sonnet-5-5' })
  })

  test('the orchestrator is found by its cwd and is running', () => {
    expect(agent(S.s0)).toMatchObject({ role: 'orchestrator', state: 'running' })
  })

  test('the planning room fills from a task in planning; the reviewer is in the review corner', () => {
    const room = (id: string): string | undefined => layout(world).placements.find((p) => p.agentId === id)?.room
    expect(room(S.s3)).toBe('planning')
    expect(room(S.s0)).toBe('manager')
    expect(room(S.s4)).toBe('review')
    expect(room(S.s2)).toBe('floor')
    expect(agent(S.s3)?.role).toBe('planner')
    expect(agent(S.s4)?.role).toBe('reviewer')
  })

  test('the CLI says the planner is waiting on a permission prompt, and the World believes it', () => {
    expect(agent(S.s3)).toMatchObject({ state: 'waiting_permission', stateEvidence: 'observed' })
    expect(agent(S.s3)?.cli).toMatchObject({ state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' })
  })

  test('the builder has a live Explore helper beside it', () => {
    const helper = Object.values(world.agents).find((a) => a.parentId === S.s2)
    expect(helper).toMatchObject({ kind: 'subagent', label: 'Explore', state: 'searching' })
    expect(helper?.id).toContain(DAY_HELPER.slice(2))
  })

  test('two sessions were closed by hooks and are on the board; the ad hoc one waits', () => {
    expect(agent(S.s1)?.state).toBe('ended')
    expect(agent(S.s5)?.state).toBe('ended')
    expect(agent(S.s6)).toMatchObject({ state: 'waiting_user', model: 'claude-haiku-4-5' })
    expect(agent(S.s6)?.taskId).toBeUndefined()
  })

  test('nobody is stuck, so nobody looks like they are', () => {
    expect(Object.values(world.agents).filter((a) => a.state === 'stuck')).toEqual([])
  })

  test('the quota at the end of the day, and the reset rule through the day', () => {
    expect(world.quota).toMatchObject({ p5h: 62, p7d: 40, resets5h: '2026-01-16T19:00:00.000Z' })
    const samples = [
      { ts: '2026-01-16T12:30:00.000Z', p5h: 75, p7d: 33, resets5h: '2026-01-16T13:00:00.000Z' },
      { ts: '2026-01-16T14:00:00.000Z', p5h: 3, p7d: 34, resets5h: '2026-01-16T19:00:00.000Z' },
    ]
    expect(quotaAt(samples, Date.parse('2026-01-16T12:45:00Z'))?.p5h).toBe(75)
    expect(quotaAt(samples, Date.parse('2026-01-16T13:30:00Z'))?.p5h).toBe(0) // reset at 13:00, no newer sample
    expect(quotaAt(samples, Date.parse('2026-01-16T14:10:00Z'))?.p5h).toBe(3)
  })

  test('every adapter is live, and the status bar says so', () => {
    expect(adapterStatuses.map((s) => [s.id, s.status])).toEqual([
      ['task-folders', 'live'],
      ['quota-samples', 'live'],
      ['claude-agents', 'live'],
    ])
    const bar = Object.fromEntries(statusBar(world).map((s) => [s.id, s.text]))
    expect(bar.sources).toBe('transcripts live · hooks live · tasks 5 · quota · claude agents')
    expect(bar.quota).toBe('5h 62% · 7d 40%')
    expect(bar.permission).toBe('permission 1')
  })

  test('the session log has lines for the day, and nothing but names in them', () => {
    expect(world.log.length).toBeGreaterThan(20)
    expect(JSON.stringify(world.log)).not.toContain('/home/')
  })
})
