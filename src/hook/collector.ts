// The hook collector: Claude Code runs this once per event with the payload on stdin. It keeps
// the whitelisted fields (core/hooks/whitelist.ts), appends one line to <stateDir>/events.jsonl
// and exits 0 with empty stdout on every path: it never prints a decision, never throws, never
// writes to stdout or stderr. Imports stay node: builtins plus two pure modules (see
// test/collector-imports.test.ts): Node's own start-up (~90 ms on the dev Mac) is the floor, so
// everything this file adds has to stay tiny.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isatty } from 'node:tty'
import { fileURLToPath } from 'node:url'
import { serialiseStoredLine, toStoredLine } from '../core/hooks/whitelist.js'

export const ROTATE_BYTES = 5 * 1024 * 1024

/** `--state-dir <dir>` wins, then CUBICLARK_HOME, then ~/.cubiclark. The collector runs in the session's
 * project directory, so a relative path (or a `~` nothing expanded) is ignored rather than written into a
 * project tree (C1). */
export function collectorStateDir(argv: readonly string[], env: NodeJS.ProcessEnv, home: string): string {
  const at = argv.indexOf('--state-dir')
  const flag = at >= 0 ? argv[at + 1] : undefined
  if (flag && isAbsolute(flag)) return flag
  const fromEnv = env.CUBICLARK_HOME
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : join(home, '.cubiclark')
}

export interface CollectInput {
  stateDir: string
  readStdin: () => string
  nowMs: number
}

/** Returns true when a line was written. Never throws. */
export function collect(input: CollectInput): boolean {
  try {
    // Soft-off first: a paused collector does no other work at all.
    if (existsSync(join(input.stateDir, 'off'))) {
      try {
        input.readStdin()
      } catch {
        // draining is best-effort
      }
      return false
    }

    let payload: unknown
    try {
      payload = JSON.parse(input.readStdin())
    } catch {
      payload = undefined
    }
    const text = serialiseStoredLine(toStoredLine(payload, new Date(input.nowMs).toISOString()))

    mkdirSync(input.stateDir, { recursive: true, mode: 0o700 })
    const file = join(input.stateDir, 'events.jsonl')
    try {
      if (statSync(file).size >= ROTATE_BYTES) renameSync(file, join(input.stateDir, 'events.1.jsonl'))
    } catch {
      // no file yet, or it was rotated by a concurrent collector
    }
    appendFileSync(file, text, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** The process entry: reads stdin once and always leaves the exit code at 0. */
export function runCollectorMain(): void {
  const nowMs = Date.now()
  collect({
    stateDir: collectorStateDir(process.argv.slice(2), process.env, homedir()),
    readStdin: () => (isatty(0) ? '' : readFileSync(0, 'utf8')),
    nowMs,
  })
  process.exitCode = 0
}

// True only when this file itself was started as the program. Both sides go through realpath:
// Claude Code passes the path exactly as it sits in settings.json, while import.meta.url is
// already resolved, and a state directory behind a symlink (macOS /var -> /private/var) would
// otherwise make them differ and the collector would silently do nothing.
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) runCollectorMain()
