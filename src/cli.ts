#!/usr/bin/env node
// Entry point: serve (the default), `hooks on|off|status|pause|resume`, `doctor`, and `hook` (the
// collector entry Claude Code runs; not for people). parseCli, resolveRoot and resolveStateDir
// are pure and exported so tests can check flag and environment handling without spawning a
// process; main() does the actual I/O and only runs when this file is executed directly, not
// when imported.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startApp } from './app.js'
import {
  HooksCommandError,
  formatHooksStatus,
  hooksOff,
  hooksOn,
  inspectHooks,
  pauseHooks,
  resumeHooks,
  type HooksPaths,
} from './server/hooks-install.js'

const VERSION = '0.1.0'

const HELP_TEXT = `cubiclark ${VERSION}

Usage:
  cubiclark [--port <n>] [--no-open] [--since-hours <n>] [--fixture-home <dir>] [--state-dir <dir>]
                                  Serve the page on 127.0.0.1 (the default command)
  cubiclark hooks on [--no-tools] Install the collector into Claude Code's user settings.json
  cubiclark hooks off [--purge]   Remove it (byte-identical when settings.json is unchanged since)
  cubiclark hooks status          Show what is installed and whether it is paused
  cubiclark hooks pause|resume    Soft-off: create or remove <state dir>/off
  cubiclark doctor                Report the Claude Code version, sources and diagnostics
  cubiclark hook                  The collector itself; Claude Code runs it, not people

  --config-dir <dir>   Claude config directory (default CLAUDE_CONFIG_DIR or ~/.claude)
  --state-dir <dir>    Cubiclark state directory (default CUBICLARK_HOME or ~/.cubiclark)
  --claude-bin <path>  doctor only: the claude executable (default claude)
  --port <n>           Port to listen on (0 picks a free one). Default 4789.
  --since-hours <n>    How far back to read transcripts. Default 12. Ignored with
                       --fixture-home, which always reads everything under it.
  --help               Show this text.
  --version            Show the version.

Binds to 127.0.0.1 only. Never calls a model, never sends data anywhere.
`

export type HooksAction = 'on' | 'off' | 'status' | 'pause' | 'resume'
const HOOKS_ACTIONS: readonly HooksAction[] = ['on', 'off', 'status', 'pause', 'resume']

export interface ServeCommand {
  command: 'serve'
  port: number
  open: boolean
  fixtureHome?: string
  sinceHours: number
  stateDir?: string
}

export interface HooksCommand {
  command: 'hooks'
  action: HooksAction
  tools: boolean
  purge: boolean
  configDir?: string
  stateDir?: string
}

export interface DoctorCommand {
  command: 'doctor'
  configDir?: string
  fixtureHome?: string
  stateDir?: string
  sinceHours: number
  claudeBin: string
}

export type Command =
  | ServeCommand
  | { command: 'hook' }
  | HooksCommand
  | DoctorCommand
  | { command: 'help' }
  | { command: 'version' }

