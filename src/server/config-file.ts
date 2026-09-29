// Reads the adapter configuration file. A missing file is not an error (no adapters). A file that
// someone else could have written is not trusted to name a program: `claude-agents` is dropped
// from it, because that adapter runs the binary the file names. "Could have written" means the
// file is writable by group or others, or is owned by another user, or sits in a directory that
// another user can change (they could replace the file by renaming another over it) (S1-7).
//
// The file is opened once and both the check and the read use that descriptor, so the two cannot
// describe different files.

import { open, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname } from 'node:path'
import { parseConfig, type ParsedConfig } from '../core/adapters/config.js'

export interface LoadConfigOptions {
  home: string
  fixtureMode: boolean
  /** The user id that must own the file and its directory. Default: this process's (where there is one). */
  uid?: number
}

const STICKY = 0o1000

/** Why the file cannot be trusted with the name of a program, or undefined when it can. */
export function untrustedReason(file: Stats, directory: Stats | undefined, uid: number | undefined): string | undefined {
  if ((file.mode & 0o022) !== 0) return 'config.json is writable by others; claude-agents stays off'
  if (uid !== undefined && file.uid !== uid) return 'config.json is owned by another user; claude-agents stays off'
  if (directory) {
    const ownedByUsOrRoot = uid === undefined || directory.uid === uid || directory.uid === 0
    const others = (directory.mode & 0o022) !== 0 && (directory.mode & STICKY) === 0
    if (!ownedByUsOrRoot || others) return 'the directory holding config.json can be changed by others; claude-agents stays off'
  }
  return undefined
}

export async function loadConfig(path: string, o: LoadConfigOptions): Promise<ParsedConfig> {
  let text: string
  let file: Stats
  try {
    const handle = await open(path, 'r')
    try {
      file = await handle.stat()
      if (!file.isFile()) return { config: {}, warnings: ['cannot read the config file: not a regular file'] }
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return { config: {}, warnings: [] }
    return { config: {}, warnings: [`cannot read the config file: ${code ?? 'read error'}`] }
  }

  const parsed = parseConfig(text, { baseDir: dirname(path), home: o.home, fixtureMode: o.fixtureMode })
  if (!parsed.config.claudeAgents) return parsed

  const directory = await stat(dirname(path)).catch(() => undefined)
  const uid = o.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  const reason = untrustedReason(file, directory, uid)
  if (!reason) return parsed
  const rest = { ...parsed.config }
  delete rest.claudeAgents
  return { config: rest, warnings: [...parsed.warnings, reason] }
}
