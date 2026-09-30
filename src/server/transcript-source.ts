// Discovers transcript files under a Claude config root, tails each one, and turns new lines
// (and each subagent's one-shot sidecar meta file) into AgentEvents. `fs.watch(recursive)` is
// used when available to react quickly, but a polling loop always runs underneath it — watch is
// unreliable on some file systems (PLAN.md's risk list), so it is only ever a speed-up, never
// the only way new content is found.

import { watch as fsWatch, type Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { bump } from '../core/keys.js'
import type { AgentEvent, TranscriptSourceStatus, UnparsedBreakdown } from '../core/types.js'
import { parseSubagentMeta } from '../core/transcript/meta.js'
import { classifyPath } from '../core/transcript/paths.js'
import { type ParseCtx, type ParseState, initialParseState, parseLine } from '../core/transcript/parse.js'
import { LineTailer } from './tail.js'

/** A directory listing, injectable so a test can slow it down or record what was listed. */
export type ReaddirFn = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>
/** Starts a recursive watch of `root`; the listener gets the changed path relative to root, or null
 * when the platform does not say. Returns undefined when watching is not available. */
export type WatchFn = (root: string, listener: (filename: string | null) => void) => { close(): void } | undefined

export const DEFAULT_RESCAN_MS = 5000

export interface TranscriptSourceOptions {
  root: string
  /** null disables the age window entirely (fixture mode): every file found is read. */
  sinceMs: number | null
  /** The window's size in hours, kept only to report back in getStatus(); null in fixture mode. */
  windowHours: number | null
  watch: boolean
  pollMs: number
  onEvents: (events: AgentEvent[]) => void
  nowMs: () => number
  /** A full rescan runs at most once per this many ms (default DEFAULT_RESCAN_MS). */
  rescanMs?: number
  /** Monotonic clock for the rescan throttle (default performance.now). Never `nowMs`, which
   * fixture mode freezes: a frozen clock would stop rescans for good. */
  monoMs?: () => number
  /** Default: the file system's own listing. */
  readdir?: ReaddirFn
  /** Default: `fs.watch(root, { recursive: true })`. */
  watchFn?: WatchFn
}

/** What the source has spent walking, for `doctor` (kept out of getStatus(): that value goes into
 * the World, and a counter that changes on every scan would push the World to the page for nothing). */
export interface TranscriptScanStats {
  /** Full scans since start (the initial one included). */
  scans: number
  /** Full scans started in the trailing 60 s, by monoMs. */
  scansLastMinute: number
  /** File entries the last scan walked (projects/<dir>/ and subagents/ only). */
  lastScanFiles: number
  /** Directories the last scan listed successfully (the root and projects/ included). */
  lastScanDirs: number
  /** How long the last scan took, ms, rounded. */
  lastScanMs: number
  /** Entries at the root other than projects/: never walked. */
  rootEntriesSkipped: number
  /** Highest number of scans ever running at once. The tests hold it to 1. */
  maxConcurrentScans: number
  /** The throttle in force. */
  rescanMs: number
  /** Watch callbacks received, and how many of them named a file outside projects/ (no pass). */
  watchEvents: number
  watchEventsIgnored: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The errno code (`EACCES`) when there is one, else 'error': never a message, which names paths. */
function errorCode(err: unknown): string {
  const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
  return typeof code === 'string' ? code : 'error'
}

const MAX_META_BYTES = 64 * 1024
/** A file is read at most this many pieces (8 MiB each) per poll, so one huge file cannot starve the others. */
const MAX_ROUNDS_PER_POLL = 16

/** `fs.watch(root, { recursive: true })`, or undefined where that is not supported (older Linux
 * kernels): the polling loop is the fallback then. */
const defaultWatch: WatchFn = (root, listener) => {
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      listener(typeof filename === 'string' ? filename : null)
    })
    watcher.on('error', () => {
      // fs.watch can fail asynchronously on some file systems; the polling loop keeps going.
    })
    return watcher
  } catch {
    return undefined
  }
}

function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

interface TailedFile {
  tailer: LineTailer
  ctx: ParseCtx
  state: ParseState
}

export class TranscriptSource {
  private readonly tailers = new Map<string, TailedFile>()
  private readonly excluded = new Set<string>()
  private readonly metaSeen = new Set<string>()
  private readonly watchers: { close(): void }[] = []
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private status: TranscriptSourceStatus['status'] = 'starting'
  private rootError: string | undefined
  private rootMissing = false
  private filesFound = 0
  private filesInWindow = 0
  /** The latest record `ts` actually seen in any transcript line, tracked so a sidecar meta
   * file or a diagnostic (neither of which carries its own timestamp) gets a plausible one
   * instead of nowMs() — which, in fixture mode before the caller has frozen its own clock,
   * would otherwise inject today's real wall time into an otherwise-fictional timeline. */
  private latestContentTsMs: number | undefined

