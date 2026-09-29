// The adapter host with fake adapters and fake timers: detect, schedule, merge, isolate failures.

import { describe, expect, test } from 'vitest'
import type { AdapterEnv, AdapterSnapshot, OrchestrationAdapter } from '../src/core/adapters/types.js'
import { AdapterHost } from '../src/server/adapters/host.js'

const env: AdapterEnv = { nowMs: () => Date.parse('2026-01-16T10:00:00Z'), home: '/home/user' }
const empty = (patch: Partial<AdapterSnapshot> = {}): AdapterSnapshot => ({ ...patch, diagnostics: { unparsed: 0, errors: [] } })

class FakeTimers {
  private next = 1
  readonly pending = new Map<number, { fn: () => void; ms: number }>()
  setTimer = (fn: () => void, ms: number): number => {
    const id = this.next++
    this.pending.set(id, { fn, ms })
    return id
  }
  clearTimer = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }
  /** Runs every pending timer whose delay is at most `ms`, once each. */
  async fire(ms: number): Promise<void> {
    for (const [id, timer] of [...this.pending]) {
      if (timer.ms > ms) continue
      this.pending.delete(id)
      timer.fn()
    }
    await settle()
  }
}

/** Lets promise chains and the microtask queue drain. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

interface FakeOptions {
  id: string
  pollMs?: number
  detected?: boolean | (() => boolean)
  snapshot?: () => Promise<AdapterSnapshot>
  describe?: OrchestrationAdapter['describe']
  withWatch?: boolean
}

class FakeAdapter implements OrchestrationAdapter {
  readonly id: string
  readonly pollMs: number
  snapshots = 0
  detects = 0
  watchers: (() => void)[] = []
  unwatched = 0
  describe: OrchestrationAdapter['describe']
  watch: OrchestrationAdapter['watch']
  constructor(private readonly o: FakeOptions) {
    this.id = o.id
    this.pollMs = o.pollMs ?? 1000
    this.describe = o.describe
    if (o.withWatch) {
      this.watch = (onChange) => {
        this.watchers.push(onChange)
        return () => {
          this.unwatched += 1
        }
      }
    }
  }
  async detect(): Promise<boolean> {
    this.detects += 1
    const detected = this.o.detected ?? true
    return typeof detected === 'function' ? detected() : detected
  }
  async snapshot(): Promise<AdapterSnapshot> {
    this.snapshots += 1
    return this.o.snapshot ? this.o.snapshot() : empty()
  }
}

function host(adapters: OrchestrationAdapter[], extra: { configWarnings?: string[] } = {}) {
  const timers = new FakeTimers()
  const seen: AdapterSnapshot[] = []
  const h = new AdapterHost({ adapters, env, onSnapshot: (s) => seen.push(s), setTimer: timers.setTimer, clearTimer: timers.clearTimer, ...extra })
  return { h, timers, seen }
}

describe('start', () => {
  test('detects every adapter, snapshots the detected ones once and hands over one merged snapshot', async () => {
    const a = new FakeAdapter({ id: 'task-folders', snapshot: async () => empty({ tasks: [{ id: 't1', timeline: [] }] }) })
    const b = new FakeAdapter({ id: 'quota-samples', snapshot: async () => empty({ quotaSamples: [{ ts: '2026-01-16T09:00:00.000Z', p5h: 1, p7d: 2 }] }) })
    const { h, seen } = host([a, b])
    await h.start()
    expect(a.snapshots).toBe(1)
    expect(b.snapshots).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.tasks?.map((t) => t.id)).toEqual(['t1'])
    expect(seen[0]?.quotaSamples).toHaveLength(1)
    h.stop()
  })

  test('an adapter whose source is absent is missing, is not snapshotted, and is looked for again after 30 s', async () => {
    let present = false
    const a = new FakeAdapter({ id: 'quota-samples', detected: () => present, snapshot: async () => empty({ quotaSamples: [{ ts: '2026-01-16T09:00:00.000Z', p5h: 5, p7d: 5 }] }) })
    const { h, timers, seen } = host([a])
    await h.start()
    expect(a.snapshots).toBe(0)
    expect(h.statuses().find((s) => s.id === 'quota-samples')).toMatchObject({ status: 'missing', detail: 'no samples file found' })

    await timers.fire(29_999)
    expect(a.detects).toBe(1)
    present = true
    await timers.fire(30_000)
    expect(a.detects).toBe(2)
    expect(a.snapshots).toBe(1)
    expect(h.statuses().find((s) => s.id === 'quota-samples')?.status).toBe('live')
    expect(seen[seen.length - 1]?.quotaSamples).toHaveLength(1)
    h.stop()
  })

  test('a detect() that throws counts as absent', async () => {
    const a = new FakeAdapter({ id: 'task-folders' })
    a.detect = async () => {
      throw new Error('boom')
    }
    const { h } = host([a])
    await expect(h.start()).resolves.toBeUndefined()
    expect(h.statuses()[0]?.status).toBe('missing')
    h.stop()
  })
})

describe('scheduling', () => {
  test('each adapter is asked again at its own pollMs', async () => {
    const a = new FakeAdapter({ id: 'task-folders', pollMs: 5000 })
    const b = new FakeAdapter({ id: 'quota-samples', pollMs: 10_000 })
    const { h, timers } = host([a, b])
    await h.start()
    await timers.fire(5000)
    expect(a.snapshots).toBe(2)
    expect(b.snapshots).toBe(1)
    await timers.fire(10_000)
    expect(b.snapshots).toBe(2)
    h.stop()
  })

  test('a watch callback refreshes just that adapter', async () => {
    const a = new FakeAdapter({ id: 'task-folders', withWatch: true })
    const b = new FakeAdapter({ id: 'quota-samples' })
    const { h, seen } = host([a, b])
    await h.start()
    a.watchers[0]?.()
    await settle()
    expect(a.snapshots).toBe(2)
    expect(b.snapshots).toBe(1)
    expect(seen.length).toBeGreaterThan(1)
    h.stop()
  })

  test('overlapping refresh requests collapse into one extra run', async () => {
    let release: () => void = () => undefined
    let calls = 0
    const a = new FakeAdapter({
      id: 'task-folders',
      snapshot: () => {
        calls += 1
        return calls === 2 ? new Promise<AdapterSnapshot>((resolve) => { release = () => resolve(empty()) }) : Promise.resolve(empty())
      },
    })
    const { h } = host([a])
    await h.start() // call 1
    const first = h.refresh('task-folders') // call 2, held open
    await settle()
    void h.refresh('task-folders')
    void h.refresh('task-folders')
    void h.refresh('task-folders')
    await settle()
    expect(calls).toBe(2)
    release()
    await first
    await settle()
    expect(calls).toBe(3) // one more pass, not three
    h.stop()
  })
})

describe('a failing adapter does not disturb the others', () => {
  test('a rejected snapshot keeps that adapter\'s previous part and marks it failing', async () => {
    let fail = false
    const a = new FakeAdapter({
      id: 'task-folders',
      snapshot: async () => {
        if (fail) throw new Error('cannot list the root')
        return empty({ tasks: [{ id: 'kept', timeline: [] }] })
      },
    })
    const b = new FakeAdapter({ id: 'quota-samples', snapshot: async () => empty({ quotaSamples: [] }) })
    const { h, timers, seen } = host([a, b])
    await h.start()
    fail = true
    await timers.fire(1000)
    const statuses = h.statuses()
    expect(statuses.find((s) => s.id === 'task-folders')).toMatchObject({ status: 'failing', detail: 'cannot list the root' })
    expect(statuses.find((s) => s.id === 'quota-samples')?.status).toBe('live')
    expect(seen[seen.length - 1]?.tasks?.map((t) => t.id)).toEqual(['kept'])
    // and it recovers on the next round
    fail = false
    await timers.fire(1000)
    expect(h.statuses().find((s) => s.id === 'task-folders')?.status).toBe('live')
    h.stop()
  })
})

describe('statuses', () => {
  test('one per known id; an adapter that is not configured is off', async () => {
    const { h } = host([new FakeAdapter({ id: 'quota-samples' })])
    await h.start()
    expect(h.statuses().map((s) => [s.id, s.status])).toEqual([
      ['task-folders', 'off'],
      ['quota-samples', 'live'],
      ['claude-agents', 'off'],
    ])
    expect(h.statuses()[0]?.detail).toBe('not configured')
    h.stop()
  })

  test('a live adapter describes itself at the moment asked, and can report itself failing', async () => {
    let failing = false
    const a = new FakeAdapter({ id: 'claude-agents', describe: (nowMs) => ({ detail: `at ${nowMs}`, failing }) })
    const { h } = host([a])
    await h.start()
    expect(h.statuses()[2]).toMatchObject({ status: 'live', detail: `at ${env.nowMs()}` })
    failing = true
    expect(h.statuses()[2]?.status).toBe('failing')
    h.stop()
  })

  test('a describe() that throws does not take the list down', async () => {
    const a = new FakeAdapter({
      id: 'task-folders',
      describe: () => {
        throw new Error('nope')
      },
    })
    const { h } = host([a])
    await h.start()
    expect(h.statuses()).toHaveLength(3)
    h.stop()
  })

  test('configuration warnings are shown beside the first adapter that is on', async () => {
    const { h } = host([new FakeAdapter({ id: 'quota-samples' })], { configWarnings: ['unknown key "x" ignored', 'second'] })
    await h.start()
    const statuses = h.statuses()
    expect(statuses[0]?.detail).toBe('not configured')
    expect(statuses[1]?.detail).toContain('config: unknown key "x" ignored (+1 more)')
    h.stop()
    const none = host([], { configWarnings: ['bad'] })
    await none.h.start()
    expect(none.h.statuses()[0]?.detail).toBe('not configured · config: bad')
  })
})

describe('stop', () => {
  test('clears every timer and unwatches; nothing runs afterwards', async () => {
    const a = new FakeAdapter({ id: 'task-folders', withWatch: true })
    const b = new FakeAdapter({ id: 'quota-samples', detected: false })
    const { h, timers, seen } = host([a, b])
    await h.start()
    expect(timers.pending.size).toBeGreaterThan(0)
    const before = seen.length
    h.stop()
    expect(timers.pending.size).toBe(0)
    expect(a.unwatched).toBe(1)
    await h.refresh()
    expect(a.snapshots).toBe(1)
    expect(seen.length).toBe(before)
  })
})
