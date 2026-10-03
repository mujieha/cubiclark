// The terminal session with fake streams: what is written, in what order, and that the terminal comes
// back on every way out.

import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { CLEAR, ENTER, HOME, LEAVE, TerminalSession, type TerminalSignal } from '../src/tui/terminal.js'

class FakeOut extends EventEmitter {
  columns = 100
  rows = 30
  isTTY = true
  written: string[] = []
  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }
}

class FakeIn extends EventEmitter {
  isTTY = true
  raw: boolean[] = []
  resumed = 0
  paused = 0
  setRawMode(mode: boolean): void {
    this.raw.push(mode)
  }
  resume(): void {
    this.resumed++
  }
  pause(): void {
    this.paused++
  }
}

function setup() {
  const out = new FakeOut()
  const input = new FakeIn()
  const proc = new EventEmitter()
  const before = {
    keypress: input.listenerCount('keypress'),
    resize: out.listenerCount('resize'),
    SIGINT: proc.listenerCount('SIGINT'),
    SIGTERM: proc.listenerCount('SIGTERM'),
    SIGHUP: proc.listenerCount('SIGHUP'),
    exit: proc.listenerCount('exit'),
  }
  const keys: string[] = []
  const signals: TerminalSignal[] = []
  const onResize = vi.fn()
  const session = new TerminalSession({ out, input, proc, emitKeypress: vi.fn() })
  session.start({ onKey: (key) => keys.push(key), onResize, onSignal: (signal) => signals.push(signal) })
  const listeners = () => ({
    keypress: input.listenerCount('keypress'),
    resize: out.listenerCount('resize'),
    SIGINT: proc.listenerCount('SIGINT'),
    SIGTERM: proc.listenerCount('SIGTERM'),
    SIGHUP: proc.listenerCount('SIGHUP'),
    exit: proc.listenerCount('exit'),
  })
  return { out, input, proc, session, keys, signals, onResize, before, listeners }
}

describe('the sequences', () => {
  test('are exactly the four fixed ones', () => {
    expect(ENTER).toBe('\x1b[?1049h\x1b[?25l\x1b[?7l')
    expect(LEAVE).toBe('\x1b[?7h\x1b[?25h\x1b[?1049l')
    expect(HOME).toBe('\x1b[H')
    expect(CLEAR).toBe('\x1b[2J')
  })

  test('autowrap is switched off on enter and back on first on leave (R2-4)', () => {
    // A line a terminal draws wider than we counted is then cut at the edge, never wrapped onto the next
    // row, which would push every later line down and scroll the top of the frame away.
    expect(ENTER.endsWith('\x1b[?7l')).toBe(true)
    expect(LEAVE.startsWith('\x1b[?7h')).toBe(true)
  })
})

describe('start', () => {
  test('writes the alternate screen and the hidden cursor first, and takes the keys raw', () => {
    const { out, input } = setup()
    expect(out.written).toEqual([ENTER])
    expect(input.raw).toEqual([true])
    expect(input.resumed).toBe(1)
  })

  test('a second start does nothing', () => {
    const { out, session, keys } = setup()
    session.start({ onKey: (key) => keys.push(key), onResize: vi.fn(), onSignal: vi.fn() })
    expect(out.written).toEqual([ENTER])
  })
})

describe('draw', () => {
  test('goes home and writes the whole frame in one piece', () => {
    const { out, session } = setup()
    session.draw(['ab', 'cd'])
    expect(out.written.at(-1)).toBe(`${HOME}ab\r\ncd`)
  })

  test('after a resize the next frame clears first, once, and the handler hears of it', () => {
    const { out, session, onResize } = setup()
    out.emit('resize')
    expect(onResize).toHaveBeenCalledTimes(1)
    session.draw(['x'])
    expect(out.written.at(-1)).toBe(`${CLEAR}${HOME}x`)
    session.draw(['y'])
    expect(out.written.at(-1)).toBe(`${HOME}y`)
  })

  test('its size is the terminal\'s', () => {
    expect(setup().session.size()).toEqual({ cols: 100, rows: 30 })
  })
})

describe('keys', () => {
  test('a known key reaches the handler, an unknown one does not', () => {
    const { input, keys } = setup()
    input.emit('keypress', 'q', { name: 'q' })
    input.emit('keypress', undefined, { name: 'tab', shift: true })
    input.emit('keypress', 'x', { name: 'x' })
    expect(keys).toEqual(['quit', 'backtab'])
  })
})

describe('getting the terminal back', () => {
  test.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('%s: leaves, turns raw mode off, pauses, then tells the handler', (signal) => {
    const { out, input, proc, signals, before, listeners } = setup()
    proc.emit(signal)
    expect(out.written.at(-1)).toBe(LEAVE)
    expect(input.raw).toEqual([true, false])
    expect(input.paused).toBe(1)
    expect(signals).toEqual([signal])
    expect(listeners()).toEqual(before)
  })

  test('a normal exit leaves too, and tells no handler', () => {
    const { out, proc, signals } = setup()
    proc.emit('exit')
    expect(out.written.at(-1)).toBe(LEAVE)
    expect(signals).toEqual([])
  })

  test('stop twice writes LEAVE once, and draws after it write nothing', () => {
    const { out, session, before, listeners } = setup()
    session.stop()
    session.stop()
    expect(out.written.filter((w) => w === LEAVE)).toHaveLength(1)
    session.draw(['late'])
    expect(out.written.filter((w) => w.includes('late'))).toHaveLength(0)
    expect(listeners()).toEqual(before)
  })

  test('a signal after a stop does nothing', () => {
    const { out, proc, session, signals } = setup()
    session.stop()
    const writes = out.written.length
    proc.emit('SIGINT')
    expect(out.written).toHaveLength(writes)
    expect(signals).toEqual([])
  })
})