  private readonly rescanMs: number
  private readonly mono: () => number
  private readonly readdir: ReaddirFn
  private readonly watchFn: WatchFn
  private scansInFlight = 0
  /** Set while a pass runs: the guard. */
  private passLoop: Promise<void> | undefined
  /** A request arrived during a pass. */
  private again = false
  private scanDirs = 0
  private scanFiles = 0
  private readonly scanStarts: number[] = []
  private readonly stats = {
    scans: 0,
    lastScanFiles: 0,
    lastScanDirs: 0,
    lastScanMs: 0,
    rootEntriesSkipped: 0,
    maxConcurrentScans: 0,
    watchEvents: 0,
    watchEventsIgnored: 0,
  }

  constructor(private readonly opts: TranscriptSourceOptions) {
    this.rescanMs = opts.rescanMs ?? DEFAULT_RESCAN_MS
    this.mono = opts.monoMs ?? (() => performance.now())
    this.readdir = opts.readdir ?? ((path, options) => readdir(path, options))
    this.watchFn = opts.watchFn ?? defaultWatch
  }

  getScanStats(): TranscriptScanStats {
    this.trimScanStarts()
    return { ...this.stats, scansLastMinute: this.scanStarts.length, rescanMs: this.rescanMs }
  }

  /** Resolves when no pass is running (tests, and anything that must read after a settle). */
  async whenIdle(): Promise<void> {
    while (this.passLoop) await this.passLoop
  }

  private trimScanStarts(): void {
    const cutoff = this.mono() - 60_000
    while (this.scanStarts.length > 0 && (this.scanStarts[0] as number) < cutoff) this.scanStarts.shift()
  }

  getStatus(): TranscriptSourceStatus {
    return {
      status: this.status,
      root: this.opts.root,
      error: this.rootError,
      files: this.filesFound,
      inWindow: this.filesInWindow,
      windowHours: this.opts.windowHours,
      ...(this.rootMissing ? { rootMissing: true } : {}),
    }
  }

  async start(): Promise<void> {
    this.requestPass()
    await this.whenIdle()
    if (this.opts.watch) this.setupWatch()
    this.pollTimer = setInterval(() => {
      this.requestPass()
    }, this.opts.pollMs)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    for (const watcher of this.watchers) watcher.close()
    this.watchers.length = 0
  }

  private nowIso(): string {
    return new Date(this.latestContentTsMs ?? this.opts.nowMs()).toISOString()
  }

  private emitDiagnostic(sourceError: string): void {
    this.opts.onEvents([{ t: 'diagnostics', ts: this.nowIso(), unparsed: 0, unknownTypes: {}, versions: [], sourceError }])
  }

  private async scan(): Promise<void> {
    if (this.stopped) return
    this.scansInFlight += 1
    this.stats.maxConcurrentScans = Math.max(this.stats.maxConcurrentScans, this.scansInFlight)
    const started = this.mono()
    this.stats.scans += 1
    this.scanStarts.push(started)
    if (this.scanStarts.length > 1000) this.scanStarts.shift()
    this.scanDirs = 0
    this.scanFiles = 0
    try {
      await this.scanOnce()
    } finally {
      this.scansInFlight -= 1
      this.stats.lastScanFiles = this.scanFiles
      this.stats.lastScanDirs = this.scanDirs
      this.stats.lastScanMs = Math.round(this.mono() - started)
    }
  }

  private async scanOnce(): Promise<void> {
    let rootEntries
    try {
      rootEntries = await this.readdir(this.opts.root, { withFileTypes: true })
      this.scanDirs += 1
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        // No folder yet: Claude Code has never run here. That is a first run, not a failure; the
        // page says how to begin, and the folder is picked up when it appears.
        this.status = 'live'
        this.rootError = undefined
        this.rootMissing = true
        this.filesFound = 0
        this.filesInWindow = 0
        return
      }
      this.status = 'unreadable'
      this.rootError = errorMessage(err)
      this.rootMissing = false
      return
    }
    this.status = 'live'
    this.rootError = undefined
    this.rootMissing = false

    // Transcripts live under projects/ and nowhere else. The rest of the config folder (debug logs,
    // file history, shell snapshots, ...) is huge and busy, and is never listed.
    const hasProjects = rootEntries.some((entry) => entry.name === 'projects' && entry.isDirectory())
    this.stats.rootEntriesSkipped = rootEntries.length - (hasProjects ? 1 : 0)

