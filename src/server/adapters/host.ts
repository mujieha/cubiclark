// Detects the configured adapters, keeps each one's latest snapshot fresh on its own schedule and
// hands the merged result to the store. One adapter failing never touches another: a rejected
// snapshot keeps that adapter's previous part and marks it failing; an adapter whose source is
// absent is `missing` and looked for again every 30 s. Refreshes of one adapter never overlap.

import { mergeSnapshots, type AdapterEnv, type AdapterSnapshot, type OrchestrationAdapter } from '../../core/adapters/types.js'
import type { AdapterStatus } from '../../core/types.js'
import { ADAPTER_IDS, missingReason } from './registry.js'

type TimerHandle = unknown

export interface AdapterHostOptions {
  adapters: OrchestrationAdapter[]
  env: AdapterEnv
  /** Called with the merged snapshot of every adapter that has one, after any adapter refreshes. */
  onSnapshot: (snapshot: AdapterSnapshot) => void
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  /** From the configuration file: shown beside the first adapter's status. */
  configWarnings?: readonly string[]
  /** How often an adapter whose source is absent is looked for again. */
  redetectMs?: number
}

interface Entry {
  adapter: OrchestrationAdapter
  status: AdapterStatus
  part?: AdapterSnapshot
  timer?: TimerHandle
  unwatch?: () => void
  running: boolean
  again: boolean
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 120)
}

export class AdapterHost {
  private readonly entries = new Map<string, Entry>()
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private stopped = false

  constructor(private readonly opts: AdapterHostOptions) {
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms)
        handle.unref()
        return handle
      })
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    for (const adapter of opts.adapters) {
      this.entries.set(adapter.id, {
        adapter,
        status: { id: adapter.id, status: 'missing', detail: 'starting' },
        running: false,
        again: false,
      })
    }
  }

  /** Detects every adapter, takes the first snapshot of those found, then hands over the merge. */
  async start(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.detectAndStart(entry)))
    this.emit()
  }

  stop(): void {
    this.stopped = true
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.clearTimer(entry.timer)
      entry.timer = undefined
      entry.unwatch?.()
      entry.unwatch = undefined
    }
  }

  /** One status per known adapter id; an adapter that is not configured is `off`. */
  statuses(): AdapterStatus[] {
    const nowMs = this.opts.env.nowMs()
    const out: AdapterStatus[] = ADAPTER_IDS.map((id) => {
      const entry = this.entries.get(id)
      if (!entry) return { id, status: 'off', detail: 'not configured' }
      // A rejected snapshot keeps its own message. Otherwise the adapter describes itself now, so
      // "sampled 12m ago" keeps moving between snapshots.
      if (entry.status.status === 'live') {
        try {
          const description = entry.adapter.describe?.(nowMs)
          if (description) return { ...entry.status, status: description.failing ? 'failing' : 'live', detail: description.detail }
        } catch {
          // a describe() that throws must not take the status list down
        }
      }
      return { ...entry.status }
    })
    const warnings = this.opts.configWarnings ?? []
    if (warnings.length > 0) {
      const index = Math.max(0, out.findIndex((status) => status.status !== 'off'))
      const target = out[index] as AdapterStatus
      out[index] = { ...target, detail: `${target.detail} · config: ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}` }
    }
    return out
  }

  /** Takes a new snapshot of one adapter now (or of each). A request that arrives while one is
   * running is not dropped: it asks for one more pass. */
  async refresh(id?: string): Promise<void> {
    const targets = id === undefined ? [...this.entries.values()] : [this.entries.get(id)].filter((e): e is Entry => e !== undefined)
    await Promise.all(targets.map((entry) => this.refreshEntry(entry)))
    if (targets.length > 0) this.emit()
  }

  private emit(): void {
    if (this.stopped) return
    const parts = [...this.entries.values()].flatMap((entry) => (entry.part ? [entry.part] : []))
    try {
      this.opts.onSnapshot(mergeSnapshots(parts))
    } catch {
      // the store failing to apply a snapshot must not stop the schedule
    }
  }

  private async detectAndStart(entry: Entry): Promise<void> {
    if (this.stopped) return
    // detect() must not throw, and if it does the source counts as absent.
    const found = await Promise.resolve()
      .then(() => entry.adapter.detect(this.opts.env))
      .catch(() => false)
    if (this.stopped) return
    if (!found) {
      entry.status = { id: entry.adapter.id, status: 'missing', detail: missingReason(entry.adapter.id) }
      entry.part = undefined
      entry.timer = this.setTimer(() => {
        entry.timer = undefined
        void this.detectAndStart(entry).then(() => this.emit())
      }, this.opts.redetectMs ?? 30_000)
      return
    }
    entry.status = { id: entry.adapter.id, status: 'live', detail: 'starting' }
    try {
      entry.unwatch?.()
      entry.unwatch = entry.adapter.watch?.(() => void this.refresh(entry.adapter.id))
    } catch {
      entry.unwatch = undefined
    }
    await this.refreshEntry(entry)
  }

  private async refreshEntry(entry: Entry): Promise<void> {
    if (this.stopped) return
    if (entry.status.status === 'missing') return // not found yet: the re-detect timer owns it
    if (entry.running) {
      entry.again = true
      return
    }
    entry.running = true
    try {
      do {
        entry.again = false
        try {
          entry.part = await entry.adapter.snapshot()
          entry.status = { id: entry.adapter.id, status: 'live', detail: 'live', lastSnapshotAt: new Date(this.opts.env.nowMs()).toISOString() }
        } catch (err) {
          // keep the previous part: what was last known is better than nothing
          entry.status = { ...entry.status, id: entry.adapter.id, status: 'failing', detail: message(err) }
        }
      } while (entry.again && !this.stopped)
    } finally {
      entry.running = false
    }
    if (this.stopped) return
    if (entry.timer !== undefined) this.clearTimer(entry.timer)
    entry.timer = this.setTimer(() => {
      entry.timer = undefined
      void this.refresh(entry.adapter.id)
    }, entry.adapter.pollMs)
  }
}
