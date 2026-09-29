// `cubiclark replay --since <duration>`: the same page, playing back what happened. Every
// transcript and hook event of the window is collected once, ordered by time, and released as a
// clock that runs `speed` times faster than the real one reaches it. What happened before the
// window is applied at once, so the agents that were already there are in the office when it
// starts. Adapter data follows the replay clock: quota is the sample at that time and a task's
// timeline is cut there. `claude agents` describes the present, so a replay does not ask it.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrowser } from '../app.js'
import type { RunningApp } from '../app.js'
import { orderReplay, replayClockMs, splitAt, takeDue, toReplayItems, type ReplayItem } from '../core/replay.js'
import type { AgentEvent, HooksSourceStatus, World } from '../core/types.js'
import { AdapterHost } from './adapters/host.js'
import { createAdapters } from './adapters/registry.js'
import { loadConfig } from './config-file.js'
import { HookSource } from './hook-source.js'
import { createHttpServer } from './http.js'
import { Store } from './store.js'
import { TranscriptSource } from './transcript-source.js'

export interface ReplayOptions {
  /** The transcripts root: a Claude config directory, or a fixture home. */
  root: string
  fixtureMode: boolean
  stateDir?: string
  /** The adapter configuration file. Undefined means no adapters. */
  configPath?: string
  home: string
  /** How far back the window reaches, in ms. */
  sinceMs: number
  speed: number
  port: number
  open: boolean
  /** Test seams: the real clock, and stepping by hand instead of a timer. */
  realNowMs?: () => number
  manual?: boolean
}

export interface RunningReplay extends RunningApp {
  /** One playback step: releases what the clock has reached. The timer calls this. */
  step: () => void
  getWorld: () => World
}

const ONE_SHOT_POLL_MS = 60 * 60 * 1000 // never fires: both sources are stopped right after start()
const STEP_MS = 100
/** Transcripts older than the window by this much are not read at all (a session that is still
 * running keeps writing to its file, so this is a read-time cut, not a cut of what is shown). */
const LOOKBACK_MS = 12 * 60 * 60 * 1000

export async function startReplay(o: ReplayOptions): Promise<RunningReplay> {
  const realNow = o.realNowMs ?? Date.now

  // 1. Collect everything once, the way `doctor` reads: the same sources, stopped right after.
  const items: ReplayItem[] = []
  const diagnostics: AgentEvent[] = []
  const collect =
    (source: ReplayItem['source']) =>
    (events: AgentEvent[]): void => {
      for (const event of events) {
        if (event.t === 'diagnostics') diagnostics.push(event)
        else items.push(...toReplayItems(source, [event]))
      }
    }
  const readSinceMs = o.fixtureMode ? null : realNow() - o.sinceMs - LOOKBACK_MS
  const transcripts = new TranscriptSource({
    root: o.root,
    sinceMs: readSinceMs,
    windowHours: null,
    watch: false,
    pollMs: ONE_SHOT_POLL_MS,
    onEvents: collect('transcript'),
    nowMs: realNow,
  })
  await transcripts.start()
  const transcriptStatus = transcripts.getStatus()
  transcripts.stop()

  let hookStats: { events: number; lastEventTs?: string } = { events: 0 }
  if (o.stateDir !== undefined) {
    const hooks = new HookSource({
      eventsFile: join(o.stateDir, 'events.jsonl'),
      sinceMs: readSinceMs,
      watch: false,
      pollMs: ONE_SHOT_POLL_MS,
      onEvents: collect('hook'),
      nowMs: realNow,
    })
    await hooks.start()
    hookStats = hooks.getStats()
    hooks.stop()
  }

  // 2. The window ends at the newest event of a fixture, and now for real.
  const ordered = orderReplay(items)
  const newestMs = ordered.length > 0 ? (ordered[ordered.length - 1] as ReplayItem).ms : realNow()
  const endMs = o.fixtureMode ? newestMs : realNow()
  const startMs = endMs - o.sinceMs
  const { before, during } = splitAt(ordered, startMs)

  // 3. A store whose clock is the replay clock.
  let playing = false
  let realStart = 0
  const clock = (): number => (playing ? Math.min(endMs, replayClockMs(startMs, realStart, realNow(), o.speed)) : startMs)
  const store = new Store({ nowMs: clock, transcriptsRoot: o.root, tickIntervalMs: 250 })
  store.setReplayMode(true)
  const replayInfo = (done: boolean) => ({ sinceTs: new Date(startMs).toISOString(), endTs: new Date(endMs).toISOString(), speed: o.speed, done })
  store.setReplay(replayInfo(false))
  store.applyEvents(diagnostics)

  // Runs of one source go in together: the merge gate judges a transcript event against the World
  // as the hook events before it left it.
  const apply = (batch: readonly ReplayItem[]): void => {
    let run: AgentEvent[] = []
    let runSource: ReplayItem['source'] | undefined
    const flush = (): void => {
      if (run.length > 0) {
        if (runSource === 'transcript') store.applyTranscriptEvents(run)
        else store.applyEvents(run)
      }
      run = []
    }
    for (const item of batch) {
      if (item.source !== runSource) {
        flush()
        runSource = item.source
      }
      run.push(item.event)
    }
    flush()
  }
  apply(before)

  // 4. The adapters, on the replay clock (and never `claude agents`).
  const loaded = o.configPath === undefined ? { config: {}, warnings: [] as string[] } : await loadConfig(o.configPath, { home: o.home, fixtureMode: o.fixtureMode })
  const config = { ...loaded.config }
  delete config.claudeAgents
  const env = { nowMs: clock, wallMs: o.fixtureMode ? () => endMs : realNow, home: o.home }
  const adapterHost = new AdapterHost({
    adapters: createAdapters(config, env),
    env,
    onSnapshot: (snapshot) => store.setAdapterSnapshot(snapshot),
    configWarnings: loaded.warnings,
  })
  await adapterHost.start()

  const hooks: HooksSourceStatus =
    hookStats.events > 0 ? { status: 'live', events: hookStats.events, lastEventTs: hookStats.lastEventTs } : { status: 'not_installed', events: 0 }
  const mergeStatus = (): void => store.mergeSources({ transcripts: transcriptStatus, hooks, adapters: adapterHost.statuses() })
  mergeStatus()

  // 5. Playback.
  let cursor = 0
  let finished = false
  const step = (): void => {
    if (finished) return
    const now = clock()
    const { due, cursor: next } = takeDue(during, cursor, now)
    cursor = next
    apply(due)
    if (cursor >= during.length && now >= endMs) {
      finished = true
      store.setReplay(replayInfo(true))
    }
    store.tickNow()
  }
  playing = true
  realStart = realNow()
  store.tickNow()

  let timer: ReturnType<typeof setInterval> | undefined
  let statusTimer: ReturnType<typeof setInterval> | undefined
  if (!o.manual) {
    store.start()
    timer = setInterval(step, STEP_MS)
    statusTimer = setInterval(mergeStatus, 2000)
  }

  const token = randomBytes(32).toString('base64url')
  const clientDir = fileURLToPath(new URL('../client/', import.meta.url))
  const http = await createHttpServer({ token, port: o.port, clientDir, store, home: o.home })
  if (o.open) openBrowser(http.url)

  return {
    url: http.url,
    port: http.port,
    step,
    getWorld: () => store.getWorld(),
    close: async () => {
      if (timer) clearInterval(timer)
      if (statusTimer) clearInterval(statusTimer)
      adapterHost.stop()
      store.stop()
      await http.close()
    },
  }
}