    const files: string[] = []
    const take = (absPath: string): void => {
      this.scanFiles += 1
      // Known files need no second look here; maybeRegister would make the same choice.
      if (!this.tailers.has(absPath) && !this.excluded.has(absPath) && !this.metaSeen.has(absPath)) files.push(absPath)
    }
    if (hasProjects) {
      const projectsDir = join(this.opts.root, 'projects')
      for (const project of await this.list(projectsDir)) {
        if (!project.isDirectory()) continue // a file right under projects/ is no transcript
        const projectDir = join(projectsDir, project.name)
        for (const entry of await this.list(projectDir)) {
          if (!entry.isDirectory()) {
            take(join(projectDir, entry.name))
            continue
          }
          const subagentsDir = join(projectDir, entry.name, 'subagents')
          for (const sub of await this.list(subagentsDir)) {
            if (!sub.isDirectory()) take(join(subagentsDir, sub.name))
          }
        }
      }
    }

    // Transcript files first, sidecar meta files second: readMeta()'s subagent_link event gets
    // its timestamp from latestContentTsMs (see nowIso()), which only reflects reality once at
    // least one transcript file has actually been read — directory listing order does not
    // otherwise guarantee that happens first.
    const metaFiles: string[] = []
    const otherFiles: string[] = []
    for (const absPath of files) {
      const rel = toPosixRelative(this.opts.root, absPath)
      if (classifyPath(rel).kind === 'subagent-meta') metaFiles.push(absPath)
      else otherFiles.push(absPath)
    }

