// The task-folders adapter: a root containing `<task>/TASK.md` (and, when the task has them,
// `STATUS.md`, `LOG.md` and `session`) becomes tasks, timelines and session links. Read-only. A
// file is re-read only when its mtime or size changed, so a poll over ~100 folders is a few
// hundred stats. detect() and snapshot() never throw: what cannot be read is named in
// diagnostics.errors (task and file name only, never an absolute path).

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdapterConfig } from '../../core/adapters/config.js'
import { buildTask, taskLinks } from '../../core/adapters/task-folder.js'
import type { AdapterDescription, AdapterEnv, AdapterSnapshot, AgentLink, OrchestrationAdapter } from '../../core/adapters/types.js'
import type { Task } from '../../core/types.js'

type TaskFoldersConfig = NonNullable<AdapterConfig['taskFolders']>

interface CachedFile {
  mtimeMs: number
  size: number
  text: string
}

const WATCH_DEBOUNCE_MS = 300

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? ((err as NodeJS.ErrnoException).code as string)
    : 'read error'
}

/** A directory that can be listed: one that exists but cannot be read is as good as absent. */
async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false
    await readdir(path)
    return true
  } catch {
    return false
  }
}

export class TaskFoldersAdapter implements OrchestrationAdapter {
  readonly id = 'task-folders'
  readonly pollMs = 5000
  /** How many file reads (not stats) snapshot() has done: tests check the mtime cache with it. */
  readCount = 0
  /** How many tasks the last snapshot found, for the adapter's status line. */
  lastTaskCount = 0
  lastUnparsedLogLines = 0
  private cache = new Map<string, CachedFile>()

  constructor(
    private readonly config: TaskFoldersConfig,
    private readonly env: AdapterEnv
  ) {}

  async detect(): Promise<boolean> {
    try {
      for (const root of this.config.roots) if (await isReadableDirectory(root)) return true
    } catch {
      // never throws
    }
    return false
  }

  /** The file's text, from the cache when its mtime and size are unchanged. Undefined when the
   * file does not exist; an unreadable file adds an error and is also undefined. */
  private async readCached(path: string, label: string, seen: Set<string>, errors: string[]): Promise<string | undefined> {
    let info
    try {
      info = await stat(path)
    } catch (err) {
      const code = errorCode(err)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') errors.push(`cannot read ${label}: ${code}`)
      return undefined
    }
    if (!info.isFile()) return undefined
    seen.add(path)
    const cached = this.cache.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.text
    try {
      this.readCount += 1
      const text = await readFile(path, 'utf8')
      this.cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text })
      return text
    } catch (err) {
      errors.push(`cannot read ${label}: ${errorCode(err)}`)
      return undefined
    }
  }

  async snapshot(): Promise<AdapterSnapshot> {
    const errors: string[] = []
    const tasks: Task[] = []
    const links: AgentLink[] = []
    const seenPaths = new Set<string>()
    const seenIds = new Set<string>()
    let unparsed = 0
    const nowMs = this.env.nowMs()
    const windowStart = this.config.windowHours === null ? Number.NEGATIVE_INFINITY : nowMs - this.config.windowHours * 3_600_000

    for (const root of this.config.roots) {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch (err) {
        errors.push(`cannot read a tasks root: ${errorCode(err)}`)
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (!entry.isDirectory() || seenIds.has(entry.name)) continue
        const dir = join(root, entry.name)
        const taskMd = await this.readCached(join(dir, 'TASK.md'), `${entry.name}/TASK.md`, seenPaths, errors)
        if (taskMd === undefined) continue // not a task folder
        seenIds.add(entry.name)

        const statusPath = join(dir, 'STATUS.md')
        const statusMd = await this.readCached(statusPath, `${entry.name}/STATUS.md`, seenPaths, errors)
        let statusMtimeMs: number | undefined
        if (statusMd !== undefined) statusMtimeMs = this.cache.get(statusPath)?.mtimeMs
        const logText = await this.readCached(join(dir, 'LOG.md'), `${entry.name}/LOG.md`, seenPaths, errors)
        const sessionFile = await this.readCached(join(dir, 'session'), `${entry.name}/session`, seenPaths, errors)

        const built = buildTask({ id: entry.name, taskMd, statusMd, statusMtimeMs, logText, sessionFile, nowMs })
        const lastMs = built.task.lastActivity ? Date.parse(built.task.lastActivity) : Number.NEGATIVE_INFINITY
        if (Math.max(lastMs, statusMtimeMs ?? Number.NEGATIVE_INFINITY) < windowStart) continue

        tasks.push(built.task)
        links.push(...taskLinks(built))
        unparsed += built.unparsedLogLines
      }
    }

    for (const path of this.cache.keys()) if (!seenPaths.has(path)) this.cache.delete(path)
    this.lastTaskCount = tasks.length
    this.lastUnparsedLogLines = unparsed
    return { tasks, links, orchestratorCwds: [...this.config.orchestratorCwds], diagnostics: { unparsed, errors } }
  }

  describe(): AdapterDescription {
    const roots = this.config.roots.length
    const unparsed = this.lastUnparsedLogLines
    const detail = `${this.lastTaskCount} task${this.lastTaskCount === 1 ? '' : 's'} in ${roots} root${roots === 1 ? '' : 's'}`
    return { detail: unparsed > 0 ? `${detail} · ${unparsed} unparsed log line${unparsed === 1 ? '' : 's'}` : detail }
  }

  watch(onChange: () => void): () => void {
    const watchers: FSWatcher[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const fire = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        onChange()
      }, WATCH_DEBOUNCE_MS)
    }
    for (const root of this.config.roots) {
      try {
        const watcher = fsWatch(root, { recursive: true }, fire)
        watcher.on('error', () => {
          // the poll is the fallback
        })
        watchers.push(watcher)
      } catch {
        // fs.watch(recursive) is not available here: the poll is the fallback
      }
    }
    return () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      for (const watcher of watchers) watcher.close()
    }
  }
}
