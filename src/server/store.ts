// Holds the current World, applies AgentEvents through the reducer, ticks it on a timer with an
// injected clock, and notifies subscribers (the SSE layer) on a throttle — so a burst of
// transcript lines produces at most one push every `throttleMs`, not one per line.

import { reduce } from '../core/reducer.js'
import { tick } from '../core/tick.js'
import type { AgentEvent, SourcesStatus, World } from '../core/types.js'
import { emptyWorld } from '../core/world.js'

export interface StoreOptions {
  nowMs: () => number
  transcriptsRoot: string
  /** How often start() re-applies tick(). Default 1000ms. */
  tickIntervalMs?: number
  /** Minimum gap between subscriber notifications. Default 250ms (design §8's SSE throttle). */
  throttleMs?: number
  stuckAfterMs?: number
  permissionAfterMs?: number
}

export type Subscriber = (world: World) => void

export class Store {
  private world: World
  private readonly subscribers = new Set<Subscriber>()
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private notifyTimer: ReturnType<typeof setTimeout> | undefined
  private lastNotifyMs = -Infinity
  private notifyPending = false

  constructor(private readonly opts: StoreOptions) {
    this.world = emptyWorld(new Date(opts.nowMs()).toISOString(), opts.transcriptsRoot)
  }

  getWorld(): World {
    return this.world
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  applyEvents(events: AgentEvent[]): void {
    if (events.length === 0) return
    let next = this.world
    for (const event of events) next = reduce(next, event)
    this.world = next
    this.scheduleNotify()
  }

  /** Folds the transcript source's own status (files found, live/unreadable, ...) into the
   * World directly — this is observed, not event-sourced, so it bypasses the reducer. */
  mergeSources(sources: SourcesStatus): void {
    this.world = { ...this.world, sources }
    this.scheduleNotify()
  }

  tickNow(): void {
    const nowMs = this.opts.nowMs()
    const ticked = tick(this.world, nowMs, {
      stuckAfterMs: this.opts.stuckAfterMs,
      permissionAfterMs: this.opts.permissionAfterMs,
    })
    this.world = { ...ticked, clock: new Date(nowMs).toISOString() }
    this.scheduleNotify()
  }

  start(): void {
    this.tickNow()
    this.tickTimer = setInterval(() => this.tickNow(), this.opts.tickIntervalMs ?? 1000)
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.tickTimer = undefined
    this.notifyTimer = undefined
  }

  private scheduleNotify(): void {
    const throttleMs = this.opts.throttleMs ?? 250
    const elapsed = Date.now() - this.lastNotifyMs
    if (elapsed >= throttleMs) {
      this.notifySubscribers()
      return
    }
    if (this.notifyPending) return
    this.notifyPending = true
    this.notifyTimer = setTimeout(() => {
      this.notifyPending = false
      this.notifySubscribers()
    }, throttleMs - elapsed)
  }

  private notifySubscribers(): void {
    this.lastNotifyMs = Date.now()
    for (const fn of this.subscribers) fn(this.world)
  }
}
