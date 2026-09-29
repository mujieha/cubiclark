// Discovers transcript files under a Claude config root, tails each one, and turns new lines
// (and each subagent's one-shot sidecar meta file) into AgentEvents. `fs.watch(recursive)` is
// used when available to react quickly, but a polling loop always runs underneath it — watch is
// unreliable on some file systems (PLAN.md's risk list), so it is only ever a speed-up, never
// the only way new content is found.

import { watch as fsWatch } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { AgentEvent, TranscriptSourceStatus } from '../core/types.js'
import { parseSubagentMeta } from '../core/transcript/meta.js'
import { classifyPath } from '../core/transcript/paths.js'
import { type ParseCtx, type ParseState, initialParseState, parseLine } from '../core/transcript/parse.js'
import { LineTailer } from './tail.js'

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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  private readonly watchers: ReturnType<typeof fsWatch>[] = []
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private status: TranscriptSourceStatus['status'] = 'starting'
  private rootError: string | undefined
  private filesFound = 0
  private filesInWindow = 0
  /** The latest record `ts` actually seen in any transcript line, tracked so a sidecar meta
   * file or a diagnostic (neither of which carries its own timestamp) gets a plausible one
   * instead of nowMs() — which, in fixture mode before the caller has frozen its own clock,
   * would otherwise inject today's real wall time into an otherwise-fictional timeline. */
  private latestContentTsMs: number | undefined

  constructor(private readonly opts: TranscriptSourceOptions) {}

  getStatus(): TranscriptSourceStatus {
    return {
      status: this.status,
      root: this.opts.root,
      error: this.rootError,
      files: this.filesFound,
      inWindow: this.filesInWindow,
      windowHours: this.opts.windowHours,
    }
  }

  async start(): Promise<void> {
    await this.scan()
    if (this.opts.watch) this.setupWatch()
    this.pollTimer = setInterval(() => {
      void this.pollAll()
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
    let rootEntries
    try {
      rootEntries = await readdir(this.opts.root, { withFileTypes: true })
    } catch (err) {
      this.status = 'unreadable'
      this.rootError = errorMessage(err)
      return
    }
    this.status = 'live'
    this.rootError = undefined

    const files: string[] = []
    for (const entry of rootEntries) {
      const full = join(this.opts.root, entry.name)
      if (entry.isDirectory()) files.push(...(await this.walkTolerant(full)))
      else files.push(full)
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

    for (const absPath of otherFiles) await this.maybeRegister(absPath)
    for (const absPath of metaFiles) await this.maybeRegister(absPath)
  }

  private async walkTolerant(dir: string): Promise<string[]> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return [] // a subdirectory that vanished mid-walk is not a root-level failure
    }
    const out: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await this.walkTolerant(full)))
      else out.push(full)
    }
    return out
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
      mtimeMs = (await stat(absPath)).mtimeMs
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
      text = await readFile(absPath, 'utf8')
    } catch (err) {
      this.emitDiagnostic(`cannot read ${absPath}: ${errorMessage(err)}`)
      return
    }
    const result = parseSubagentMeta(text)
    if (!result.ok) {
      this.emitDiagnostic(`invalid subagent meta at ${absPath}: ${result.error}`)
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

  private async pollOne(absPath: string): Promise<void> {
    const entry = this.tailers.get(absPath)
    if (!entry) return

    const result = await entry.tailer.poll()
    if (result.error) this.emitDiagnostic(`${absPath}: ${result.error}`)
    if (result.lines.length === 0) return

    const events: AgentEvent[] = []
    let unparsed = 0
    const unknownTypes: Record<string, number> = {}
    for (const line of result.lines) {
      const parsed = parseLine(line, entry.ctx, entry.state)
      entry.state = parsed.state
      events.push(...parsed.events)
      if (parsed.unparsed) {
        unparsed += 1
        if (parsed.unknownType !== undefined) {
          unknownTypes[parsed.unknownType] = (unknownTypes[parsed.unknownType] ?? 0) + 1
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
      events.push({ t: 'diagnostics', ts: this.nowIso(), unparsed, unknownTypes, versions: [] })
    }
    if (events.length > 0) this.opts.onEvents(events)
  }

  private async pollAll(): Promise<void> {
    if (this.stopped) return
    await this.scan() // discovers new files; a no-op for ones already registered or excluded
    for (const absPath of this.tailers.keys()) {
      if (this.stopped) return
      await this.pollOne(absPath)
    }
  }

  private setupWatch(): void {
    try {
      const watcher = fsWatch(this.opts.root, { recursive: true }, () => {
        if (!this.stopped) void this.pollAll()
      })
      watcher.on('error', () => {
        // fs.watch can fail asynchronously on some file systems; the polling loop keeps going.
      })
      this.watchers.push(watcher)
    } catch {
      // fs.watch(recursive) is not supported on this platform (older Linux kernels); the
      // polling loop set up in start() is the fallback, and it is already running.
    }
  }
}
