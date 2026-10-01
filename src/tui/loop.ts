// Asks for a frame as often as things change, draws at most ten a second (cubiclark-tui). Requests that
// arrive while a frame is waiting are folded into it, and the last request is always followed by a
// draw, so the screen never ends up showing something older than the World.

import { MIN_FRAME_MS, drawDelay } from '../core/tui/gate.js'

export interface SchedulerDeps {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export class FrameScheduler {
  private lastDrawMs: number | undefined
  private timer: unknown
  private waiting = false
  private stopped = false
  /** Frames drawn so far. */
  draws = 0

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly draw: () => void,
    private readonly minMs: number = MIN_FRAME_MS
  ) {}

  /** The screen is out of date: draw it now, or as soon as the rate allows. */
  request(): void {
    if (this.stopped || this.waiting) return
    const delay = drawDelay(this.lastDrawMs, this.deps.now(), this.minMs)
    if (delay === 0) {
      this.run()
      return
    }
    this.waiting = true
    this.timer = this.deps.setTimeout(() => {
      this.waiting = false
      this.timer = undefined
      this.run()
    }, delay)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.deps.clearTimeout(this.timer)
    this.timer = undefined
    this.waiting = false
  }

  private run(): void {
    if (this.stopped) return
    this.lastDrawMs = this.deps.now()
    this.draws += 1
    this.draw()
  }
}