// Which flags each command accepts. A flag given to a command that ignores it is an error rather
// than a silent no-op: `cubiclark hooks off --no-tools` should not look like it did something.
const ALLOWED_FLAGS: Record<'serve' | 'hooks' | 'doctor', readonly string[]> = {
  serve: ['port', 'no-open', 'fixture-home', 'since-hours', 'state-dir', 'help', 'version'],
  hooks: ['config-dir', 'state-dir', 'no-tools', 'purge', 'help', 'version'],
  doctor: ['config-dir', 'fixture-home', 'state-dir', 'since-hours', 'claude-bin', 'help', 'version'],
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --${name}: ${raw}`)
  return value
}

export function parseCli(argv: readonly string[]): Command {
  // The collector entry ignores every other argument: Claude Code may pass --state-dir or
  // anything a future version adds, and none of it may make the collector fail.
  if (argv[0] === 'hook') return { command: 'hook' }

  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        'fixture-home': { type: 'string' },
        'since-hours': { type: 'string' },
        'config-dir': { type: 'string' },
        'state-dir': { type: 'string' },
        'claude-bin': { type: 'string' },
        'no-tools': { type: 'boolean' },
        purge: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
      strict: true,
    }))
  } catch (err) {
    throw new Error(`invalid arguments: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }

  if (values.help === true) return { command: 'help' }
  if (values.version === true) return { command: 'version' }

  const name = positionals[0]
  const kind: 'serve' | 'hooks' | 'doctor' = name === undefined ? 'serve' : name === 'hooks' || name === 'doctor' ? name : 'serve'
  if (name !== undefined && kind === 'serve') throw new Error(`unknown command: ${name} (see --help)`)

  for (const flag of Object.keys(values)) {
    if (!ALLOWED_FLAGS[kind].includes(flag)) throw new Error(`--${flag} is not valid for ${kind === 'serve' ? 'the default command' : kind}`)
  }
  const str = (key: string): string | undefined => (typeof values[key] === 'string' ? (values[key] as string) : undefined)

  if (kind === 'hooks') {
    const action = positionals[1]
    if (positionals.length !== 2 || !HOOKS_ACTIONS.includes(action as HooksAction)) {
      throw new Error('hooks needs one action: on|off|status|pause|resume')
    }
    if (values['no-tools'] === true && action !== 'on') throw new Error('--no-tools is only valid with `hooks on`')
    if (values.purge === true && action !== 'off') throw new Error('--purge is only valid with `hooks off`')
    return {
      command: 'hooks',
      action: action as HooksAction,
      tools: values['no-tools'] !== true,
      purge: values.purge === true,
      configDir: str('config-dir'),
      stateDir: str('state-dir'),
    }
  }

  if (positionals.length > 1) throw new Error(`unexpected argument: ${positionals[1]}`)

  if (kind === 'doctor') {
    return {
      command: 'doctor',
      configDir: str('config-dir'),
      fixtureHome: str('fixture-home'),
      stateDir: str('state-dir'),
      sinceHours: positiveNumber(str('since-hours'), 12, 'since-hours'),
      claudeBin: str('claude-bin') ?? 'claude',
    }
  }

  const port = str('port') !== undefined ? Number(str('port')) : 4789
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${String(values.port)}`)
  return {
    command: 'serve',
    port,
    open: values['no-open'] !== true,
    fixtureHome: str('fixture-home'),
    sinceHours: positiveNumber(str('since-hours'), 12, 'since-hours'),
    stateDir: str('state-dir'),
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

/** `--state-dir`, then CUBICLARK_HOME, then ~/.cubiclark. */
export function resolveStateDir(flag: string | undefined, env: NodeJS.ProcessEnv, home: string): string {
  if (flag !== undefined) return flag
  const configured = env.CUBICLARK_HOME
  return configured && configured.length > 0 ? configured : join(home, '.cubiclark')
}

async function runHooks(cmd: HooksCommand): Promise<void> {
  const home = homedir()
  const paths: HooksPaths = {
    configDir: cmd.configDir ?? resolveRoot(undefined, process.env, home).root,
    stateDir: resolveStateDir(cmd.stateDir, process.env, home),
    // dist/ is this file's own directory once built.
    distDir: fileURLToPath(new URL('.', import.meta.url)),
    // A state dir equal to this needs no --state-dir in the handlers; any other one is explicit.
    defaultStateDir: join(home, '.cubiclark'),
  }

  switch (cmd.action) {
    case 'on': {
      const result = await hooksOn(paths, { tools: cmd.tools, nowMs: Date.now() })
      if (!result.changed) {
        console.error(`cubiclark: hooks already on (${result.settingsPath})`)
      } else {
        const backup = result.backupPath ? `backup: ${result.backupPath}` : 'no backup needed: the file did not exist'
        console.error(`cubiclark: hooks on — ${result.events.length} events added to ${result.settingsPath} (${backup})`)
      }
      return
    }
    case 'off': {
      const result = await hooksOff(paths, { purge: cmd.purge })
      if (result.restored === 'nothing') {
        console.error(`cubiclark: hooks were not installed in ${result.settingsPath}`)
      } else if (result.restored === 'backup') {
        console.error('cubiclark: hooks off — settings.json restored byte for byte from the backup')
      } else {
        console.error(
          `cubiclark: hooks off — removed our ${result.removed} entries (settings.json changed since install, other edits kept)`
        )
      }
      return
    }
    case 'status':
      console.log(formatHooksStatus(await inspectHooks(paths.configDir, paths.stateDir)))
      return
    case 'pause':
      await pauseHooks(paths.stateDir)
      console.error(`cubiclark: hooks paused (${join(paths.stateDir, 'off')})`)
      return
    case 'resume':
      await resumeHooks(paths.stateDir)
      console.error('cubiclark: hooks resumed')
      return
  }
}

async function runServe(cmd: ServeCommand): Promise<void> {
  const { root, fixtureMode } = resolveRoot(cmd.fixtureHome, process.env, homedir())

  let app: Awaited<ReturnType<typeof startApp>>
  try {
    app = await startApp({ root, fixtureMode, port: cmd.port, sinceHours: cmd.sinceHours, open: cmd.open })
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EADDRINUSE') {
      console.error(`cubiclark: port ${cmd.port} is already in use`)
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

async function main(): Promise<void> {
  let cmd: Command
  try {
    cmd = parseCli(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  switch (cmd.command) {
    case 'help':
      console.error(HELP_TEXT)
      return
    case 'version':
      console.log(VERSION)
      return
    case 'hook': {
      const { runCollectorMain } = await import('./hook/collector.js')
      runCollectorMain()
      return
    }
    case 'hooks':
      try {
        await runHooks(cmd)
      } catch (err) {
        console.error(`cubiclark: ${err instanceof HooksCommandError ? err.message : `hooks failed: ${String(err)}`}`)
        process.exitCode = 1
      }
      return
    case 'doctor':
      console.error('cubiclark: doctor is not implemented yet')
      process.exitCode = 1
      return
    case 'serve':
      await runServe(cmd)
      return
  }
}

// Through realpath on both sides: an installed bin is a symlink (node_modules/.bin/cubiclark),
// and process.argv[1] keeps the symlink path while import.meta.url is already resolved.
function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  void main()
}
