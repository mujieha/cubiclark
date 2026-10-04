// The task-folders adapter: a root containing `<task>/TASK.md` (and, when the task has them,
// `STATUS.md`, `LOG.md` and `session`) becomes tasks, timelines and session links. Read-only. A
// file is re-read only when its mtime or size changed, so a poll over ~100 folders is a few
// hundred stats. detect() and snapshot() never throw: what cannot be read is named in
// diagnostics.errors (task and file name only, never an absolute path).

import { constants, watch as fsWatch, type FSWatcher } from 'node:fs'
import { lstat, open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdapterConfig } from '../../core/adapters/config.js'
import { buildTask, taskLinks } from '../../core/adapters/task-folder.js'
import { isSafeKey } from '../../core/keys.js'
import type { AdapterDescription, AdapterEnv, AdapterSnapshot, AgentLink, OrchestrationAdapter } from '../../core/adapters/types.js'
import type { Task } from '../../core/types.js'

type TaskFoldersConfig = NonNullable<AdapterConfig['taskFolders']>

interface CachedFile {
  mtimeMs: number
  size: number
  text: string
}

const WATCH_DEBOUNCE_MS = 300

/** How much of a file is read (S1-10): the start of TASK.md, STATUS.md and `session`, the end of
 * LOG.md (its newest lines matter, and it only grows). */
interface ReadLimit {
  bytes: number
  tail: boolean
}
export const HEAD_LIMIT: ReadLimit = { bytes: 64 * 1024, tail: false }
export const LOG_LIMIT: ReadLimit = { bytes: 1024 * 1024, tail: true }

type OpenFile = (path: string, flags: number) => Promise<Pick<FileHandle, 'stat' | 'read' | 'close'>>

/** The file's text, at most `limit.bytes` of it, from ONE descriptor: open, fstat, read. The size is the
 * descriptor's own, so a file that grew after the caller's lstat is still read only up to the cap, and
 * what was checked is what is read (R2-9). A symlink, or a FIFO swapped in after the lstat, is not
 * followed or waited for (O_NOFOLLOW, O_NONBLOCK) and a non-regular file is refused. */
export async function readBounded(path: string, limit: ReadLimit, openFile: OpenFile = open): Promise<string> {
  const handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'not a regular file' })
    const cut = info.size > limit.bytes
    const length = Math.min(info.size, limit.bytes)
    const start = limit.tail && cut ? info.size - length : 0
    const buffer = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const text = buffer.toString('utf8', 0, filled)
    // A tail that was cut begins in the middle of a line: that line is dropped, not misread.
    return limit.tail && cut ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

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
  private async readCached(path: string, label: string, seen: Set<string>, errors: string[], limit: ReadLimit = HEAD_LIMIT): Promise<string | undefined> {
    let info
    try {
      // lstat: a symlink is not followed, so a task folder cannot pull in any file the user can read (S1-16).
      info = await lstat(path)
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
      const text = await readBounded(path, limit)
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
    let skippedUnsafe = 0
    const nowMs = this.env.nowMs()
    // STATUS.md's time is clamped to wall time, which is not the replay clock in a replay.
    const wallMs = (this.env.wallMs ?? this.env.nowMs)()
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
        // A folder called `constructor` (or `__proto__`, ...) would find an inherited property wherever
        // the World's tasks are looked up (S1-1 for task ids, R2-5): it is not a task.
        if (!isSafeKey(entry.name)) {
          skippedUnsafe += 1
          continue
        }
        seenIds.add(entry.name)

        const statusPath = join(dir, 'STATUS.md')
        const statusMd = await this.readCached(statusPath, `${entry.name}/STATUS.md`, seenPaths, errors)
        let statusMtimeMs: number | undefined
        if (statusMd !== undefined) statusMtimeMs = this.cache.get(statusPath)?.mtimeMs
        const logText = await this.readCached(join(dir, 'LOG.md'), `${entry.name}/LOG.md`, seenPaths, errors, LOG_LIMIT)
        const sessionFile = await this.readCached(join(dir, 'session'), `${entry.name}/session`, seenPaths, errors)

        const built = buildTask({ id: entry.name, taskMd, statusMd, statusMtimeMs, logText, sessionFile, nowMs: wallMs, phaseNowMs: nowMs })
        const lastMs = built.task.lastActivity ? Date.parse(built.task.lastActivity) : Number.NEGATIVE_INFINITY
        if (Math.max(lastMs, statusMtimeMs ?? Number.NEGATIVE_INFINITY) < windowStart) continue

        tasks.push(built.task)
        links.push(...taskLinks(built))
        unparsed += built.unparsedLogLines
      }
    }

    if (skippedUnsafe > 0) errors.push(`skipped ${skippedUnsafe} task folder${skippedUnsafe === 1 ? '' : 's'} named like an object property`)
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
