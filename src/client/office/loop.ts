// The frame loop (design §7: "30 fps cap, pause when the tab is hidden"), over an injected host so
// it needs no browser to test. In continuous mode a tick draws only when a frame is due, which is
// exactly 30 per second on a 60 Hz or a 120 Hz display; in on-demand mode (reduced motion) nothing
// is drawn until the world changes and someone asks.

export interface LoopHost {
  raf: (callback: (timeMs: number) => void) => number
  cancelRaf: (id: number) => void
  /** A monotonic clock in ms, used to time a draw. */
  now: () => number
  isHidden: () => boolean
  /** Calls back when the tab is hidden or shown; returns how to stop listening. */
  onVisibilityChange: (callback: () => void) => () => void
}

export const FRAME_MS = 1000 / 30
/** A tick this close to a frame boundary counts as due: rAF timestamps jitter by a millisecond or two. */
const DUE_SLACK_MS = 2
const WINDOW = 90

export type LoopMode = 'continuous' | 'on-demand'

export class FrameLoop {
  private mode: LoopMode = 'continuous'
  private running = false
  private rafId: number | undefined
  private lastDrawMs = Number.NEGATIVE_INFINITY
  private wanted = false
  private drawn = 0
  private readonly stamps: number[] = []
  private readonly costs: number[] = []
  private stopWatching: (() => void) | undefined

  constructor(
    private readonly host: LoopHost,
    private readonly draw: (timeMs: number) => void
  ) {}

  /** How many frames have been drawn so far. */
  get frames(): number {
    return this.drawn
  }

  setMode(mode: LoopMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.cancel()
    // Entering on-demand mode draws one still frame, so the picture matches the new mode.
    this.wanted = mode === 'on-demand'
    this.schedule()
  }

  /** Asks for one frame. Continuous mode draws every frame anyway; on-demand mode draws on this. */
  requestDraw(): void {
    this.wanted = true
    this.schedule()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopWatching = this.host.onVisibilityChange(() => this.schedule())
    this.schedule()
  }

  stop(): void {
    this.running = false
    this.cancel()
    this.stopWatching?.()
    this.stopWatching = undefined
  }

  /** Frames per second over the last 90 drawn frames, from their rAF timestamps, rounded. */
  fps(): number {
    if (this.stamps.length < 2) return 0
    const first = this.stamps[0] as number
    const last = this.stamps[this.stamps.length - 1] as number
    return last === first ? 0 : Math.round(((this.stamps.length - 1) * 1000) / (last - first))
  }

  /** The 95th-percentile cost of a draw over the last 90 frames, in ms. */
  drawP95(): number {
    if (this.costs.length === 0) return 0
    const sorted = [...this.costs].sort((a, b) => a - b)
    return sorted[Math.ceil(sorted.length * 0.95) - 1] as number
  }

  private schedule(): void {
    if (!this.running || this.rafId !== undefined || this.host.isHidden()) return
    if (this.mode === 'on-demand' && !this.wanted) return
    this.rafId = this.host.raf((timeMs) => this.tick(timeMs))
  }

  private cancel(): void {
    if (this.rafId === undefined) return
    this.host.cancelRaf(this.rafId)
    this.rafId = undefined
  }

  private tick(timeMs: number): void {
    this.rafId = undefined
    if (!this.running || this.host.isHidden()) return
    // Cleared before drawing, so a request made from inside the draw is not lost.
    const requested = this.wanted
    this.wanted = false
    if (this.mode === 'continuous') {
      if (timeMs - this.lastDrawMs >= FRAME_MS - DUE_SLACK_MS) this.drawFrame(timeMs)
    } else if (requested) {
      this.drawFrame(timeMs)
    }
    this.schedule()
  }

  private drawFrame(timeMs: number): void {
    const before = this.host.now()
    this.draw(timeMs)
    this.lastDrawMs = timeMs
    this.drawn++
    this.stamps.push(timeMs)
    this.costs.push(this.host.now() - before)
    if (this.stamps.length > WINDOW) this.stamps.shift()
    if (this.costs.length > WINDOW) this.costs.shift()
  }
}

/** The browser's host: rAF, performance.now and the page's visibility. */
export function browserHost(): LoopHost {
  return {
    raf: (callback) => requestAnimationFrame(callback),
    cancelRaf: (id) => cancelAnimationFrame(id),
    now: () => performance.now(),
    isHidden: () => document.hidden,
    onVisibilityChange: (callback) => {
      document.addEventListener('visibilitychange', callback)
      return () => document.removeEventListener('visibilitychange', callback)
    },
  }
}