    for (const absPath of otherFiles) {
      if (this.stopped) return
      await this.maybeRegister(absPath)
    }
    for (const absPath of metaFiles) {
      if (this.stopped) return
      await this.maybeRegister(absPath)
    }
  }

  /** One directory's entries; [] when it is gone, is not a directory, or cannot be read (a folder
   * that vanished mid-walk is not a root-level failure). */
  private async list(dir: string): Promise<Dirent[]> {
    try {
      const entries = await this.readdir(dir, { withFileTypes: true })
      this.scanDirs += 1
      return entries
    } catch {
      return []
    }
  }

  private async maybeRegister(absPath: string): Promise<void> {
    const rel = toPosixRelative(this.opts.root, absPath)
    const classification = classifyPath(rel)
    if (classification.kind === 'ignore') return

    if (classification.kind === 'subagent-meta') {
      if (this.metaSeen.has(absPath)) return
      this.metaSeen.add(absPath)
      await this.readMeta(absPath, classification.parentId, classification.agentId)
      return
    }

    if (this.tailers.has(absPath) || this.excluded.has(absPath)) return

    let mtimeMs: number
    try {
      const info = await stat(absPath)
      if (!info.isFile()) {
        // A symlink to a directory, a FIFO, a device: never opened (S1-5), said once.
        this.excluded.add(absPath)
        this.emitDiagnostic(`${this.label(absPath)}: not a regular file, skipped`)
        return
      }
      mtimeMs = info.mtimeMs
    } catch {
      return // raced with a delete; the next scan simply will not see it either
    }

    this.filesFound += 1

    if (this.opts.sinceMs !== null && mtimeMs < this.opts.sinceMs) {
      this.excluded.add(absPath)
      return
    }
    this.filesInWindow += 1

    const ctx: ParseCtx =
      classification.kind === 'session'
        ? { agentId: classification.sessionId, kind: 'session' }
        : { agentId: classification.agentId, kind: 'subagent', parentId: classification.parentId }

    this.tailers.set(absPath, { tailer: new LineTailer(absPath), ctx, state: initialParseState() })
    await this.pollOne(absPath)
  }

  private async readMeta(absPath: string, parentId: string, agentId: string): Promise<void> {
    let text: string
    try {
      const info = await stat(absPath)
      if (!info.isFile() || info.size > MAX_META_BYTES) {
        this.emitDiagnostic(`${this.label(absPath)}: not a small regular file, skipped`)
        return
      }
      text = await readFile(absPath, 'utf8')
    } catch (err) {
      this.emitDiagnostic(`cannot read ${this.label(absPath)}: ${errorCode(err)}`)
      return
    }
    const result = parseSubagentMeta(text)
    if (!result.ok) {
      this.emitDiagnostic(`invalid subagent meta ${this.label(absPath)}: ${result.error}`)
      return
    }
    this.opts.onEvents([
      {
        t: 'subagent_link',
        ts: this.nowIso(),
        agentId,
        parentId,
        spawnToolUseId: result.meta.toolUseId,
        agentType: result.meta.agentType,
        name: result.meta.name,
      },
    ])
  }

  /** Reads what a file has, in bounded pieces: each piece is parsed and handed on before the next
   * is read. Never throws (S1-5): a failure becomes a source error and the other files carry on. */
  private async pollOne(absPath: string): Promise<void> {
    try {
      for (let rounds = 0; rounds < MAX_ROUNDS_PER_POLL; rounds++) {
        if (this.stopped || !(await this.pollPiece(absPath))) return
      }
    } catch (err) {
      this.report(`${this.label(absPath)}: unexpected error: ${errorCode(err)}`)
    }
  }

  /** One bounded read of one file. True when the file has more to read right now. */
  private async pollPiece(absPath: string): Promise<boolean> {
    const entry = this.tailers.get(absPath)
    if (!entry) return false

    const result = await entry.tailer.poll()
    if (result.error) this.emitDiagnostic(`${this.label(absPath)}: ${result.error}`)
    if (result.lines.length === 0 && result.tooLong === 0) return result.more

    const events: AgentEvent[] = []
    let unparsed = result.tooLong
    const unknownTypes: Record<string, number> = {}
    const unparsedBy: UnparsedBreakdown = {}
    if (result.tooLong > 0) bump((unparsedBy.too_long ??= {}), '(none)', result.tooLong)
    for (const line of result.lines) {
      const parsed = parseLine(line, entry.ctx, entry.state)
      entry.state = parsed.state
      events.push(...parsed.events)
      if (parsed.unparsed) {
        unparsed += 1
        if (parsed.unknownType !== undefined) bump(unknownTypes, parsed.unknownType)
        if (parsed.reason !== undefined && parsed.recordType !== undefined) {
          bump((unparsedBy[parsed.reason] ??= {}), parsed.recordType)
        }
      }
    }
    for (const event of events) {
      const parsed = Date.parse(event.ts)
      if (!Number.isNaN(parsed) && (this.latestContentTsMs === undefined || parsed > this.latestContentTsMs)) {
        this.latestContentTsMs = parsed
      }
    }
    if (unparsed > 0) {
      events.push({ t: 'diagnostics', ts: this.nowIso(), unparsed, unknownTypes, unparsedBy, versions: [] })
    }
    if (events.length > 0) this.opts.onEvents(events)
    return result.more
  }

  /** Asks for a pass. Only one runs at a time (a walk that starts before the last one ended is what
   * once grew the heap to gigabytes); a request that arrives during a pass is not dropped, since a
   * file may have grown after that pass read it, but asks for exactly one more. Never throws: it
   * runs from timers and watch callbacks, where nothing would catch it. */
  private requestPass(): void {
    if (this.stopped) return
    if (this.passLoop) {
      this.again = true
      return
    }
    this.passLoop = this.runPasses().finally(() => {
      this.passLoop = undefined
    })
  }

  private async runPasses(): Promise<void> {
    try {
      do {
        this.again = false
        await this.pass()
      } while (this.again && !this.stopped)
    } catch (err) {
      this.report(`transcript scan: unexpected error: ${errorCode(err)}`)
    }
  }

  private async pass(): Promise<void> {
    // Files registered by the scan were read by it; only the ones known before need a poll.
    const known = [...this.tailers.keys()]
    await this.scan() // discovers new files; a no-op for ones already registered or excluded
    for (const absPath of known) {
      if (this.stopped) return
      await this.pollOne(absPath)
    }
  }

  /** A source error that cannot itself throw: the consumer of the events may be what failed. */
  private report(message: string): void {
    try {
      this.emitDiagnostic(message)
    } catch {
      // nothing more can be done from here
    }
  }

  /** `<project>/<file>` for messages: never the absolute path, whose directory names the cwd. */
  private label(absPath: string): string {
    const parts = toPosixRelative(this.opts.root, absPath).split('/')
    const project = (parts[1] ?? '').split('-').filter((part) => part !== '').pop()
    const file = parts[parts.length - 1] ?? ''
    return project ? `${project}/${file}` : file
  }

  private setupWatch(): void {
    // Undefined when watching is not supported here (older Linux kernels): the polling loop set up
    // in start() is the fallback, and it is already running.
    const watcher = this.watchFn(this.opts.root, () => {
      if (this.stopped) return
      this.stats.watchEvents += 1
      this.requestPass()
    })
    if (watcher) this.watchers.push(watcher)
  }
}
