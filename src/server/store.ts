// Holds the current World, applies AgentEvents through the reducer, ticks it on a timer with an
// injected clock, and notifies subscribers (the SSE layer) on a throttle — so a burst of
// transcript lines produces at most one push every `throttleMs`, not one per line.

import { applyAdapters } from '../core/adapters/apply.js'
import type { AdapterSnapshot } from '../core/adapters/types.js'
import { gateTranscriptEvent } from '../core/merge.js'
import { reduce } from '../core/reducer.js'
import { tick } from '../core/tick.js'
import type { AgentEvent, ReplayInfo, SourcesStatus, World } from '../core/types.js'
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
  private adapterSnapshot: AdapterSnapshot | undefined
  private replayMode = false

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

  /** Events from the transcript source: each one first goes through the merge gate, judged
   * against the World as it stands at that moment, so an agent hooks already report on is not
   * driven twice. Hook events use applyEvents. */
  applyTranscriptEvents(events: AgentEvent[]): void {
    if (events.length === 0) return
    let next = this.world
    for (const event of events) {
      const gated = gateTranscriptEvent(next, event)
      if (gated) next = reduce(next, gated)
    }
    this.world = next
    this.scheduleNotify()
  }

  /** Folds the transcript source's own status (files found, live/unreadable, ...) into the
   * World directly — this is observed, not event-sourced, so it bypasses the reducer. */
  mergeSources(sources: SourcesStatus): void {
    this.world = { ...this.world, sources }
    this.scheduleNotify()
  }

  /** The latest combined snapshot of the orchestration adapters. It is re-applied on every tick,
   * so quota resets and replay's time cut follow the clock without another snapshot. */
  setAdapterSnapshot(snapshot: AdapterSnapshot): void {
    this.adapterSnapshot = snapshot
    this.tickNow()
  }

  /** In replay, tasks are cut to the store's clock (`nowMs`). */
  setReplayMode(on: boolean): void {
    this.replayMode = on
  }

  /** Replay progress, shown in the status bar. Observed, not event-sourced. */
  setReplay(replay: ReplayInfo | undefined): void {
    const next = { ...this.world }
    if (replay) next.replay = replay
    else delete next.replay
    this.world = next
    this.scheduleNotify()
  }

  tickNow(): void {
    const nowMs = this.opts.nowMs()
    const ticked = tick(this.world, nowMs, {
      stuckAfterMs: this.opts.stuckAfterMs,
      permissionAfterMs: this.opts.permissionAfterMs,
    })
    const applied = applyAdapters(ticked, this.adapterSnapshot, nowMs, { replay: this.replayMode })
    this.world = { ...applied, clock: new Date(nowMs).toISOString() }
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
