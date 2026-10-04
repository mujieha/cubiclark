// Tails <stateDir>/events.jsonl (written by the collector) and turns each stored line into
// AgentEvents. Same shape as the transcript source: `fs.watch` is only ever a speed-up, and a
// polling loop always runs underneath it. The file is allowed not to exist yet (nothing has
// happened since `hooks on`), to be rotated by the collector at 5 MB, and to be deleted and
// recreated; none of those is an error.

import { watch as fsWatch } from 'node:fs'
import { dirname, join } from 'node:path'
import { initialHookNormState, normaliseHookLine } from '../core/hooks/normalise.js'
import type { AgentEvent } from '../core/types.js'
import { LineTailer } from './tail.js'

export interface HookSourceOptions {
  eventsFile: string
  /** null reads the whole file (fixture mode); otherwise lines older than this are skipped. */
  sinceMs: number | null
  watch: boolean
  pollMs: number
  onEvents: (events: AgentEvent[]) => void
  nowMs: () => number
}

export interface HookSourceStats {
  /** Stored lines read so far this run. */
  events: number
  lastEventTs?: string
  error?: string
}

export class HookSource {
  private tailer: LineTailer
  private normState = initialHookNormState()
  private watcher: ReturnType<typeof fsWatch> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private polling = false
  private pollAgain = false
  private eventCount = 0
  private lastEventTs: string | undefined
  private error: string | undefined

  constructor(private readonly opts: HookSourceOptions) {
    this.tailer = this.newTailer()
  }

  /** The collector renames events.jsonl to events.1.jsonl at 5 MB: lines appended after the last poll sit
   * there, past the offset, and are read before the new file is followed (C7). */
  private newTailer(): LineTailer {
    return new LineTailer(this.opts.eventsFile, { rotatedPath: join(dirname(this.opts.eventsFile), 'events.1.jsonl') })
  }

  getStats(): HookSourceStats {
    return { events: this.eventCount, lastEventTs: this.lastEventTs, error: this.error }
  }

  async start(): Promise<void> {
    await this.poll()
    if (this.opts.watch) this.setupWatch()
    this.pollTimer = setInterval(() => {
      void this.poll()
    }, this.opts.pollMs)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.watcher?.close()
    this.watcher = undefined
  }

  /** A request that arrives while a poll is running is not dropped: the file may have grown
   * after that poll's read, and with only a slow timer behind it the change would wait. It
   * asks for one more pass instead. */
  private async poll(): Promise<void> {
    if (this.stopped) return
    if (this.polling) {
      this.pollAgain = true
      return
    }
    this.polling = true
    try {
      do {
        this.pollAgain = false
        await this.pollOnce()
      } while (this.pollAgain && !this.stopped)
    } catch {
      // Runs from timers and watch callbacks, where nothing would catch it (S1-5): a consumer
      // that throws is a source error the page shows, and the next poll runs as usual.
      this.error = 'unexpected error while reading the events file'
    } finally {
      this.polling = false
    }
  }

  private async pollOnce(): Promise<void> {
    let result = await this.tailer.poll()

    if (result.error?.startsWith('cannot stat')) {
      // Not there (yet, or any more): a poll that falls between the collector's rename and its first
      // append to the new file. What is left of the old file past the offset is read first, then a fresh
      // tailer starts, so a file recreated longer than the old offset is read from its first byte rather
      // than from the middle.
      result = await this.tailer.drainRotated()
      this.tailer = this.newTailer()
      this.error = undefined
    } else {
      // A file that was replaced or shrank is the collector's rotation: the tailer has read the rest of
      // the old one and restarts from the top.
      this.error = result.error && !result.truncated ? result.error : undefined
    }

    const events: AgentEvent[] = []
    let unparsed = 0
    let unknownShapes = 0
    for (const raw of result.lines) {
      const parsed = normaliseHookLine(raw, this.normState)
      this.normState = parsed.state
      if (parsed.unparsed) unparsed += 1
      if (parsed.unknownShape) unknownShapes += 1
      if (parsed.unparsed) continue

      const first = parsed.events[0]
      if (first) {
        this.eventCount += 1
        if (this.lastEventTs === undefined || Date.parse(first.ts) > Date.parse(this.lastEventTs)) {
          this.lastEventTs = first.ts
        }
        if (this.opts.sinceMs !== null && Date.parse(first.ts) < this.opts.sinceMs) continue
        events.push(...parsed.events)
      }
    }

    if (unparsed > 0 || unknownShapes > 0) {
      events.push({
        t: 'diagnostics',
        ts: this.lastEventTs ?? new Date(this.opts.nowMs()).toISOString(),
        unparsed,
        unknownTypes: {},
        versions: [],
        unknownHookShapes: unknownShapes,
        ...(this.error ? { sourceError: `hook events: ${this.error}` } : {}),
      })
    } else if (this.error) {
      events.push({
        t: 'diagnostics',
        ts: this.lastEventTs ?? new Date(this.opts.nowMs()).toISOString(),
        unparsed: 0,
        unknownTypes: {},
        versions: [],
        sourceError: `hook events: ${this.error}`,
      })
    }
    if (events.length > 0) this.opts.onEvents(events)
  }

  private setupWatch(): void {
    try {
      // The directory, not the file: rotation replaces the file, and the directory may not have
      // held it yet when the watch was set up.
      this.watcher = fsWatch(dirname(this.opts.eventsFile), () => {
        if (!this.stopped) void this.poll()
      })
      this.watcher.on('error', () => {
        // fs.watch can fail asynchronously; the polling loop keeps going.
      })
    } catch {
      // The directory does not exist yet, or fs.watch is unavailable: polling is the fallback.
    }
  }
}
