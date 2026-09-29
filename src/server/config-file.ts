// Reads the adapter configuration file. A missing file is not an error (no adapters). A file
// that other users can write is not trusted to name a program: `claude-agents` is dropped from it,
// because that adapter runs the binary the file names.

import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseConfig, type ParsedConfig } from '../core/adapters/config.js'

export interface LoadConfigOptions {
  home: string
  fixtureMode: boolean
}

export async function loadConfig(path: string, o: LoadConfigOptions): Promise<ParsedConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return { config: {}, warnings: [] }
    return { config: {}, warnings: [`cannot read the config file: ${code ?? 'read error'}`] }
  }

  const parsed = parseConfig(text, { baseDir: dirname(path), home: o.home, fixtureMode: o.fixtureMode })

  try {
    const { mode } = await stat(path)
    if ((mode & 0o022) !== 0 && parsed.config.claudeAgents) {
      const rest = { ...parsed.config }
      delete rest.claudeAgents
      return { config: rest, warnings: [...parsed.warnings, 'config.json is writable by others; claude-agents stays off'] }
    }
  } catch {
    // the file vanished between the read and the stat: keep what was parsed
  }
  return parsed
}
