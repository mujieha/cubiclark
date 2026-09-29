import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
