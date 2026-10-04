import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentEvent } from '../src/core/types.js'
import { Store } from '../src/server/store.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Store', () => {
  test('notifications are throttled: rapid changes coalesce into one later notification', () => {
    const store = new Store({ nowMs: () => Date.now(), transcriptsRoot: '/root', throttleMs: 100 })
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })

    store.applyEvents([{ t: 'prompt', ts: 't0', agentId: 'a1' }])
    expect(notifications).toBe(1) // the store's first-ever change notifies immediately

    store.applyEvents([{ t: 'prompt', ts: 't1', agentId: 'a1' }])
    store.applyEvents([{ t: 'prompt', ts: 't2', agentId: 'a1' }])
    expect(notifications).toBe(1) // both coalesced behind the throttle

    vi.advanceTimersByTime(100)
    expect(notifications).toBe(2) // the coalesced trailing notification fires exactly once

    store.stop()
  })

  test('tick applies with the injected clock, not wall time', () => {
    let clock = Date.parse('2026-01-15T10:00:00.000Z')
    const t0 = new Date(clock).toISOString()
    const store = new Store({ nowMs: () => clock, transcriptsRoot: '/root' })

    store.applyEvents([
      { t: 'agent_meta', ts: t0, agentId: 'a1', kind: 'session' },
      // Read is permission-exempt, so this proves stuck detection specifically, without also
      // tripping the inferred-permission-wait rule tested separately in tick.test.ts.
      { t: 'tool_start', ts: t0, agentId: 'a1', toolUseId: 'x', name: 'Read', target: 'a.ts' },
    ])
    expect(store.getWorld().agents.a1?.state).toBe('reading')

    clock += 11 * 60 * 1000 // 11 minutes later, entirely by the injected clock
    store.tickNow()

    expect(store.getWorld().agents.a1?.state).toBe('stuck')
    expect(store.getWorld().clock).toBe(new Date(clock).toISOString())

    store.stop()
  })

  test('an unsubscribed callback receives no further notifications', () => {
    const store = new Store({ nowMs: () => Date.now(), transcriptsRoot: '/root' })
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    store.applyEvents([{ t: 'prompt', ts: 't0', agentId: 'a1' }])
    expect(notifications).toBe(1)

    unsubscribe()
    store.applyEvents([{ t: 'prompt', ts: 't1', agentId: 'a1' }])
    vi.advanceTimersByTime(1000)
    expect(notifications).toBe(1)

    store.stop()
  })
})

// S1-5: one bad event, tick or subscriber never stops the store.
describe('Store error boundary', () => {
  const poison = (): never => {
    throw new Error('reducer bug')
  }

  test('an event that makes the reducer throw is skipped and counted; the next one is applied', () => {
    const store = new Store({ nowMs: () => Date.now(), transcriptsRoot: '/root' })
    const bad = { t: 'prompt', ts: 't0', get agentId(): string { return poison() } } as unknown as AgentEvent
    store.applyEvents([bad, { t: 'prompt', ts: 't1', agentId: 'good' }])
    expect(store.getWorld().agents.good?.counters.prompts).toBe(1)
    expect(store.getWorld().diagnostics.sourceErrors).toContain('an event could not be applied and was skipped')
    store.applyTranscriptEvents([bad, { t: 'prompt', ts: 't2', agentId: 'good' }])
    expect(store.getWorld().agents.good?.counters.prompts).toBe(2)
    store.stop()
  })

  test('a clock tick that throws leaves the World and the timer alone', () => {
    let clock = Date.parse('2026-01-15T10:00:00.000Z')
    let broken = true
    const store = new Store({
      nowMs: () => clock,
      transcriptsRoot: '/root',
      get stuckAfterMs(): number {
        if (broken) throw new Error('bad option')
        return 600_000
      },
    })
    expect(() => store.tickNow()).not.toThrow()
    expect(store.getWorld().diagnostics.sourceErrors).toContain('a clock tick failed and was skipped')
    broken = false
    clock += 1000
    store.tickNow()
    expect(store.getWorld().clock).toBe(new Date(clock).toISOString())
    store.stop()
  })

  test('a subscriber that throws is dropped and the others still hear', () => {
    const store = new Store({ nowMs: () => Date.now(), transcriptsRoot: '/root', throttleMs: 0 })
    let heard = 0
    store.subscribe(() => {
      throw new Error('socket closed')
    })
    store.subscribe(() => {
      heard += 1
    })
    expect(() => store.applyEvents([{ t: 'prompt', ts: 't0', agentId: 'a1' }])).not.toThrow()
    expect(heard).toBe(1)
    store.applyEvents([{ t: 'prompt', ts: 't1', agentId: 'a1' }])
    expect(heard).toBe(2)
    store.stop()
  })
})
