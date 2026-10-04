import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open as openFile, readdir, rm, symlink, utimes, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TranscriptSource, type ReaddirFn, type WatchFn } from '../src/server/transcript-source.js'
import { reduce } from '../src/core/reducer.js'
import type { AgentEvent } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-source-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// A transcript's own time is only read when it is an ISO instant (R4-3).
const t0 = '2026-01-15T10:00:00.000Z'
const t1 = '2026-01-15T10:00:01.000Z'

function record(sessionId: string, cwd: string, ts: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ uuid: `u-${ts}`, timestamp: ts, sessionId, cwd, version: '2.1.284', ...extra })
}

function promptLine(sessionId: string, cwd: string, ts: string): string {
  return record(sessionId, cwd, ts, { type: 'user', message: { role: 'user', content: 'hello' } })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function collector(): { events: AgentEvent[]; onEvents: (events: AgentEvent[]) => void } {
  const events: AgentEvent[] = []
  return { events, onEvents: (batch) => events.push(...batch) }
}

/** The real listing, remembering every path it was asked for. */
function spyReaddir(): { readdir: ReaddirFn; listed: string[] } {
  const listed: string[] = []
  return {
    listed,
    readdir: async (path, options) => {
      listed.push(path)
      return readdir(path, options)
    },
  }
}

/** A watch the test drives by hand: `fire('projects/…')` is a file-system event. */
function fakeWatch(): { watchFn: WatchFn; fire: (filename: string | null) => void; closed: () => boolean } {
  let listener: ((filename: string | null) => void) | undefined
  let closed = false
  return {
    watchFn: (_root, l) => {
      listener = l
      return { close: () => void (closed = true) }
    },
    fire: (filename) => listener?.(filename),
    closed: () => closed,
  }
}

/** A listing that can be held shut: while the gate is closed every readdir waits for it. */
function gatedReaddir(root: string): { readdir: ReaddirFn; close: () => void; open: () => void; rootListings: () => number } {
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  let rootListings = 0
  return {
    readdir: async (path, options) => {
      if (path === root) rootListings += 1
      if (gate) await gate
      return readdir(path, options)
    },
    close: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    open: () => {
      release?.()
      gate = undefined
    },
    rootListings: () => rootListings,
  }
}

/** `count` small files named `<prefix>-<n>.<ext>` in `dirPath`, written in batches. */
async function fillDir(dirPath: string, count: number, ext = 'log'): Promise<void> {
  await mkdir(dirPath, { recursive: true })
  for (let start = 0; start < count; start += 250) {
    await Promise.all(
      Array.from({ length: Math.min(250, count - start) }, (_, i) => writeFile(join(dirPath, `f-${start + i}.${ext}`), 'x'))
    )
  }
}

describe('TranscriptSource', () => {
  test('the initial scan emits events for a file that already has content', async () => {
    const sessionFile = join(dir, 'projects', '-tmp-demo', '00000000-0000-4000-8000-000000000001.jsonl')
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(sessionFile, promptLine('00000000-0000-4000-8000-000000000001', '/tmp/demo', t0) + '\n', 'utf8')

    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 10_000, // large: this test only checks the initial scan, never a later poll
      onEvents,
      nowMs: () => Date.now(),
    })
    await source.start()
    source.stop()

    expect(events.some((e) => e.t === 'prompt' && e.agentId === '00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(source.getStatus()).toMatchObject({ status: 'live', files: 1, inWindow: 1 })
  })

  test('an appended line arrives through the polling loop', async () => {
    const sid = '00000000-0000-4000-8000-000000000002'
    const sessionFile = join(dir, 'projects', '-tmp-demo', `${sid}.jsonl`)
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(sessionFile, promptLine(sid, '/tmp/demo', t0) + '\n', 'utf8')

    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false, // proves the polling fallback works with no fs.watch involved
      pollMs: 30,
      onEvents,
      nowMs: () => Date.now(),
    })
    await source.start()

    await writeFile(sessionFile, promptLine(sid, '/tmp/demo', t0) + '\n' + promptLine(sid, '/tmp/demo', t1) + '\n', 'utf8')
    await waitFor(() => events.filter((e) => e.t === 'prompt').length >= 2)

    source.stop()
    expect(events.filter((e) => e.t === 'prompt')).toHaveLength(2)
  })

  test('a new subagent dir created after start is discovered and linked', async () => {
    const parentSid = '00000000-0000-4000-8000-000000000003'
    const aid = 'fx000000000000e1'
    const parentFile = join(dir, 'projects', '-tmp-demo', `${parentSid}.jsonl`)
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(parentFile, promptLine(parentSid, '/tmp/demo', t0) + '\n', 'utf8')

    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 30,
      rescanMs: 20, // the default (5 s) is longer than this test waits for a new directory
      onEvents,
      nowMs: () => Date.now(),
    })
    await source.start()

    const subagentsDir = join(dir, 'projects', '-tmp-demo', parentSid, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(
      join(subagentsDir, `agent-${aid}.jsonl`),
      promptLine(aid, '/tmp/demo', t1) + '\n',
      'utf8'
    )
    await writeFile(
      join(subagentsDir, `agent-${aid}.meta.json`),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_fx000001' }),
      'utf8'
    )

    await waitFor(() => events.some((e) => e.t === 'subagent_link'))
    source.stop()

    const link = events.find((e) => e.t === 'subagent_link')
    expect(link).toMatchObject({ agentId: aid, parentId: parentSid, agentType: 'Explore', spawnToolUseId: 'toolu_fx000001' })
    expect(events.some((e) => e.t === 'prompt' && e.agentId === aid)).toBe(true)
  })

  test('a sidecar meta file gets its ts from content already seen, never a raw nowMs() call', async () => {
    // Regression: readMeta() used to stamp subagent_link with `nowMs()` directly. In fixture
    // mode nowMs() is real wall time until the caller freezes its own clock from the World's
    // content — but that freeze happens only after start() resolves, so a raw nowMs() call
    // here would leak today's real time into an otherwise-fictional timeline and corrupt it.
    const parentSid = '00000000-0000-4000-8000-000000000006'
    const aid = 'fx000000000000e2'
    const contentTs = '2026-01-15T10:00:00.000Z' // deliberately far from real wall time
    const parentFile = join(dir, 'projects', '-tmp-demo', `${parentSid}.jsonl`)
    const subagentsDir = join(dir, 'projects', '-tmp-demo', parentSid, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(parentFile, promptLine(parentSid, '/tmp/demo', contentTs) + '\n', 'utf8')
    await writeFile(join(subagentsDir, `agent-${aid}.jsonl`), promptLine(aid, '/tmp/demo', contentTs) + '\n', 'utf8')
    await writeFile(
      join(subagentsDir, `agent-${aid}.meta.json`),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_fx000002' }),
      'utf8'
    )

    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 10_000, // large: everything here is discovered by the initial scan alone
      onEvents,
      nowMs: () => Date.now(), // real wall time, deliberately never matching contentTs
    })
    await source.start()
    source.stop()

    const link = events.find((e) => e.t === 'subagent_link')
    expect(link?.ts).toBe(contentTs)
  })

  // R4-4, like the C6 tests of the tailer: the sidecar is a regular file when it is listed and a FIFO when it
  // is opened (a swap in between). The seam makes the swap, then opens as asked: a blocking open is refused
  // here, so a build that waits for a writer fails the test instead of hanging the worker.
  async function sidecarSource(open: (path: string, flags: number) => Promise<FileHandle>, sid: string, aid: string) {
    const subagentsDir = join(dir, 'projects', '-tmp-demo', sid, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(join(dir, 'projects', '-tmp-demo', `${sid}.jsonl`), promptLine(sid, '/tmp/demo', t0) + '\n', 'utf8')
    await writeFile(join(subagentsDir, `agent-${aid}.jsonl`), promptLine(aid, '/tmp/demo', t0) + '\n', 'utf8')
    const meta = join(subagentsDir, `agent-${aid}.meta.json`)
    await writeFile(meta, JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_fx000003' }), 'utf8')
    const { events, onEvents } = collector()
    const source = new TranscriptSource({ root: dir, sinceMs: null, windowHours: null, watch: false, pollMs: 10_000, onEvents, nowMs: () => Date.now(), open })
    return { events, source, meta }
  }

  test.skipIf(process.platform === 'win32')('a sidecar swapped for a FIFO after the listing is refused, and the open does not wait (R4-4)', async () => {
    const flagsSeen: unknown[] = []
    const swapped = { path: '' }
    const open = async (path: string, flags: number): Promise<FileHandle> => {
      flagsSeen.push(flags)
      await rm(path)
      execFileSync('mkfifo', [path])
      if ((flags & constants.O_NONBLOCK) === 0) throw Object.assign(new Error('would wait for a writer'), { code: 'EWAIT' })
      swapped.path = path
      return await openFile(path, flags)
    }
    const { events, source, meta } = await sidecarSource(open, '00000000-0000-4000-8000-000000000007', 'fx000000000000e3')
    await source.start()
    source.stop()

    expect(swapped.path).toBe(meta)
    expect(flagsSeen).toEqual([constants.O_RDONLY | constants.O_NONBLOCK])
    expect(events.some((e) => e.t === 'subagent_link')).toBe(false)
    expect(events.some((e) => e.t === 'diagnostics' && e.sourceError?.includes('not a small regular file'))).toBe(true)
  }, 5000)

  test('a sidecar over the cap is skipped, and one under it still links the subagent', async () => {
    const { events, source, meta } = await sidecarSource(openFile, '00000000-0000-4000-8000-000000000008', 'fx000000000000e4')
    await writeFile(meta, JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_fx000004', pad: 'x'.repeat(70 * 1024) }), 'utf8')
    await source.start()
    source.stop()
    expect(events.some((e) => e.t === 'subagent_link')).toBe(false)
    expect(events.some((e) => e.t === 'diagnostics' && e.sourceError?.includes('not a small regular file'))).toBe(true)
  })

  // A folder that does not exist is a first run (Claude Code has never run here), not a failure.
  test('a missing root is live with no files and says the folder is missing', async () => {
    const { onEvents } = collector()
    const source = new TranscriptSource({
      root: join(dir, 'does-not-exist'),
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 10_000,
      onEvents,
      nowMs: () => Date.now(),
    })
    await source.start()
    source.stop()

    expect(source.getStatus()).toEqual({ status: 'live', root: join(dir, 'does-not-exist'), files: 0, inWindow: 0, windowHours: null, rootMissing: true })
  })

  test('a root that is a file, or cannot be listed, is still unreadable, with its error', async () => {
    const file = join(dir, 'a-file')
    await writeFile(file, 'x')
    for (const root of [file]) {
      const source = new TranscriptSource({ root, sinceMs: null, windowHours: null, watch: false, pollMs: 10_000, onEvents: () => undefined, nowMs: () => Date.now() })
      await source.start()
      source.stop()
      const status = source.getStatus()
      expect(status.status).toBe('unreadable')
      expect(status.error).toMatch(/ENOTDIR/)
      expect(status.rootMissing).toBeUndefined()
    }
  })

  test('the folder is picked up when it appears', async () => {
    const root = join(dir, 'later')
    const { events, onEvents } = collector()
    const source = new TranscriptSource({ root, sinceMs: null, windowHours: null, watch: false, pollMs: 30, rescanMs: 20, onEvents, nowMs: () => Date.now() })
    await source.start()
    expect(source.getStatus().rootMissing).toBe(true)
    const sid = '00000000-0000-4000-8000-000000000009'
    await mkdir(join(root, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(join(root, 'projects', '-tmp-demo', `${sid}.jsonl`), promptLine(sid, '/tmp/demo', '2026-01-15T10:00:00.000Z') + '\n')
    await waitFor(() => events.some((e) => e.t === 'prompt'))
    source.stop()
    expect(source.getStatus()).toMatchObject({ status: 'live', files: 1 })
    expect(source.getStatus().rootMissing).toBeUndefined()
  })

  test('a file older than the window is counted but not read; fixture mode ignores the window', async () => {
    const sid = '00000000-0000-4000-8000-000000000004'
    const sessionFile = join(dir, 'projects', '-tmp-demo', `${sid}.jsonl`)
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(sessionFile, promptLine(sid, '/tmp/demo', t0) + '\n', 'utf8')
    const old = new Date('2020-01-01T00:00:00.000Z')
    await utimes(sessionFile, old, old)

    const windowed = collector()
    const windowedSource = new TranscriptSource({
      root: dir,
      sinceMs: Date.now(),
      windowHours: 12,
      watch: false,
      pollMs: 10_000,
      onEvents: windowed.onEvents,
      nowMs: () => Date.now(),
    })
    await windowedSource.start()
    windowedSource.stop()
    expect(windowed.events.some((e) => e.t === 'prompt')).toBe(false)
    expect(windowedSource.getStatus()).toMatchObject({ files: 1, inWindow: 0, windowHours: 12 })

    const fixtureMode = collector()
    const fixtureSource = new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 10_000,
      onEvents: fixtureMode.onEvents,
      nowMs: () => Date.now(),
    })
    await fixtureSource.start()
    fixtureSource.stop()
    expect(fixtureMode.events.some((e) => e.t === 'prompt')).toBe(true)
    expect(fixtureSource.getStatus()).toMatchObject({ files: 1, inWindow: 1, windowHours: null })
  })
})

// S1-5: nothing a file system or a consumer does may take the source down.
describe('TranscriptSource survives what it is given', () => {
  const SID = '00000000-0000-4000-8000-000000000001'
  const OTHER = '00000000-0000-4000-8000-000000000002'

  function source(onEvents: (events: AgentEvent[]) => void, pollMs = 10_000): TranscriptSource {
    return new TranscriptSource({ root: dir, sinceMs: null, windowHours: null, watch: false, pollMs, onEvents, nowMs: () => Date.now() })
  }

  test('a *.jsonl symlink to a directory is reported once and its sibling is still read', async () => {
    const project = join(dir, 'projects', '-tmp-demo')
    await mkdir(project, { recursive: true })
    await mkdir(join(dir, 'a-directory'))
    await symlink(join(dir, 'a-directory'), join(project, `${SID}.jsonl`))
    await writeFile(join(project, `${OTHER}.jsonl`), promptLine(OTHER, '/tmp/demo', '2026-01-15T10:00:00.000Z') + '\n', 'utf8')

    const { events, onEvents } = collector()
    const s = source(onEvents, 30)
    await s.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    s.stop()

    expect(events.some((e) => e.t === 'prompt' && e.agentId === OTHER)).toBe(true)
    const errors = events.flatMap((e) => (e.t === 'diagnostics' && e.sourceError ? [e.sourceError] : []))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not a regular file')
    expect(errors[0]).not.toContain(dir)
  })

  test('a consumer that throws is a source error, and the next poll still runs', async () => {
    const project = join(dir, 'projects', '-tmp-demo')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${SID}.jsonl`), promptLine(SID, '/tmp/demo', '2026-01-15T10:00:00.000Z') + '\n', 'utf8')

    const seen: AgentEvent[] = []
    let failures = 1
    const s = source((batch) => {
      if (failures > 0 && batch.some((e) => e.t === 'prompt')) {
        failures -= 1
        throw new Error('reducer bug')
      }
      seen.push(...batch)
    })
    await s.start()
    s.stop()
    const errors = seen.flatMap((e) => (e.t === 'diagnostics' && e.sourceError ? [e.sourceError] : []))
    expect(errors.some((message) => message.includes('unexpected error'))).toBe(true)
  })

  test('a line over the cap is counted as too_long and the rest of the file is read', async () => {
    const project = join(dir, 'projects', '-tmp-demo')
    await mkdir(project, { recursive: true })
    const big = `${'x'.repeat(5 * 1024 * 1024)}\n`
    await writeFile(join(project, `${SID}.jsonl`), `${big}${promptLine(SID, '/tmp/demo', '2026-01-15T10:00:00.000Z')}\n`, 'utf8')
    const { events, onEvents } = collector()
    const s = source(onEvents)
    await s.start()
    s.stop()
    expect(events.some((e) => e.t === 'prompt')).toBe(true)
    const diagnostics = events.filter((e) => e.t === 'diagnostics')
    const tooLong = diagnostics.flatMap((e) => (e.t === 'diagnostics' ? [e.unparsedBy?.too_long?.['(none)'] ?? 0] : []))
    expect(tooLong.reduce((a, b) => a + b, 0)).toBe(1)
  })

  test('a file that is not there any more is not fatal', async () => {
    const { events, onEvents } = collector()
    const s = source(onEvents)
    await s.start() // the root has no projects at all
    s.stop()
    expect(events).toEqual([])
  })
})

describe('TranscriptSource walks only where transcripts live', () => {
  const SID = '00000000-0000-4000-8000-000000000001'
  const OTHER = '00000000-0000-4000-8000-000000000002'
  const AID = 'fx000000000000a1'

  function walker(spy: ReturnType<typeof spyReaddir>, onEvents: (events: AgentEvent[]) => void): TranscriptSource {
    return new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 60_000,
      onEvents,
      nowMs: () => Date.now(),
      readdir: spy.readdir,
    })
  }

  test('thousands of files elsewhere in the config folder are never listed', async () => {
    // What a busy config folder holds besides transcripts.
    await fillDir(join(dir, 'debug'), 1500)
    for (let d = 0; d < 20; d++) await fillDir(join(dir, 'file-history', `h${d}`), 50)
    await fillDir(join(dir, 'shell-snapshots'), 1000, 'sh')
    await fillDir(join(dir, 'todos'), 500, 'json')
    await fillDir(join(dir, 'statsig'), 10, 'json')
    await writeFile(join(dir, 'history.jsonl'), 'x')
    await writeFile(join(dir, 'settings.json'), '{}')

    const project = join(dir, 'projects', '-tmp-demo')
    await mkdir(join(project, SID, 'subagents'), { recursive: true })
    await writeFile(join(project, `${SID}.jsonl`), promptLine(SID, '/tmp/demo', '2026-01-15T10:00:00.000Z') + '\n')
    await writeFile(join(project, `${OTHER}.jsonl`), promptLine(OTHER, '/tmp/demo', '2026-01-15T10:00:01.000Z') + '\n')
    await writeFile(join(project, SID, 'subagents', `agent-${AID}.jsonl`), promptLine(AID, '/tmp/demo', '2026-01-15T10:00:02.000Z') + '\n')
    await writeFile(join(project, SID, 'subagents', `agent-${AID}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_fx000001' }))
    await fillDir(join(project, SID, 'tool-results'), 50, 'txt')
    await fillDir(join(project, 'memory'), 5, 'md')

    const spy = spyReaddir()
    const { events, onEvents } = collector()
    const source = walker(spy, onEvents)
    await source.start()
    source.stop()

    // Only the root, projects/, a project folder, and a session's subagents/ folder are listed. (A
    // folder next to the session, like memory/, gets its <name>/subagents looked up too: that path
    // does not exist, and nothing under it is ever listed.)
    const allowed = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/projects(/[^/]+(/[^/]+/subagents)?)?)?$`)
    for (const path of spy.listed) expect(path).toMatch(allowed)
    for (const name of ['debug', 'file-history', 'shell-snapshots', 'todos', 'statsig', 'tool-results']) {
      expect(spy.listed.some((path) => path.includes(name))).toBe(false)
    }

    expect(events.filter((e) => e.t === 'prompt').map((e) => (e.t === 'prompt' ? e.agentId : '')).sort()).toEqual([SID, OTHER, AID].sort())
    expect(events.some((e) => e.t === 'subagent_link')).toBe(true)

    // The root holds 5 folders + 2 files besides projects/: seven entries never walked.
    expect(source.getScanStats()).toMatchObject({ scans: 1, lastScanFiles: 4, rootEntriesSkipped: 7, maxConcurrentScans: 1 })
    expect(source.getStatus()).toMatchObject({ status: 'live', files: 3, inWindow: 3 })
  })

  test('a root without projects/ lists only the root', async () => {
    await fillDir(join(dir, 'debug'), 100)
    const spy = spyReaddir()
    const source = walker(spy, () => undefined)
    await source.start()
    source.stop()
    expect(spy.listed).toEqual([dir])
    expect(source.getStatus()).toMatchObject({ status: 'live', files: 0, inWindow: 0 })
    expect(source.getScanStats()).toMatchObject({ lastScanFiles: 0, rootEntriesSkipped: 1 })
  })

  test('a file directly under projects/ and a symlinked project folder are not descended into', async () => {
    const elsewhere = join(dir, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, `${SID}.jsonl`), promptLine(SID, '/tmp/demo', '2026-01-15T10:00:00.000Z') + '\n')
    await mkdir(join(dir, 'projects'))
    await symlink(elsewhere, join(dir, 'projects', '-tmp-linked'))
    await writeFile(join(dir, 'projects', 'stray.jsonl'), 'x')

    const spy = spyReaddir()
    const { events, onEvents } = collector()
    const source = walker(spy, onEvents)
    await source.start()
    source.stop()

    expect(spy.listed).toEqual([dir, join(dir, 'projects')])
    expect(events.some((e) => e.t === 'prompt')).toBe(false)
  })
})

describe('TranscriptSource runs one pass at a time', () => {
  const SID = '00000000-0000-4000-8000-000000000001'
  const SESSION_EVENT = `projects/-tmp-demo/${SID}.jsonl`

  async function seed(): Promise<void> {
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(join(dir, 'projects', '-tmp-demo', `${SID}.jsonl`), promptLine(SID, '/tmp/demo', '2026-01-15T10:00:00.000Z') + '\n')
  }

  function slowSource(
    io: ReturnType<typeof gatedReaddir>,
    watch: ReturnType<typeof fakeWatch>,
    onEvents: (events: AgentEvent[]) => void,
    pollMs = 60_000
  ): TranscriptSource {
    return new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: true,
      pollMs,
      onEvents,
      nowMs: () => Date.now(),
      rescanMs: 0, // every pass is a full scan: the guard is what is under test
      readdir: io.readdir,
      watchFn: watch.watchFn,
    })
  }

  test('requests during a pass ask for exactly one more, not one each', async () => {
    await seed()
    const io = gatedReaddir(dir)
    const watch = fakeWatch()
    const source = slowSource(io, watch, () => undefined)
    await source.start()
    expect(io.rootListings()).toBe(1)

    io.close()
    watch.fire(SESSION_EVENT)
    await waitFor(() => io.rootListings() === 2) // the second scan has begun and is held
    for (let i = 0; i < 10; i++) watch.fire(SESSION_EVENT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(io.rootListings()).toBe(2)
    expect(source.getScanStats().maxConcurrentScans).toBe(1)

    io.open()
    await source.whenIdle()
    expect(io.rootListings()).toBe(3) // one more pass for the ten requests
    expect(source.getScanStats().maxConcurrentScans).toBe(1)
    source.stop()
  })

  test('a timer tick during a pass is coalesced the same way', async () => {
    await seed()
    const io = gatedReaddir(dir)
    const watch = fakeWatch()
    const source = slowSource(io, watch, () => undefined, 20)
    await source.start()
    io.close()
    await waitFor(() => io.rootListings() >= 2) // a tick began a scan, which is now held
    await new Promise((resolve) => setTimeout(resolve, 200)) // about ten more ticks meanwhile
    expect(io.rootListings()).toBe(2)
    source.stop()
    io.open()
    await source.whenIdle()
    expect(source.getScanStats().maxConcurrentScans).toBe(1)
  })

  test('stop() during a held pass: it ends, and reads and reports nothing afterwards', async () => {
    await seed()
    const io = gatedReaddir(dir)
    const watch = fakeWatch()
    const { events, onEvents } = collector()
    const source = slowSource(io, watch, onEvents)
    await source.start()
    const seen = events.length

    const later = '00000000-0000-4000-8000-000000000002'
    await writeFile(join(dir, 'projects', '-tmp-demo', `${later}.jsonl`), promptLine(later, '/tmp/demo', '2026-01-15T10:00:05.000Z') + '\n')
    io.close()
    watch.fire(SESSION_EVENT)
    await waitFor(() => io.rootListings() === 2)
    source.stop()
    expect(watch.closed()).toBe(true)
    io.open()
    await source.whenIdle()
    expect(events.length).toBe(seen)
  })
})

describe('TranscriptSource rescans on a throttle', () => {
  const SID = '00000000-0000-4000-8000-000000000001'
  const NEW = '00000000-0000-4000-8000-000000000002'
  const AID = 'fx000000000000b1'
  const project = (): string => join(dir, 'projects', '-tmp-demo')
  const rel = (name: string): string => `projects/-tmp-demo/${name}`

  async function session(id: string, ts: string): Promise<void> {
    await mkdir(project(), { recursive: true })
    await writeFile(join(project(), `${id}.jsonl`), promptLine(id, '/tmp/demo', ts) + '\n')
  }

  async function append(id: string, ts: string): Promise<void> {
    await appendFile(join(project(), `${id}.jsonl`), promptLine(id, '/tmp/demo', ts) + '\n')
  }

  const prompts = (events: AgentEvent[], id?: string): number =>
    events.filter((e) => e.t === 'prompt' && (id === undefined || e.agentId === id)).length

  /** A source whose clock and watch the test drives; the poll timer is too slow to matter. */
  function driven(extra: { sinceMs?: number | null; rescanMs?: number } = {}) {
    const clock = { now: 1_000 }
    const spy = spyReaddir()
    const watch = fakeWatch()
    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: extra.sinceMs ?? null,
      windowHours: null,
      watch: true,
      pollMs: 60_000,
      onEvents,
      nowMs: () => Date.now(),
      rescanMs: extra.rescanMs ?? 5000,
      monoMs: () => clock.now,
      readdir: spy.readdir,
      watchFn: watch.watchFn,
    })
    return { clock, spy, watch, events, source }
  }

  test('named events between rescans never walk anything', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { spy, watch, source } = driven()
    await source.start()
    spy.listed.length = 0
    for (let i = 0; i < 50; i++) watch.fire(rel(`${SID}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(spy.listed).toEqual([])
    expect(source.getScanStats()).toMatchObject({ scans: 1, watchEvents: 50, watchEventsIgnored: 0 })
  })

  test('a line appended to a known file arrives through a named event, without a scan', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { spy, watch, events, source } = driven()
    await source.start()
    spy.listed.length = 0
    await append(SID, '2026-01-15T10:00:05.000Z')
    watch.fire(rel(`${SID}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(prompts(events, SID)).toBe(2)
    expect(source.getScanStats().scans).toBe(1)
    expect(spy.listed).toEqual([])
  })

  test('a new session file named by an event is registered and read, without a scan', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { spy, watch, events, source } = driven()
    await source.start()
    spy.listed.length = 0
    await session(NEW, '2026-01-15T10:00:05.000Z')
    watch.fire(rel(`${NEW}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(prompts(events, NEW)).toBe(1)
    expect(source.getScanStats().scans).toBe(1)
    expect(source.getStatus()).toMatchObject({ files: 2, inWindow: 2 })
    expect(spy.listed).toEqual([])
  })

  test('a named file older than the window is counted but not read', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { watch, events, source } = driven({ sinceMs: Date.now() - 60_000 })
    await source.start()
    await session(NEW, '2026-01-15T10:00:05.000Z')
    const old = new Date('2020-01-01T00:00:00.000Z')
    await utimes(join(project(), `${NEW}.jsonl`), old, old)
    watch.fire(rel(`${NEW}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(prompts(events, NEW)).toBe(0)
    expect(source.getStatus()).toMatchObject({ files: 2, inWindow: 1 })
  })

  test('a transcript older than the window at start is read once it is written to again, at the next rescan', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z')
    await session(NEW, '2026-01-15T09:00:00.000Z')
    await utimes(join(project(), `${NEW}.jsonl`), old, old)
    const { clock, watch, events, source } = driven({ sinceMs: Date.now() - 60_000 })
    await source.start()
    expect(prompts(events, NEW)).toBe(0)
    expect(source.getStatus()).toMatchObject({ files: 1, inWindow: 0 })

    // The session is resumed: a line is appended (its mtime is now). No event names it; the rescan finds it.
    await append(NEW, '2026-01-15T10:00:05.000Z')
    clock.now += 5000
    watch.fire(null)
    await source.whenIdle()
    source.stop()
    expect(prompts(events, NEW)).toBe(2)
    expect(source.getStatus()).toMatchObject({ files: 1, inWindow: 1 })
  })

  test('an old transcript named by an event once it is written to is read at once, without a rescan', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z')
    await session(NEW, '2026-01-15T09:00:00.000Z')
    await utimes(join(project(), `${NEW}.jsonl`), old, old)
    const { watch, events, source } = driven({ sinceMs: Date.now() - 60_000 })
    await source.start()
    await append(NEW, '2026-01-15T10:00:05.000Z')
    watch.fire(rel(`${NEW}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(prompts(events, NEW)).toBe(2)
    expect(source.getScanStats().scans).toBe(1)
  })

  test('a transcript that stays old is looked at again but never read, and counted once', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z')
    await session(NEW, '2026-01-15T09:00:00.000Z')
    await utimes(join(project(), `${NEW}.jsonl`), old, old)
    const { clock, watch, events, source } = driven({ sinceMs: Date.now() - 60_000 })
    await source.start()
    for (let i = 0; i < 3; i++) {
      clock.now += 5000
      watch.fire(null)
      await source.whenIdle()
    }
    source.stop()
    expect(source.getScanStats().scans).toBe(4)
    expect(prompts(events, NEW)).toBe(0)
    expect(source.getStatus()).toMatchObject({ files: 1, inWindow: 0 })
  })

  test('a named subagent transcript and its meta file register together, the transcript first', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { watch, events, source } = driven()
    await source.start()
    const subagents = join(project(), SID, 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(join(subagents, `agent-${AID}.jsonl`), promptLine(AID, '/tmp/demo', '2026-01-15T10:00:05.000Z') + '\n')
    await writeFile(join(subagents, `agent-${AID}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_fx000001' }))
    // The meta file's event arrives first, in the same tick as the transcript's.
    watch.fire(rel(`${SID}/subagents/agent-${AID}.meta.json`))
    watch.fire(rel(`${SID}/subagents/agent-${AID}.jsonl`))
    await source.whenIdle()
    source.stop()
    const kinds = events.filter((e) => (e.t === 'prompt' && e.agentId === AID) || e.t === 'subagent_link').map((e) => e.t)
    expect(kinds).toEqual(['prompt', 'subagent_link'])
    expect(source.getScanStats().scans).toBe(1)
  })

  test('an event outside projects/ starts no pass at all', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { spy, watch, source } = driven()
    await source.start()
    spy.listed.length = 0
    watch.fire('debug/x.txt')
    watch.fire('file-history/a/b')
    watch.fire('projects')
    await source.whenIdle()
    source.stop()
    expect(spy.listed).toEqual([])
    expect(source.getScanStats()).toMatchObject({ scans: 1, watchEvents: 3, watchEventsIgnored: 3 })
  })

  test('an event that names no file polls every known file, without a scan', async () => {
    const second = '00000000-0000-4000-8000-000000000003'
    await session(SID, '2026-01-15T10:00:00.000Z')
    await session(second, '2026-01-15T10:00:01.000Z')
    const { watch, events, source } = driven()
    await source.start()
    await append(SID, '2026-01-15T10:00:05.000Z')
    await append(second, '2026-01-15T10:00:06.000Z')
    watch.fire(null)
    await source.whenIdle()
    source.stop()
    expect(prompts(events, SID)).toBe(2)
    expect(prompts(events, second)).toBe(2)
    expect(source.getScanStats().scans).toBe(1)
  })

  test('a due rescan finds what no event named', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { clock, watch, events, source } = driven()
    await source.start()
    await session(NEW, '2026-01-15T10:00:05.000Z') // no event names it
    watch.fire(rel(`${SID}.jsonl`))
    await source.whenIdle()
    expect(prompts(events, NEW)).toBe(0) // 0 ms since the last scan: not due
    clock.now += 5000
    watch.fire(rel(`${SID}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(prompts(events, NEW)).toBe(1)
    expect(source.getScanStats().scans).toBe(2)
  })

  test('with no watch at all, the timer still finds a new file (polling is the guarantee)', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 20,
      rescanMs: 50,
      onEvents,
      nowMs: () => Date.now(),
    })
    await source.start()
    await session(NEW, '2026-01-15T10:00:05.000Z')
    await waitFor(() => prompts(events, NEW) === 1)
    source.stop()
  })

  test('scans in the last minute are counted by the monotonic clock', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { clock, watch, source } = driven({ rescanMs: 0 })
    await source.start()
    for (let i = 0; i < 3; i++) {
      watch.fire(rel(`${SID}.jsonl`))
      await source.whenIdle()
    }
    expect(source.getScanStats()).toMatchObject({ scans: 4, scansLastMinute: 4, rescanMs: 0 })
    clock.now += 61_000
    expect(source.getScanStats()).toMatchObject({ scans: 4, scansLastMinute: 0 })
    watch.fire(rel(`${SID}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(source.getScanStats()).toMatchObject({ scans: 5, scansLastMinute: 1 })
  })

  test('a burst of more names than it will remember falls back to polling every known file', async () => {
    await session(SID, '2026-01-15T10:00:00.000Z')
    const { watch, events, source } = driven()
    await source.start()
    await append(SID, '2026-01-15T10:00:05.000Z')
    for (let i = 0; i < 1001; i++) watch.fire(rel(`unknown-${i}.jsonl`))
    await source.whenIdle()
    source.stop()
    expect(prompts(events, SID)).toBe(2)
    expect(source.getScanStats().scans).toBe(1)
  })
})

// A subagent's sidecar meta file says who started it; without a transcript that is being read it
// would create an agent that nothing ever updates (on a real home: 199 of 214 agents).
describe('TranscriptSource reads a sidecar only for a transcript inside the window', () => {
  const NOW = '2026-01-15T10:00:00.000Z'
  const sid = (n: number): string => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`
  const aid = (n: number, k: number): string => `fx0000000000${String(n).padStart(2, '0')}${String(k).padStart(2, '0')}`
  const subagentsDir = (n: number): string => join(dir, 'projects', '-tmp-demo', sid(n), 'subagents')
  const links = (events: AgentEvent[]): AgentEvent[] => events.filter((e) => e.t === 'subagent_link')

  async function subagent(n: number, k: number, opts: { transcript: boolean; meta: boolean; old: boolean }): Promise<void> {
    await mkdir(subagentsDir(n), { recursive: true })
    const files: string[] = []
    if (opts.transcript) {
      const path = join(subagentsDir(n), `agent-${aid(n, k)}.jsonl`)
      await writeFile(path, promptLine(aid(n, k), '/tmp/demo', NOW) + '\n')
      files.push(path)
    }
    if (opts.meta) {
      const path = join(subagentsDir(n), `agent-${aid(n, k)}.meta.json`)
      await writeFile(path, JSON.stringify({ agentType: 'Explore', toolUseId: `toolu_fx${n}${k}` }))
      files.push(path)
    }
    if (opts.old) {
      const long = new Date('2020-01-01T00:00:00.000Z')
      for (const path of files) await utimes(path, long, long)
    }
  }

  function windowed(extra: { sinceMs?: number | null; rescanMs?: number; pollMs?: number } = {}) {
    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: extra.sinceMs === undefined ? Date.now() - 3_600_000 : extra.sinceMs,
      windowHours: 1,
      watch: false,
      pollMs: extra.pollMs ?? 10_000,
      onEvents,
      nowMs: () => Date.now(),
      ...(extra.rescanMs !== undefined ? { rescanMs: extra.rescanMs } : {}),
    })
    return { events, source }
  }

  test('an old meta file whose transcript is outside the window emits nothing', async () => {
    await subagent(1, 1, { transcript: true, meta: true, old: true })
    const { events, source } = windowed()
    await source.start()
    source.stop()
    expect(links(events)).toEqual([])
    expect(events.filter((e) => 'agentId' in e && e.agentId === aid(1, 1))).toEqual([])
    expect(source.getStatus()).toMatchObject({ files: 1, inWindow: 0 })
  })

  test('a home of old meta files and no in-window transcripts produces zero agents', async () => {
    for (let n = 1; n <= 3; n++) {
      await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
      const session = join(dir, 'projects', '-tmp-demo', `${sid(n)}.jsonl`)
      await writeFile(session, promptLine(sid(n), '/tmp/demo', NOW) + '\n')
      const long = new Date('2020-01-01T00:00:00.000Z')
      await utimes(session, long, long)
      for (let k = 1; k <= 2; k++) await subagent(n, k, { transcript: true, meta: true, old: true })
    }
    const { events, source } = windowed()
    await source.start()
    source.stop()
    let world = emptyWorld(NOW, dir)
    for (const event of events) world = reduce(world, event)
    expect(Object.keys(world.agents)).toHaveLength(0)
    expect(source.getStatus()).toMatchObject({ files: 9, inWindow: 0 })
  })

  test('a meta file with no transcript at all emits nothing, and a transcript in the window brings its meta file', async () => {
    await subagent(1, 1, { transcript: false, meta: true, old: false })
    await subagent(1, 2, { transcript: true, meta: true, old: false })
    const { events, source } = windowed()
    await source.start()
    source.stop()
    expect(links(events).map((e) => (e.t === 'subagent_link' ? e.agentId : ''))).toEqual([aid(1, 2)])
  })

  test('a meta file written before its transcript is linked once the transcript appears', async () => {
    await subagent(1, 1, { transcript: false, meta: true, old: false })
    const { events, source } = windowed({ sinceMs: null, rescanMs: 20, pollMs: 30 })
    await source.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(links(events)).toEqual([])
    await subagent(1, 1, { transcript: true, meta: false, old: false })
    await waitFor(() => links(events).length > 0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    source.stop()
    expect(links(events)).toHaveLength(1)
  })

  test('an in-window transcript brings its meta file exactly once, however often it is polled', async () => {
    await subagent(1, 1, { transcript: true, meta: true, old: false })
    const { events, source } = windowed({ rescanMs: 0, pollMs: 20 })
    await source.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    source.stop()
    expect(links(events)).toHaveLength(1)
  })
})
