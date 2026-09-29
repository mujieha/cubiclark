// Quota samples in the status line's real shape (epoch seconds, `limit_*_resets`), the reset rule,
// and the adapter's glob, tail read and rotation. Values are invented.

import { appendFile, cp, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseQuotaLine, parseQuotaText, quotaAt } from '../src/core/adapters/quota.js'
import type { AdapterEnv, QuotaSample } from '../src/core/adapters/types.js'
import { QuotaSamplesAdapter, TAIL_BYTES } from '../src/server/adapters/quota-samples.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/quota', import.meta.url))
const NOW = Date.parse('2026-01-16T18:00:00Z')
const env: AdapterEnv = { nowMs: () => NOW, home: '/home/user' }
const iso = (s: string): string => new Date(Date.parse(s)).toISOString()

function sample(line: string): QuotaSample {
  const parsed = parseQuotaLine(line)
  if (parsed.kind !== 'sample') throw new Error(`not a sample: ${parsed.kind}`)
  return parsed.sample
}

describe('parseQuotaLine', () => {
  test('the real shape: ts and both resets in epoch seconds', () => {
    expect(sample('{"ts":1768570200,"limit_5h_pct":62,"limit_7d_pct":40,"limit_5h_resets":1768575600,"limit_7d_resets":1768795200}')).toEqual({
      ts: '2026-01-16T13:30:00.000Z',
      p5h: 62,
      p7d: 40,
      resets5h: '2026-01-16T15:00:00.000Z',
      resets7d: '2026-01-19T04:00:00.000Z',
    })
  })

  test('the tolerant spellings: ISO and millisecond times, numeric strings, a resets object, *_at, timestamp, time', () => {
    expect(sample('{"ts":"2026-01-16T09:00:00Z","limit_5h_pct":"25","limit_7d_pct":31}')).toEqual({ ts: iso('2026-01-16T09:00:00Z'), p5h: 25, p7d: 31 })
    expect(sample('{"ts":1768570200000,"limit_5h_pct":1,"limit_7d_pct":2}').ts).toBe('2026-01-16T13:30:00.000Z')
    expect(sample('{"ts":1768570200,"limit_5h_pct":1,"limit_7d_pct":2,"resets":{"5h":"2026-01-16T15:00:00Z","seven_day":1768795200}}')).toMatchObject({
      resets5h: iso('2026-01-16T15:00:00Z'),
      resets7d: '2026-01-19T04:00:00.000Z',
    })
    expect(sample('{"ts":1768570200,"limit_5h_pct":1,"limit_7d_pct":2,"resets_5h_at":1768575600,"resets_7d":1768795200}')).toMatchObject({
      resets5h: '2026-01-16T15:00:00.000Z',
      resets7d: '2026-01-19T04:00:00.000Z',
    })
    expect(sample('{"timestamp":1768570200,"limit_5h_pct":1,"limit_7d_pct":2}').ts).toBe('2026-01-16T13:30:00.000Z')
    expect(sample('{"time":"1768570200","limit_5h_pct":1,"limit_7d_pct":2}').ts).toBe('2026-01-16T13:30:00.000Z')
  })

  test('percentages are clamped to 0..100', () => {
    expect(sample('{"ts":1768570200,"limit_5h_pct":150,"limit_7d_pct":-5}')).toMatchObject({ p5h: 100, p7d: 0 })
  })

  test('a line without both percentages is another metric: skipped, not unparsed', () => {
    for (const line of ['{"ts":1768570200,"tokens_in":5}', '{"ts":1768570200,"limit_5h_pct":5}', '{"ts":1768570200,"limit_7d_pct":5}', '{}', '']) {
      expect(parseQuotaLine(line).kind, line).toBe('skipped')
    }
  })

  test('not JSON, not an object, or percentages without a time are unparsed', () => {
    for (const line of ['nope', '[1,2]', '"x"', '3', '{"limit_5h_pct":5,"limit_7d_pct":5}', '{"ts":"soon","limit_5h_pct":5,"limit_7d_pct":5}']) {
      expect(parseQuotaLine(line).kind, line).toBe('unparsed')
    }
  })
})

