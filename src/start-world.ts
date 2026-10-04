// The sources and the store, without the HTTP server: the transcript source, the hook source, the
// adapters and the clock, wired to one Store. `startApp` puts the server on top of this for the page;
// `cubiclark tui` reads the same Store from the terminal. Fully explicit, like app.ts: nothing here
// takes a default from the environment.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { hooksSourceStatus } from './core/hooks/status.js'
import { AdapterHost } from './server/adapters/host.js'
import { createAdapters } from './server/adapters/registry.js'
import { loadAssets, type LoadedAssets } from './server/assets-file.js'
import { loadConfig } from './server/config-file.js'
import { HookSource } from './server/hook-source.js'
import { inspectHooks } from './server/hooks-install.js'
import { Store } from './server/store.js'
import { TranscriptSource } from './server/transcript-source.js'
import type { AppOptions } from './app.js'
import type { HooksSourceStatus, World } from './core/types.js'

/** What the sources need to know: everything an app takes except the server's and the page's own options. */
export type WorldOptions = Omit<AppOptions, 'port' | 'open' | 'mascot' | 'idleDesks'>

export interface RunningWorld {
  store: Store
  /** What `~` expands to (the configuration's, and the page's path display). */
  home: string
  assets: LoadedAssets
  /** Stops the timers, the watchers and the adapters. */
  close: () => void
}

function newestActivityMs(world: World): number | undefined {
  let max: number | undefined
  for (const agent of Object.values(world.agents)) {
    const parsed = Date.parse(agent.lastActivity)
    if (!Number.isNaN(parsed) && (max === undefined || parsed > max)) max = parsed
  }
  return max
}

export async function startWorld(options: WorldOptions): Promise<RunningWorld> {
  let frozenClockMs: number | undefined
  const nowMs = (): number => (options.fixtureMode ? (frozenClockMs ?? Date.now()) : Date.now())

  const home = options.home ?? homedir()
  const store = new Store({ nowMs, transcriptsRoot: options.root })

  // The same age window for both sources; fixture mode reads everything under its root.
  const sinceMs = options.fixtureMode ? null : Date.now() - options.sinceHours * 60 * 60 * 1000

  const source = new TranscriptSource({
    root: options.root,
    sinceMs,
    windowHours: options.fixtureMode ? null : options.sinceHours,
    watch: true,
    pollMs: options.fixtureMode ? 200 : 2000,
    onEvents: (events) => store.applyTranscriptEvents(events),
    nowMs,
  })

  const hookSource =
    options.stateDir === undefined
      ? undefined
      : new HookSource({
          eventsFile: join(options.stateDir, 'events.jsonl'),
          sinceMs,
          watch: true,
          pollMs: options.fixtureMode ? 200 : 1000,
          onEvents: (events) => store.applyEvents(events),
          nowMs,
        })

  const hooksStatus = async (): Promise<HooksSourceStatus> => {
    if (!hookSource || options.stateDir === undefined) return { status: 'not_installed', events: 0 }
    const stats = hookSource.getStats()
    if (options.fixtureMode) {
      // A fixture home has no settings.json to inspect: the events file alone decides.
      return {
        status: stats.events > 0 ? 'live' : 'not_installed',
        events: stats.events,
        lastEventTs: stats.lastEventTs,
        eventsFile: join(options.stateDir, 'events.jsonl'),
      }
    }
    return hooksSourceStatus(await inspectHooks(options.root, options.stateDir), stats, nowMs(), home)
  }

  // The adapters: which ones exist comes from the configuration file (none without one). They are
  // only started below, once the clock is settled, because quota and tasks are read against it.
  const adapterEnv = { nowMs, home }
  const loaded =
    options.configPath === undefined
      ? { config: {}, warnings: [] as string[] }
      : await loadConfig(options.configPath, { home, fixtureMode: options.fixtureMode })
  const adapterHost = new AdapterHost({
    adapters: createAdapters(loaded.config, adapterEnv, options.adapterDeps),
    env: adapterEnv,
    onSnapshot: (snapshot) => store.setAdapterSnapshot(snapshot),
    configWarnings: loaded.warnings,
  })

  // The custom-assets manifest is read once, at start: a change needs a restart (docs/assets.md).
  const assets = await loadAssets(options.assetsPath)

  const mergeSourceStatus = async (): Promise<void> => {
    try {
      store.mergeSources({ transcripts: source.getStatus(), hooks: await hooksStatus(), adapters: adapterHost.statuses(), assets: assets.status })
    } catch {
      // A status refresh must never take the server down; the next tick tries again.
    }
  }

  // The transcripts' history goes in first, the hooks' after it: hooks win on timing from there.
  await source.start()
  await hookSource?.start()

  if (options.fixtureMode) {
    frozenClockMs = newestActivityMs(store.getWorld()) ?? Date.now()
  }

  await adapterHost.start()
  await mergeSourceStatus()

  store.start()

  const statusTimer = setInterval(() => {
    void mergeSourceStatus()
  }, 2000)

  return {
    store,
    home,
    assets,
    close: () => {
      clearInterval(statusTimer)
      adapterHost.stop()
      store.stop()
      source.stop()
      hookSource?.stop()
    },
  }
}
