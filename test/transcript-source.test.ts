import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TranscriptSource } from '../src/server/transcript-source.js'
import type { AgentEvent } from '../src/core/types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-source-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

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

describe('TranscriptSource', () => {
  test('the initial scan emits events for a file that already has content', async () => {
    const sessionFile = join(dir, 'projects', '-tmp-demo', '00000000-0000-4000-8000-000000000001.jsonl')
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(sessionFile, promptLine('00000000-0000-4000-8000-000000000001', '/tmp/demo', 't0') + '\n', 'utf8')

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
    await writeFile(sessionFile, promptLine(sid, '/tmp/demo', 't0') + '\n', 'utf8')

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

    await writeFile(sessionFile, promptLine(sid, '/tmp/demo', 't0') + '\n' + promptLine(sid, '/tmp/demo', 't1') + '\n', 'utf8')
    await waitFor(() => events.filter((e) => e.t === 'prompt').length >= 2)

    source.stop()
    expect(events.filter((e) => e.t === 'prompt')).toHaveLength(2)
  })

  test('a new subagent dir created after start is discovered and linked', async () => {
    const parentSid = '00000000-0000-4000-8000-000000000003'
    const aid = 'fx000000000000e1'
    const parentFile = join(dir, 'projects', '-tmp-demo', `${parentSid}.jsonl`)
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(parentFile, promptLine(parentSid, '/tmp/demo', 't0') + '\n', 'utf8')

    const { events, onEvents } = collector()
    const source = new TranscriptSource({
      root: dir,
      sinceMs: null,
      windowHours: null,
      watch: false,
      pollMs: 30,
      onEvents,
      nowMs: () => Date.now(),
    })
    await source.start()

    const subagentsDir = join(dir, 'projects', '-tmp-demo', parentSid, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(
      join(subagentsDir, `agent-${aid}.jsonl`),
      promptLine(aid, '/tmp/demo', 't1') + '\n',
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

  test('a missing root reports unreadable with its error', async () => {
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

    const status = source.getStatus()
    expect(status.status).toBe('unreadable')
    expect(status.error).toBeTruthy()
  })

  test('a file older than the window is counted but not read; fixture mode ignores the window', async () => {
    const sid = '00000000-0000-4000-8000-000000000004'
    const sessionFile = join(dir, 'projects', '-tmp-demo', `${sid}.jsonl`)
    await mkdir(join(dir, 'projects', '-tmp-demo'), { recursive: true })
    await writeFile(sessionFile, promptLine(sid, '/tmp/demo', 't0') + '\n', 'utf8')
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
