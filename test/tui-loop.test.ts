// The frame scheduler: at most ten frames a second, and the last request is never lost.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FrameScheduler } from '../src/tui/loop.js'

const deps = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('FrameScheduler', () => {
  test('the first request draws at once', () => {
    let drawn = 0
    const scheduler = new FrameScheduler(deps, () => drawn++)
    scheduler.request()
    expect(drawn).toBe(1)
  })

  test('a request every 5 ms for a second draws at most ten times, and nearly that many', () => {
    const start = Date.now()
    const times: number[] = []
    const scheduler = new FrameScheduler(deps, () => times.push(Date.now() - start))
    for (let t = 0; t < 1000; t += 5) {
      scheduler.request()
      vi.advanceTimersByTime(5)
    }
    // never closer than a hundred milliseconds, so ten in any second
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(100)
    expect(times.filter((t) => t < 1000).length).toBeLessThanOrEqual(10)
    expect(times.length).toBeGreaterThanOrEqual(9)
    expect(scheduler.draws).toBe(times.length)
  })

  test('a request just after a frame is drawn within a hundred milliseconds', () => {
    let drawnAt: number[] = []
    const scheduler = new FrameScheduler(deps, () => drawnAt.push(Date.now()))
    scheduler.request()
    vi.advanceTimersByTime(1)
    scheduler.request()
    expect(drawnAt).toHaveLength(1)
    vi.advanceTimersByTime(100)
    expect(drawnAt).toHaveLength(2)
    expect((drawnAt[1] as number) - (drawnAt[0] as number)).toBe(100)
    drawnAt = []
  })

  test('requests while a frame waits are folded into it', () => {
    let drawn = 0
    const scheduler = new FrameScheduler(deps, () => drawn++)
    scheduler.request()
    vi.advanceTimersByTime(10)
    for (let i = 0; i < 20; i++) scheduler.request()
    vi.advanceTimersByTime(500)
    expect(drawn).toBe(2)
  })

  test('stop cancels the frame that is waiting and ignores later requests', () => {
    let drawn = 0
    const scheduler = new FrameScheduler(deps, () => drawn++)
    scheduler.request()
    vi.advanceTimersByTime(10)
    scheduler.request()
    scheduler.stop()
    vi.advanceTimersByTime(1000)
    scheduler.request()
    expect(drawn).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
