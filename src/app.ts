// Wires the transcript source to the store to the HTTP server. cli.ts owns environment/argv
// handling (CLAUDE_CONFIG_DIR, the default port, opening a browser tab for real); this module
// is fully explicit and takes no defaults from the environment, so tests can call it directly.

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Store } from './server/store.js'
import { TranscriptSource } from './server/transcript-source.js'
import { createHttpServer } from './server/http.js'
import type { World } from './core/types.js'

export interface AppOptions {
  root: string
  /** Disables the age window and freezes the clock at the newest record seen (PLAN.md §1.7). */
  fixtureMode: boolean
  port: number
  sinceHours: number
  open: boolean
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

  const source = new TranscriptSource({
    root: options.root,
    sinceMs: options.fixtureMode ? null : Date.now() - options.sinceHours * 60 * 60 * 1000,
    windowHours: options.fixtureMode ? null : options.sinceHours,
    watch: true,
    pollMs: options.fixtureMode ? 200 : 2000,
    onEvents: (events) => store.applyEvents(events),
    nowMs,
  })

  const mergeSourceStatus = (): void => {
    store.mergeSources({ transcripts: source.getStatus(), hooks: { status: 'not_installed', events: 0 } })
  }

  await source.start()
  mergeSourceStatus()

  if (options.fixtureMode) {
    frozenClockMs = newestActivityMs(store.getWorld()) ?? Date.now()
  }

  store.start()

  const clientDir = fileURLToPath(new URL('./client/', import.meta.url))
  const http = await createHttpServer({ token, port: options.port, clientDir, store })

  const statusTimer = setInterval(mergeSourceStatus, 2000)

  if (options.open) openBrowser(http.url)

  return {
    url: http.url,
    port: http.port,
    close: async () => {
      clearInterval(statusTimer)
      store.stop()
      source.stop()
      await http.close()
    },
  }
}
