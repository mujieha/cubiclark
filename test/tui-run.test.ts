// The two loops of `cubiclark tui` with fake streams, fake timers and a fake source of Worlds.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { stripSgr } from '../src/core/tui/line.js'
import type { World } from '../src/core/types.js'
import { TuiController } from '../src/tui/controller.js'
import { printFrames, runInteractive, type WorldSource } from '../src/tui/run.js'
import { ENTER, HOME, LEAVE, TerminalSession } from '../src/tui/terminal.js'
import { WORLD_FIXTURES } from '../scripts/world-fixture-lib.js'

const world = (WORLD_FIXTURES.rooms as () => World)()
const SIZE = { cols: 80, rows: 24 }
const controller = (): TuiController => new TuiController({ mascot: false, animate: false, color: false, unicode: true })

function fakeSource(initial: World): WorldSource & { push: () => void; listeners: number } {
  const listeners = new Set<(w: World) => void>()
  return {
    getWorld: () => initial,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    push: () => {
      for (const fn of [...listeners]) fn(initial)
    },
    get listeners() {
      return listeners.size
    },
  }
}

describe('printFrames', () => {
  test('writes each frame as 24 lines and a newline, a tenth of a second apart', async () => {
    const written: string[] = []
    const slept: number[] = []
    await printFrames(fakeSource(world), controller(), 3, SIZE, {
      write: (text) => {
        written.push(text)
        return Promise.resolve()
      },
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      },
      now: () => 0,
    })
    expect(written).toHaveLength(3)
    for (const text of written) {
      expect(text.endsWith('\n')).toBe(true)
      expect(text.slice(0, -1).split('\n')).toHaveLength(24)
    }
    expect(slept).toEqual([100, 100])
  })
})

describe('runInteractive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function start() {
    const out = Object.assign(new EventEmitter(), { columns: 80, rows: 24, isTTY: true, written: [] as string[], write(chunk: string) { this.written.push(chunk); return true } })
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn() })
    const proc = new EventEmitter()
    const source = fakeSource(world)
    const errors: string[] = []
    const session = new TerminalSession({ out, input, proc, emitKeypress: vi.fn() })
    const done = runInteractive({
      source,
      controller: controller(),
      session,
      sizeOf: () => SIZE,
      timers: {
        now: () => Date.now(),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        setInterval: (callback, ms) => setInterval(callback, ms),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      },
      now: () => Date.now(),
      proc,
      stderr: (text) => errors.push(text),
    })
    const frames = (): string[] => out.written.filter((w) => w.startsWith(HOME))
    const lastText = (): string => stripSgr(frames().at(-1) ?? '')
    return { out, input, proc, source, done, errors, frames, lastText }
  }

  test('enters the alternate screen, then draws the first frame from the top', () => {
    const { out, frames } = start()
    expect(out.written[0]).toBe(ENTER)
    expect(frames()).toHaveLength(1)
    expect((frames()[0] as string).split('\r\n')).toHaveLength(24)
  })

  test('a change of the World redraws within a tenth of a second', () => {
    const { source, frames } = start()
    vi.advanceTimersByTime(10)
    source.push()
    expect(frames()).toHaveLength(1)
    vi.advanceTimersByTime(100)
    expect(frames()).toHaveLength(2)
  })

  test('fifty changes in 200 ms make at most three frames', () => {
    const { source, frames } = start()
    for (let i = 0; i < 50; i++) {
      source.push()
      vi.advanceTimersByTime(4)
    }
    expect(frames().length).toBeLessThanOrEqual(3)
  })

  test('Tab moves the focus and l takes the office away, on the next frame', () => {
    const { input, frames, lastText } = start()
    expect(lastText()).toContain('Office ·')
    input.emit('keypress', undefined, { name: 'tab' })
    vi.advanceTimersByTime(100)
    expect(lastText()).toContain('[Log]')
    input.emit('keypress', 'l', { name: 'l' })
    vi.advanceTimersByTime(100)
    expect(lastText()).not.toContain('Office ·')
    expect(frames().length).toBeGreaterThanOrEqual(3)
  })

  test('q ends with 0, the terminal given back, and nothing left running', async () => {
    const { out, input, source, done } = start()
    input.emit('keypress', 'q', { name: 'q' })
    await expect(done).resolves.toBe(0)
    expect(out.written.at(-1)).toBe(LEAVE)
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(source.listeners).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('SIGINT ends with 130 and the terminal given back', async () => {
    const { out, proc, done } = start()
    proc.emit('SIGINT')
    await expect(done).resolves.toBe(130)
    expect(out.written.at(-1)).toBe(LEAVE)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('SIGTERM is 143 and SIGHUP 129', async () => {
    const term = start()
    term.proc.emit('SIGTERM')
    await expect(term.done).resolves.toBe(143)
    const hup = start()
    hup.proc.emit('SIGHUP')
    await expect(hup.done).resolves.toBe(129)
  })

  test('an uncaught exception ends with 1 after the terminal is back, saying only its name', async () => {
    const { out, proc, done, errors } = start()
    proc.emit('uncaughtException', new TypeError('secret path /x/y'))
    await expect(done).resolves.toBe(1)
    expect(out.written.at(-1)).toBe(LEAVE)
    expect(errors.join('')).toContain('TypeError')
    expect(errors.join('')).not.toContain('secret')
  })

  test('an unhandled rejection is dropped and the screen carries on', () => {
    const { proc, frames } = start()
    proc.emit('unhandledRejection', new Error('x'))
    expect(frames()).toHaveLength(1)
  })
})
