// The terminal session of `cubiclark tui`: the alternate screen, a hidden cursor, raw keys, resizes,
// and the terminal put back on every way out (a key, a signal, an exception, a normal exit). The five
// control sequences below are the only ones this program ever writes besides colour (line.ts), and
// none of them contains text from the World. The streams are injected, so a test needs no terminal.

import { keyOf, type TuiKey } from '../core/tui/ui.js'

/** The alternate screen, then the cursor hidden. */
export const ENTER = '\x1b[?1049h\x1b[?25l'
/** The cursor back, then the main screen. */
export const LEAVE = '\x1b[?25h\x1b[?1049l'
/** The cursor to the top left: where every frame starts. */
export const HOME = '\x1b[H'
/** The whole screen cleared: once after a resize, so nothing of the old size is left. */
export const CLEAR = '\x1b[2J'

export interface TerminalOut {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
  columns?: number
  rows?: number
}

export interface TerminalIn {
  setRawMode?: (mode: boolean) => unknown
  resume(): unknown
  pause(): unknown
  on(event: 'keypress', listener: (str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined) => void): unknown
  off(event: 'keypress', listener: (str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined) => void): unknown
}

export interface TerminalProc {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}

export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'
const SIGNALS: readonly TerminalSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

export interface TerminalDeps {
  out: TerminalOut
  input: TerminalIn
  proc: TerminalProc
  /** `readline.emitKeypressEvents`: makes the input emit `keypress`. */
  emitKeypress: (input: TerminalIn) => void
}

export interface TerminalHandlers {
  onKey: (key: TuiKey) => void
  onResize: () => void
  onSignal: (signal: TerminalSignal) => void
}

export class TerminalSession {
  private active = false
  private clearNext = false
  private cleanup: (() => void)[] = []

  constructor(private readonly deps: TerminalDeps) {}

  start(handlers: TerminalHandlers): void {
    if (this.active) return
    const { out, input, proc } = this.deps
    this.active = true
    out.write(ENTER)

    this.deps.emitKeypress(input)
    input.setRawMode?.(true)
    input.resume()

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined): void => {
      const mapped = keyOf(str, key)
      if (mapped !== undefined) handlers.onKey(mapped)
    }
    input.on('keypress', onKeypress)
    this.cleanup.push(() => input.off('keypress', onKeypress))

    const onResize = (): void => {
      this.clearNext = true
      handlers.onResize()
    }
    out.on('resize', onResize)
    this.cleanup.push(() => out.off('resize', onResize))

    for (const signal of SIGNALS) {
      const onSignal = (): void => {
        this.stop()
        handlers.onSignal(signal)
      }
      proc.on(signal, onSignal)
      this.cleanup.push(() => proc.off(signal, onSignal))
    }
    // However the process ends, the terminal is given back.
    const onExit = (): void => this.stop()
    proc.on('exit', onExit)
    this.cleanup.push(() => proc.off('exit', onExit))
  }

  /** One frame, from the top left: all of it in one write. */
  draw(lines: readonly string[]): void {
    if (!this.active) return
    const clear = this.clearNext ? CLEAR : ''
    this.clearNext = false
    this.deps.out.write(`${clear}${HOME}${lines.join('\r\n')}`)
  }

  size(): { cols: number; rows: number } {
    const { columns, rows } = this.deps.out
    return { cols: columns !== undefined && columns > 0 ? columns : 80, rows: rows !== undefined && rows > 0 ? rows : 24 }
  }

  /** Puts the terminal back. Safe to call any number of times. */
  stop(): void {
    if (!this.active) return
    this.active = false
    const { out, input } = this.deps
    out.write(LEAVE)
    input.setRawMode?.(false)
    input.pause()
    for (const undo of this.cleanup.splice(0)) undo()
  }
}
