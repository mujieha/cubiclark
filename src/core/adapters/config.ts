// Parses the adapter configuration file (`<state dir>/config.json`, or `--config <file>`). Pure:
// the caller reads the file and passes its text, the directory relative paths resolve against and
// the home directory `~` expands to. Never throws: a bad file or a bad section becomes a warning
// and that part is left out. A missing file means no adapters, which is not an error.

export interface AdapterConfig {
  taskFolders?: { roots: string[]; orchestratorCwds: string[]; windowHours: number | null }
  /** `file` may end in a glob such as `samples-*.jsonl`: the newest match by mtime is read. */
  quotaSamples?: { file: string }
  claudeAgents?: { bin: string; pollMs: number }
}

export interface ParsedConfig {
  config: AdapterConfig
  warnings: string[]
}

export interface ParseConfigOptions {
  baseDir: string
  home: string
  /** Fixture mode has no time window unless the file asks for one. */
  fixtureMode: boolean
}

export const ADAPTER_CONFIG_IDS = ['task-folders', 'quota-samples', 'claude-agents'] as const

const DEFAULT_WINDOW_HOURS = 72
/** `claude agents` is never asked more often than this (the task's "at most every 15 s"). */
export const MIN_CLAUDE_AGENTS_POLL_MS = 15_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collapses `.` and `..` segments in a POSIX path. */
export function normalisePath(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/') || (absolute ? '/' : '.')
}

/** `~` and `~/x` expand against `home`; a relative path resolves against `baseDir`. */
export function resolveConfigPath(path: string, baseDir: string, home: string): string {
  if (path === '~') return normalisePath(home)
  if (path.startsWith('~/')) return normalisePath(`${home}/${path.slice(2)}`)
  if (path.startsWith('/')) return normalisePath(path)
  return normalisePath(`${baseDir}/${path}`)
}

export function parentDir(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const index = trimmed.lastIndexOf('/')
  if (index < 0) return '.'
  return index === 0 ? '/' : trimmed.slice(0, index)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return strings.length === value.length ? strings : undefined
}

function parseTaskFolders(section: unknown, o: ParseConfigOptions, warnings: string[]): AdapterConfig['taskFolders'] {
  if (!isRecord(section)) {
    warnings.push('task-folders: expected an object; ignored')
    return undefined
  }
  const rawRoots = stringArray(section.roots)
  if (!rawRoots || rawRoots.length === 0) {
    warnings.push('task-folders: "roots" must be a non-empty array of paths; ignored')
    return undefined
  }
  const roots = rawRoots.map((root) => resolveConfigPath(root, o.baseDir, o.home))

  let orchestratorCwds: string[]
  const rawCwd = section.orchestratorCwd
  if (typeof rawCwd === 'string' && rawCwd.length > 0) {
    orchestratorCwds = [resolveConfigPath(rawCwd, o.baseDir, o.home)]
  } else if (Array.isArray(rawCwd) && stringArray(rawCwd)?.length) {
    orchestratorCwds = (stringArray(rawCwd) ?? []).map((cwd) => resolveConfigPath(cwd, o.baseDir, o.home))
  } else {
    if (rawCwd !== undefined) warnings.push('task-folders: "orchestratorCwd" must be a path or an array of paths; using the roots\' parents')
    orchestratorCwds = roots.map(parentDir)
  }

  let windowHours: number | null = o.fixtureMode ? null : DEFAULT_WINDOW_HOURS
  const rawWindow = section.windowHours
  if (rawWindow === null) {
    windowHours = null
  } else if (typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0) {
    windowHours = rawWindow
  } else if (rawWindow !== undefined) {
    warnings.push(`task-folders: "windowHours" must be a positive number; using ${windowHours ?? 'no window'}`)
  }
  return { roots, orchestratorCwds, windowHours }
}

function parseQuotaSamples(section: unknown, o: ParseConfigOptions, warnings: string[]): AdapterConfig['quotaSamples'] {
  if (!isRecord(section) || typeof section.file !== 'string' || section.file.length === 0) {
    warnings.push('quota-samples: "file" is required (a path, or a glob such as samples-*.jsonl); ignored')
    return undefined
  }
  return { file: resolveConfigPath(section.file, o.baseDir, o.home) }
}

function parseClaudeAgents(section: unknown, o: ParseConfigOptions, warnings: string[]): AdapterConfig['claudeAgents'] {
  // Off unless the file says `"enabled": true`, so a half-written section never runs a program.
  if (!isRecord(section) || section.enabled !== true) return undefined
  let bin = 'claude'
  if (typeof section.bin === 'string' && section.bin.length > 0) {
    // A bare name is looked up on PATH; anything with a slash is a path.
    bin = section.bin.includes('/') || section.bin.startsWith('~') ? resolveConfigPath(section.bin, o.baseDir, o.home) : section.bin
  } else if (section.bin !== undefined) {
    warnings.push('claude-agents: "bin" must be a string; using "claude"')
  }
  let pollMs = MIN_CLAUDE_AGENTS_POLL_MS
  if (section.pollSeconds !== undefined) {
    if (typeof section.pollSeconds === 'number' && Number.isFinite(section.pollSeconds)) {
      pollMs = Math.max(MIN_CLAUDE_AGENTS_POLL_MS, Math.round(section.pollSeconds * 1000))
    } else {
      warnings.push('claude-agents: "pollSeconds" must be a number; using 15')
    }
  }
  return { bin, pollMs }
}

export function parseConfig(text: string, o: ParseConfigOptions): ParsedConfig {
  const warnings: string[] = []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { config: {}, warnings: [`config is not valid JSON: ${err instanceof Error ? err.message.slice(0, 80) : 'parse error'}`] }
  }
  if (!isRecord(value)) return { config: {}, warnings: ['config is not a JSON object: nothing configured'] }

  for (const key of Object.keys(value)) {
    if (key !== 'adapters') warnings.push(`unknown key "${key.slice(0, 40)}" ignored`)
  }
  const adapters = value.adapters
  if (adapters === undefined) return { config: {}, warnings }
  if (!isRecord(adapters)) return { config: {}, warnings: [...warnings, '"adapters" must be an object; nothing configured'] }

  const config: AdapterConfig = {}
  for (const id of Object.keys(adapters)) {
    if (!(ADAPTER_CONFIG_IDS as readonly string[]).includes(id)) warnings.push(`unknown adapter "${id.slice(0, 40)}" ignored`)
  }
  if (adapters['task-folders'] !== undefined) config.taskFolders = parseTaskFolders(adapters['task-folders'], o, warnings)
  if (adapters['quota-samples'] !== undefined) config.quotaSamples = parseQuotaSamples(adapters['quota-samples'], o, warnings)
  if (adapters['claude-agents'] !== undefined) config.claudeAgents = parseClaudeAgents(adapters['claude-agents'], o, warnings)
  return { config, warnings }
}
