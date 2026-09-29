#!/usr/bin/env node
// Entry point: serve, --no-open, --port, --fixture-home. parseCli and resolveRoot are pure and
// exported so tests can check flag and environment handling without spawning a process; main()
// does the actual I/O and only runs when this file is executed directly, not when imported.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { startApp } from './app.js'

const VERSION = '0.1.0'

const HELP_TEXT = `cubiclark ${VERSION}

Usage: cubiclark [options]

  --port <n>            Port to listen on (0 picks a free one). Default 4789.
  --no-open              Do not open a browser tab.
  --fixture-home <dir>   Read a fixture Claude config directory instead of the real one.
  --since-hours <n>      How far back to read transcripts. Default 12. Ignored with
                         --fixture-home, which always reads everything under it.
  --help                 Show this text.
  --version              Show the version.

Binds to 127.0.0.1 only. Never calls a model, never sends data anywhere.
`

export interface CliOptions {
  port: number
  open: boolean
  fixtureHome?: string
  sinceHours: number
  help: boolean
  version: boolean
}

export function parseCli(argv: readonly string[]): CliOptions {
  let values: Record<string, string | boolean | undefined>
  try {
    ;({ values } = parseArgs({
      args: [...argv],
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        'fixture-home': { type: 'string' },
        'since-hours': { type: 'string' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
      strict: true,
    }))
  } catch (err) {
    throw new Error(`invalid arguments: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }

  const port = values.port !== undefined ? Number(values.port) : 4789
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${String(values.port)}`)
  }

  const sinceHours = values['since-hours'] !== undefined ? Number(values['since-hours']) : 12
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    throw new Error(`invalid --since-hours: ${String(values['since-hours'])}`)
  }

  return {
    port,
    open: values['no-open'] !== true,
    fixtureHome: typeof values['fixture-home'] === 'string' ? values['fixture-home'] : undefined,
    sinceHours,
    help: values.help === true,
    version: values.version === true,
  }
}

export interface ResolvedRoot {
  root: string
  fixtureMode: boolean
}

/** The real Claude config directory is CLAUDE_CONFIG_DIR, or homedir()/.claude when unset — but
 * only ever used when --fixture-home was not given, and always via an injected `env`, so a test
 * never has to touch the real environment. */
export function resolveRoot(fixtureHome: string | undefined, env: NodeJS.ProcessEnv, home: string): ResolvedRoot {
  if (fixtureHome !== undefined) return { root: fixtureHome, fixtureMode: true }
  const configured = env.CLAUDE_CONFIG_DIR
  const root = configured && configured.length > 0 ? configured : join(home, '.claude')
  return { root, fixtureMode: false }
}

async function main(): Promise<void> {
  let opts: CliOptions
  try {
    opts = parseCli(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  if (opts.help) {
    console.error(HELP_TEXT)
    return
  }
  if (opts.version) {
    console.log(VERSION)
    return
  }

  const { root, fixtureMode } = resolveRoot(opts.fixtureHome, process.env, homedir())

  let app: Awaited<ReturnType<typeof startApp>>
  try {
    app = await startApp({ root, fixtureMode, port: opts.port, sinceHours: opts.sinceHours, open: opts.open })
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EADDRINUSE') {
      console.error(`cubiclark: port ${opts.port} is already in use`)
    } else {
      console.error(`cubiclark: failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
    process.exitCode = 1
    return
  }

  // Exactly one machine-readable line to stdout; everything else goes to stderr.
  console.log(`cubiclark listening ${app.url}`)
  console.error(`cubiclark: ${fixtureMode ? 'reading fixture data from' : 'reading transcripts from'} ${root}`)

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  void main()
}