describe('parseQuotaText', () => {
  test('counts samples, skipped and unparsed lines separately; sorts by time', () => {
    const text = [
      '{"ts":1768570300,"limit_5h_pct":2,"limit_7d_pct":2}',
      'garbage',
      '{"ts":1768570200,"limit_5h_pct":1,"limit_7d_pct":1}',
      '{"ts":1768570200,"other":1}',
      '',
    ].join('\n')
    const parsed = parseQuotaText(text, Date.parse('2026-01-16T14:00:00Z'))
    expect(parsed.samples.map((s) => s.p5h)).toEqual([1, 2])
    expect(parsed.unparsed).toBe(1)
    expect(parsed.skipped).toBe(1)
  })

  test('samples older than eight days are dropped; later ones are kept', () => {
    const now = Date.parse('2026-01-30T00:00:00Z')
    const text = '{"ts":"2026-01-16T00:00:00Z","limit_5h_pct":1,"limit_7d_pct":1}\n{"ts":"2026-01-29T00:00:00Z","limit_5h_pct":2,"limit_7d_pct":2}\n{"ts":"2026-02-05T00:00:00Z","limit_5h_pct":3,"limit_7d_pct":3}'
    expect(parseQuotaText(text, now).samples.map((s) => s.p5h)).toEqual([2, 3])
  })

  test('at most 2000 samples, the newest', () => {
    const lines = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ ts: 1768570200 + i, limit_5h_pct: i % 100, limit_7d_pct: 1 }))
    const parsed = parseQuotaText(lines.join('\n'), Date.parse('2026-01-16T14:00:00Z'))
    expect(parsed.samples).toHaveLength(2000)
    expect(parsed.samples[0]?.ts).toBe(new Date((1768570200 + 100) * 1000).toISOString())
  })
})

describe('quotaAt: a sample past its reset reads as zero', () => {
  const NEWEST: QuotaSample = {
    ts: iso('2026-01-16T17:30:00Z'),
    p5h: 62,
    p7d: 40,
    resets5h: iso('2026-01-16T19:00:00Z'),
    resets7d: iso('2026-01-19T04:00:00Z'),
  }

  test('before the resets, the sample is current', () => {
    expect(quotaAt([NEWEST], Date.parse('2026-01-16T17:45:00Z'))).toEqual({
      p5h: 62,
      p7d: 40,
      resets5h: iso('2026-01-16T19:00:00Z'),
      resets7d: iso('2026-01-19T04:00:00Z'),
      sampledAt: NEWEST.ts,
    })
  })

  test('after the 5 h reset, the 5 h window is 0 and has no reset; the 7 d window stays', () => {
    expect(quotaAt([NEWEST], Date.parse('2026-01-16T19:30:00Z'))).toEqual({
      p5h: 0,
      p7d: 40,
      resets7d: iso('2026-01-19T04:00:00Z'),
      sampledAt: NEWEST.ts,
    })
    expect(quotaAt([NEWEST], Date.parse('2026-01-16T19:00:00Z'))?.p5h).toBe(0) // at the reset instant
  })

  test('after the 7 d reset, both are 0', () => {
    expect(quotaAt([NEWEST], Date.parse('2026-01-19T05:00:00Z'))).toEqual({ p5h: 0, p7d: 0, sampledAt: NEWEST.ts })
  })

  test('with no reset time known, a sample older than its window is 0', () => {
    const noReset: QuotaSample = { ts: iso('2026-01-16T11:00:00Z'), p5h: 8, p7d: 33 }
    expect(quotaAt([noReset], Date.parse('2026-01-16T13:00:00Z'))).toEqual({ p5h: 8, p7d: 33, sampledAt: noReset.ts })
    expect(quotaAt([noReset], Date.parse('2026-01-16T16:30:00Z'))).toEqual({ p5h: 0, p7d: 33, sampledAt: noReset.ts })
    expect(quotaAt([noReset], Date.parse('2026-01-24T00:00:00Z'))).toEqual({ p5h: 0, p7d: 0, sampledAt: noReset.ts })
  })

  test('the newest sample at or before the clock wins (replay), and none before it is undefined', () => {
    const older: QuotaSample = { ts: iso('2026-01-16T09:00:00Z'), p5h: 25, p7d: 31, resets5h: iso('2026-01-16T10:00:00Z') }
    expect(quotaAt([older, NEWEST], Date.parse('2026-01-16T09:30:00Z'))?.p5h).toBe(25)
    expect(quotaAt([older, NEWEST], Date.parse('2026-01-16T10:30:00Z'))?.p5h).toBe(0) // older, past its reset
    expect(quotaAt([older, NEWEST], Date.parse('2026-01-16T18:00:00Z'))?.p5h).toBe(62)
    expect(quotaAt([older, NEWEST], Date.parse('2026-01-16T08:00:00Z'))).toBeUndefined()
    expect(quotaAt([], NOW)).toBeUndefined()
  })
})

