// Wires the sources and the store (start-world.ts) to the HTTP server. cli.ts owns environment/argv
// handling (CLAUDE_CONFIG_DIR, the default port, opening a browser tab for real); this module
// is fully explicit and takes no defaults from the environment, so tests can call it directly.

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_IDLE_DESKS } from './core/visible.js'
import type { AdapterDeps } from './server/adapters/registry.js'
import { createHttpServer } from './server/http.js'
import { startWorld } from './start-world.js'

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
  /** The custom-assets manifest. Undefined means none (a missing file is the same). */
  assetsPath?: string
  /** Morty, the office corgi, is in the page. Default true; `--no-mascot` turns it off. */
  mascot?: boolean
  /** How many idle sessions keep a desk in the page. Default 5; `--idle-desks` changes it. */
  idleDesks?: number
  /** Test seam: how the claude-agents adapter runs its program. */
  adapterDeps?: AdapterDeps
}

export interface RunningApp {
  url: string
  port: number
  close: () => Promise<void>
}

export function openBrowser(url: string): void {
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

  const world = await startWorld(options)

  const clientDir = fileURLToPath(new URL('./client/', import.meta.url))
  let http: Awaited<ReturnType<typeof createHttpServer>>
  try {
    http = await createHttpServer({
      token,
      port: options.port,
      clientDir,
      store: world.store,
      home: world.home,
      customAssets: world.assets.overrides,
      pageOptions: { mascot: options.mascot ?? true, idleDesks: options.idleDesks ?? DEFAULT_IDLE_DESKS },
    })
  } catch (err) {
    // The port is taken (or the like): the sources must not keep the process alive behind the error.
    world.close()
    throw err
  }

  if (options.open) openBrowser(http.url)

  return {
    url: http.url,
    port: http.port,
    close: async () => {
      world.close()
      await http.close()
    },
  }
}
