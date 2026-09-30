// The fault this guards against: a recursive watch on the whole Claude config folder, one full walk
// per event, no limit on walks at once. A busy folder (debug logs, file history, shell snapshots)
// then started walks faster than they finished, and each held every path in the tree.

import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { AgentEvent } from '../src/core/types.js'
import { TranscriptSource, type ReaddirFn, type WatchFn } from '../src/server/transcript-source.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-stress-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function promptLine(sessionId: string, ts: string): string {
  return JSON.stringify({
    uuid: `u-${ts}`,
    timestamp: ts,
    sessionId,
    cwd: '/tmp/demo',
    version: '2.1.284',
    type: 'user',
    message: { role: 'user', content: 'hello' },
  })
}

async function fill(dirPath: string, count: number): Promise<void> {
  await mkdir(dirPath, { recursive: true })
  for (let start = 0; start < count; start += 250) {
    await Promise.all(Array.from({ length: Math.min(250, count - start) }, (_, i) => writeFile(join(dirPath, `f-${start + i}.log`), 'x')))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)
const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('500 watch events in a second over a 5 000-file config folder: one scan at a time, scans bounded by time, heap flat', async () => {
  // 5 000 files that are not transcripts.
  await fill(join(dir, 'debug'), 2000)
  for (let d = 0; d < 25; d++) await fill(join(dir, 'file-history', `h${d}`), 60)
  await fill(join(dir, 'shell-snapshots'), 1000)
  await fill(join(dir, 'todos'), 500)

  // 20 sessions, two of them with five subagents (and sidecar meta files) each.
  const project = join(dir, 'projects', '-tmp-demo')
  await mkdir(project, { recursive: true })
  for (let n = 1; n <= 20; n++) await writeFile(join(project, `${sid(n)}.jsonl`), promptLine(sid(n), '2026-01-15T10:00:00.000Z') + '\n')
  for (const n of [1, 2]) {
    const subagents = join(project, sid(n), 'subagents')
    await mkdir(subagents, { recursive: true })
    for (let a = 0; a < 5; a++) {
      const agent = `fx00000000${n}${a}0000`
      await writeFile(join(subagents, `agent-${agent}.jsonl`), promptLine(agent, '2026-01-15T10:00:01.000Z') + '\n')
      await writeFile(join(subagents, `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: `toolu_fx0000${n}${a}` }))
    }
  }

  const listed: string[] = []
  const readdirSpy: ReaddirFn = async (path, options) => {
    listed.push(path)
    return readdir(path, options)
  }
  let fire: (filename: string | null) => void = () => undefined
  const watchFn: WatchFn = (_root, listener) => {
    fire = listener
    return { close: () => undefined }
  }
  const events: AgentEvent[] = []
  const RESCAN_MS = 250
  const source = new TranscriptSource({
    root: dir,
    sinceMs: null,
    windowHours: null,
    watch: true,
    pollMs: 100,
    rescanMs: RESCAN_MS,
    onEvents: (batch) => events.push(...batch),
    nowMs: () => Date.now(),
    readdir: readdirSpy,
    watchFn,
  })
  await source.start()
  await source.whenIdle()
  expect(source.getStatus()).toMatchObject({ status: 'live', files: 30 })

  globalThis.gc?.()
  const before = process.memoryUsage().heapUsed
  const scansBefore = source.getScanStats().scans
  const promptsBefore = events.filter((e) => e.t === 'prompt').length
  listed.length = 0

  // The storm: 20 bursts of 25 callbacks, 50 ms apart. Most name files that are not transcripts.
  const started = performance.now()
  for (let burst = 0; burst < 20; burst++) {
    for (let i = 0; i < 25; i++) {
      if (i < 12) fire(`debug/f-${burst * 25 + i}.log`)
      else if (i < 17) fire(`file-history/h${i}/f-${burst}.log`)
      else if (i < 20) fire(`shell-snapshots/f-${burst * 3 + i}.log`)
      else if (i < 23) fire(`projects/-tmp-demo/${sid(1)}.jsonl`)
      else fire(null)
    }
    if (burst === 10) await appendFile(join(project, `${sid(1)}.jsonl`), promptLine(sid(1), '2026-01-15T10:00:30.000Z') + '\n')
    await sleep(50)
  }
  await source.whenIdle()
  const elapsedMs = performance.now() - started

  globalThis.gc?.()
  const after = process.memoryUsage().heapUsed
  const stats = source.getScanStats()
  source.stop()
  const scans = stats.scans - scansBefore

  console.info(
    `stress: heap before ${mb(before)} MB after ${mb(after)} MB, scans ${scans} in ${Math.round(elapsedMs)} ms, ` +
      `max concurrent ${stats.maxConcurrentScans}, events ${stats.watchEvents}, files walked per scan ${stats.lastScanFiles}`
  )

  expect(stats.watchEvents).toBe(500)
  expect(stats.maxConcurrentScans).toBe(1)
  // Bounded by time, not by events: one rescan per RESCAN_MS at most (plus one for the edges).
  expect(scans).toBeGreaterThanOrEqual(1)
  expect(scans).toBeLessThanOrEqual(2 + Math.ceil(elapsedMs / RESCAN_MS))
  expect(scans).toBeLessThan(500 / 10)
  // Each scan is one listing of the root, and nothing but transcript folders is ever listed below it.
  expect(listed.filter((path) => path === dir)).toHaveLength(scans)
  const allowed = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/projects(/[^/]+(/[^/]+/subagents)?)?)?$`)
  for (const path of listed) expect(path).toMatch(allowed)
  // The line appended in the middle of the storm arrived.
  expect(events.filter((e) => e.t === 'prompt').length - promptsBefore).toBe(1)
  expect(after - before).toBeLessThan(50 * 1024 * 1024)
}, 60_000)