describe('QuotaSamplesAdapter over the fixture files', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cubiclark-quota-'))
    await cp(FIXTURE, dir, { recursive: true })
    await utimes(join(dir, 'samples-2026-01-15.jsonl'), new Date('2026-01-15T23:30:00Z'), new Date('2026-01-15T23:30:00Z'))
    await utimes(join(dir, 'samples-2026-01-16.jsonl'), new Date('2026-01-16T17:30:00Z'), new Date('2026-01-16T17:30:00Z'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const glob = (): QuotaSamplesAdapter => new QuotaSamplesAdapter({ file: join(dir, 'samples-*.jsonl') }, env)

  test('a glob reads the newest file by mtime: 6 samples, 2 skipped, 2 unparsed', async () => {
    const a = glob()
    const snap = await a.snapshot()
    expect(snap.quotaSamples).toHaveLength(6)
    expect(snap.quotaSamples?.map((s) => s.p5h)).toEqual([10, 25, 40, 8, 100, 62])
    expect(snap.diagnostics).toEqual({ unparsed: 2, errors: [] })
    expect(a.lastSkipped).toBe(2)
    expect(a.lastFileName).toBe('samples-2026-01-16.jsonl')
    expect(quotaAt(snap.quotaSamples ?? [], Date.parse('2026-01-16T17:45:00Z'))).toMatchObject({ p5h: 62, p7d: 40 })
    expect(quotaAt(snap.quotaSamples ?? [], Date.parse('2026-01-16T19:30:00Z'))).toMatchObject({ p5h: 0, p7d: 40 })
  })

  test('a plain path reads that file only', async () => {
    const a = new QuotaSamplesAdapter({ file: join(dir, 'samples-2026-01-15.jsonl') }, env)
    expect((await a.snapshot()).quotaSamples).toHaveLength(1)
  })

  test('rotation: a newer file is picked up on the next snapshot; an empty newest file falls back to the one before', async () => {
    const a = glob()
    await a.snapshot()
    await writeFile(join(dir, 'samples-2026-01-17.jsonl'), '{"ts":1768600000,"limit_5h_pct":7,"limit_7d_pct":41}\n')
    expect((await a.snapshot()).quotaSamples?.map((s) => s.p5h)).toEqual([7])
    expect(a.lastFileName).toBe('samples-2026-01-17.jsonl')

    await writeFile(join(dir, 'samples-2026-01-17.jsonl'), '{"ts":1768600000,"tokens_in":1}\n')
    const fallback = await a.snapshot()
    expect(fallback.quotaSamples).toHaveLength(6)
  })

  test('a changed file is re-read; an unchanged one is served from the cache', async () => {
    const a = glob()
    await a.snapshot()
    await appendFile(join(dir, 'samples-2026-01-16.jsonl'), '{"ts":1768590000,"limit_5h_pct":70,"limit_7d_pct":41}\n')
    expect((await a.snapshot()).quotaSamples).toHaveLength(7)
  })

  test('only the tail of a big file is read, and its partial first line is not counted as unparsed', async () => {
    const line = '{"ts":1768570200,"limit_5h_pct":9,"limit_7d_pct":9}\n'
    const count = Math.ceil((TAIL_BYTES * 1.5) / line.length)
    await writeFile(join(dir, 'samples-2026-01-18.jsonl'), line.repeat(count))
    const a = glob()
    const snap = await a.snapshot()
    expect(snap.diagnostics.unparsed).toBe(0)
    expect(snap.quotaSamples?.length).toBeGreaterThan(0)
    expect(snap.quotaSamples?.length).toBeLessThan(count)
    expect(snap.quotaSamples?.every((s) => s.p5h === 9)).toBe(true)
  })

  test('detect: true with a matching file, false without', async () => {
    expect(await glob().detect()).toBe(true)
    expect(await new QuotaSamplesAdapter({ file: join(dir, 'nope-*.jsonl') }, env).detect()).toBe(false)
    expect(await new QuotaSamplesAdapter({ file: join(dir, 'missing.jsonl') }, env).detect()).toBe(false)
    expect(await new QuotaSamplesAdapter({ file: join(dir, 'gone', 'x-*.jsonl') }, env).detect()).toBe(false)
    expect(await new QuotaSamplesAdapter({ file: dir }, env).detect()).toBe(false) // a directory
  })

  test('snapshot of a missing source resolves with an error', async () => {
    const snap = await new QuotaSamplesAdapter({ file: join(dir, 'nope-*.jsonl') }, env).snapshot()
    expect(snap.quotaSamples).toEqual([])
    expect(snap.diagnostics.errors).toEqual(['no samples file found'])
  })
})
