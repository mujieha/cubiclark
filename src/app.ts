// Wires the transcript source to the store to the HTTP server. cli.ts owns environment/argv
// handling (CLAUDE_CONFIG_DIR, the default port, opening a browser tab for real); this module
// is fully explicit and takes no defaults from the environment, so tests can call it directly.

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hooksSourceStatus } from './core/hooks/status.js'
import { AdapterHost } from './server/adapters/host.js'
import { createAdapters, type AdapterDeps } from './server/adapters/registry.js'
import { loadConfig } from './server/config-file.js'
import { HookSource } from './server/hook-source.js'
import { inspectHooks } from './server/hooks-install.js'
import { Store } from './server/store.js'
import { TranscriptSource } from './server/transcript-source.js'
import { createHttpServer } from './server/http.js'
import type { HooksSourceStatus, World } from './core/types.js'

export interface AppOptions {
  root: string
  /** Disables the age window and freezes the clock at the newest record seen (PLAN.md §1.7). */
  fixtureMode: boolean
  port: number
  sinceHours: number
  open: boolean
  /** Where the collector writes events.jsonl. Undefined means no hook source at all: the page
   * then says the collector is not installed. */
  stateDir?: string
  /** The adapter configuration file. Undefined means no adapters (a missing file is the same). */
  configPath?: string
  /** What `~` in the configuration expands to. Default: the user's home directory. */
  home?: string
  /** Test seam: how the claude-agents adapter runs its program. */
  adapterDeps?: AdapterDeps
}

export interface RunningApp {
  url: string
  port: number
  close: () => Promise<void>
}

function newestActivityMs(world: World): number | undefined {
  let max: number | undefined
  for (const agent of Object.values(world.agents)) {
    const parsed = Date.parse(agent.lastActivity)
    if (!Number.isNaN(parsed) && (max === undefined || parsed > max)) max = parsed
  }
  return max
}

function openBrowser(url: string): void {
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // best-effort only; the URL is already printed for the person to open by hand
  }
}

export async function startApp(options: AppOptions): Promise<RunningApp> {
  const token = randomBytes(32).toString('base64url')

  let frozenClockMs: number | undefined
  const nowMs = (): number => (options.fixtureMode ? (frozenClockMs ?? Date.now()) : Date.now())

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
    return hooksSourceStatus(await inspectHooks(options.root, options.stateDir), stats, nowMs())
  }

  // The adapters: which ones exist comes from the configuration file (none without one). They are
  // only started below, once the clock is settled, because quota and tasks are read against it.
  const home = options.home ?? homedir()
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

  const mergeSourceStatus = async (): Promise<void> => {
    try {
      store.mergeSources({ transcripts: source.getStatus(), hooks: await hooksStatus(), adapters: adapterHost.statuses() })
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

  const clientDir = fileURLToPath(new URL('./client/', import.meta.url))
  const http = await createHttpServer({ token, port: options.port, clientDir, store })

  const statusTimer = setInterval(() => {
    void mergeSourceStatus()
  }, 2000)

  if (options.open) openBrowser(http.url)

  return {
    url: http.url,
    port: http.port,
    close: async () => {
      clearInterval(statusTimer)
      adapterHost.stop()
      store.stop()
      source.stop()
      hookSource?.stop()
      await http.close()
    },
  }
}
