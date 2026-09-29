// Every unparsed transcript line lands in exactly one reason bucket, named by record type only
// (never a value), and the buckets add up to the unparsed count the page and `doctor` show.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parseLine, parseTranscript, initialParseState, recordTypeName } from '../src/core/transcript/parse.js'
import { reduce } from '../src/core/reducer.js'
import { emptyWorld, mergeUnparsedBy, MAX_UNPARSED_TYPE_NAMES } from '../src/core/world.js'
import type { UnparsedBreakdown } from '../src/core/types.js'

const ctx = { agentId: 'a', kind: 'session' as const }
const TS = '2026-01-15T10:00:00.000Z'

function one(line: string) {
  return parseLine(line, ctx, initialParseState())
}

function total(by: UnparsedBreakdown): number {
  let sum = 0
  for (const types of Object.values(by)) for (const n of Object.values(types ?? {})) sum += n
  return sum
}

describe('parseLine labels every unparsed line with a reason and a type name', () => {
  test('not JSON', () => {
    expect(one('{"type":')).toMatchObject({ unparsed: true, reason: 'not_json', recordType: '(none)' })
  })
  test('JSON that is not an object', () => {
    expect(one('[1,2]')).toMatchObject({ unparsed: true, reason: 'not_object', recordType: '(none)' })
    expect(one('"text"')).toMatchObject({ unparsed: true, reason: 'not_object' })
  })
  test('no string type', () => {
    expect(one('{"timestamp":"' + TS + '"}')).toMatchObject({ unparsed: true, reason: 'no_type', recordType: '(none)' })
    expect(one('{"type":5}')).toMatchObject({ unparsed: true, reason: 'no_type' })
  })
  test('no timestamp names the type', () => {
    expect(one('{"type":"user"}')).toMatchObject({ unparsed: true, reason: 'no_timestamp', recordType: 'user' })
  })
  test('unknown type', () => {
    expect(one(`{"type":"future-thing","timestamp":"${TS}"}`)).toMatchObject({
      unparsed: true,
      reason: 'unknown_type',
      recordType: 'future-thing',
      unknownType: 'future-thing',
    })
  })
  test('unknown system subtype', () => {
    expect(one(`{"type":"system","subtype":"weird","timestamp":"${TS}"}`)).toMatchObject({
      unparsed: true,
      reason: 'unknown_subtype',
      recordType: 'system:weird',
      unknownType: 'system:weird',
    })
    expect(one(`{"type":"system","timestamp":"${TS}"}`)).toMatchObject({ reason: 'unknown_subtype', recordType: 'system:(missing)' })
  })
  test('a handler that cannot use the record', () => {
    expect(one(`{"type":"assistant","timestamp":"${TS}"}`)).toMatchObject({ unparsed: true, reason: 'handler_rejected', recordType: 'assistant' })
    expect(one(`{"type":"user","timestamp":"${TS}"}`)).toMatchObject({ unparsed: true, reason: 'handler_rejected', recordType: 'user' })
    expect(one(`{"type":"permission-mode","timestamp":"${TS}"}`)).toMatchObject({ unparsed: true, reason: 'handler_rejected' })
  })
  test('a user record with only a permission mode still emits it', () => {
    const result = one(`{"type":"user","permissionMode":"default","timestamp":"${TS}"}`)
    expect(result.events.some((event) => event.t === 'permission_mode')).toBe(true)
  })
})

describe('recordTypeName never lets a value through', () => {
  test('a long or odd type is (invalid)', () => {
    expect(recordTypeName('x'.repeat(200))).toBe('(invalid)')
    expect(recordTypeName('has a space')).toBe('(invalid)')
    expect(recordTypeName('user prompt text here')).toBe('(invalid)')
    expect(recordTypeName('system', 'ok_name')).toBe('system:ok_name')
    expect(recordTypeName(undefined)).toBe('(none)')
  })
})

describe('the reasons add up to the unparsed count', () => {
  test('over every checked-in transcript fixture', async () => {
    const root = fileURLToPath(new URL('./fixtures/transcripts', import.meta.url))
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith('.jsonl')) files.push(full)
      }
    }
    await walk(root)
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const result = parseTranscript(await readFile(file, 'utf8'), ctx)
      expect(total(result.unparsedBy), file).toBe(result.unparsed)
    }
  })
})

describe('the reducer merges breakdowns', () => {
  test('two diagnostics events add up', () => {
    let world = emptyWorld(TS, '/root')
    world = reduce(world, { t: 'diagnostics', ts: TS, unparsed: 2, unknownTypes: {}, versions: [], unparsedBy: { no_timestamp: { mode: 2 } } })
    world = reduce(world, { t: 'diagnostics', ts: TS, unparsed: 1, unknownTypes: {}, versions: [], unparsedBy: { no_timestamp: { mode: 1, user: 1 }, not_json: { '(none)': 1 } } })
    expect(world.diagnostics.unparsedBy).toEqual({ no_timestamp: { mode: 3, user: 1 }, not_json: { '(none)': 1 } })
  })

  test('the 51st distinct type name is counted as (other)', () => {
    const incoming: Record<string, number> = {}
    for (let i = 0; i < MAX_UNPARSED_TYPE_NAMES + 3; i++) incoming[`t${i}`] = 1
    const merged = mergeUnparsedBy({}, { unknown_type: incoming })
    const types = merged.unknown_type ?? {}
    expect(Object.keys(types)).toHaveLength(MAX_UNPARSED_TYPE_NAMES + 1)
    expect(types['(other)']).toBe(3)
    expect(total(merged)).toBe(MAX_UNPARSED_TYPE_NAMES + 3)
  })
})

// Records that come before the file has shown any time wait for the first one.
describe('records before the first timestamp', () => {
  const held = (mode: string): string => JSON.stringify({ type: 'permission-mode', permissionMode: mode })
  const prompt = JSON.stringify({ type: 'user', timestamp: TS, cwd: '/a/demo', message: { role: 'user', content: 'x' } })

  test('the 17th such record is no_timestamp, as before; the first 16 wait', () => {
    const lines = Array.from({ length: 17 }, (_, i) => held(i % 2 === 0 ? 'plan' : 'default'))
    const result = parseTranscript([...lines, prompt].join('\n'), ctx)
    expect(result.unparsed).toBe(1)
    expect(result.unparsedBy).toEqual({ no_timestamp: { 'permission-mode': 1 } })
    expect(result.events.filter((event) => event.t === 'permission_mode')).toHaveLength(16)
  })

  test('a permission-mode without a mode is handler_rejected, not held', () => {
    const result = parseTranscript(`{"type":"permission-mode"}\n${prompt}`, ctx)
    expect(result.unparsedBy).toEqual({ handler_rejected: { 'permission-mode': 1 } })
  })

  test('a file that never gets a timestamp keeps them pending, uncounted', () => {
    const result = parseTranscript(`${held('plan')}\n${held('default')}`, ctx)
    expect(result.unparsed).toBe(0)
    expect(result.deferred).toBe(2)
    expect(result.events).toEqual([])
  })

  test('the held events come out in file order, all with the first timestamp, after the record\'s agent_meta', () => {
    const result = parseTranscript(`${held('plan')}\n${held('acceptEdits')}\n${prompt}`, ctx)
    expect(result.events.map((event) => [event.t, event.ts, 'mode' in event ? event.mode : undefined])).toEqual([
      ['agent_meta', TS, undefined],
      ['permission_mode', TS, 'plan'],
      ['permission_mode', TS, 'acceptEdits'],
      ['prompt', TS, undefined],
    ])
  })

  test('the three types from a real home are known and ignored', () => {
    for (const type of ['bridge-session', 'artifact-autoreact-ledger', 'artifact-comment-monitor']) {
      expect(one(JSON.stringify({ type })), type).toMatchObject({ unparsed: false })
      expect(one(JSON.stringify({ type, timestamp: TS })), type).toMatchObject({ unparsed: false })
    }
  })
})

// S1-3: what a transcript says is never printed raw and never grows the World without bound.
describe('escape sequences and unbounded names in a transcript', () => {
  const ESC = '\u001b'
  const hostile = {
    type: `${ESC}]0;TITLE${'\u0007'}${ESC}[2K${ESC}[1Gfuture`,
    subtype: `${ESC}[32mgreen`,
    version: `2.1.285${ESC}[31m RED ${ESC}[0m`,
  }

  test('an unknown type and subtype travel as printable names', () => {
    const type = one(JSON.stringify({ type: hostile.type, timestamp: TS }))
    expect(type.unknownType).toBe('(invalid)')
    const subtype = one(JSON.stringify({ type: 'system', subtype: hostile.subtype, timestamp: TS }))
    expect(subtype.unknownType).toBe('(invalid)')
  })

  test('a version that is not a version number is (invalid)', () => {
    const result = one(JSON.stringify({ type: 'user', timestamp: TS, cwd: '/a/b', version: hostile.version, message: { role: 'user', content: 'x' } }))
    const meta = result.events.find((event) => event.t === 'agent_meta')
    expect(meta && meta.t === 'agent_meta' ? meta.version : 'none').toBe('(invalid)')
    const good = one(JSON.stringify({ type: 'user', timestamp: TS, cwd: '/a/b', version: '2.1.285', message: { role: 'user', content: 'x' } }))
    const goodMeta = good.events.find((event) => event.t === 'agent_meta')
    expect(goodMeta && goodMeta.t === 'agent_meta' ? goodMeta.version : 'none').toBe('2.1.285')
  })

  test('unknownTypes and versions keep at most 50 names, the rest under (other)', () => {
    let world = emptyWorld(TS, '/root')
    const unknownTypes: Record<string, number> = {}
    for (let i = 0; i < 60; i++) unknownTypes[`t${i}`] = 1
    world = reduce(world, { t: 'diagnostics', ts: TS, unparsed: 60, unknownTypes, versions: [] })
    expect(Object.keys(world.diagnostics.unknownTypes)).toHaveLength(51)
    expect(world.diagnostics.unknownTypes['(other)']).toBe(10)
    const versions = Array.from({ length: 60 }, (_, i) => `2.1.${i}`)
    world = reduce(world, { t: 'diagnostics', ts: TS, unparsed: 0, unknownTypes: {}, versions })
    expect(world.diagnostics.versions).toHaveLength(51)
    expect(world.diagnostics.versions.at(-1)).toBe('(other)')
  })

  test('no control character reaches the doctor report, from any field', async () => {
    const { formatDoctorReport } = await import('../src/server/doctor.js')
    const { formatHooksStatus } = await import('../src/server/hooks-install.js')
    const report = formatDoctorReport({
      claude: { version: `2.1.285${ESC}[31m`, verified: false },
      hookEvents: { verifiedOn: '2.1.285', events: ['A'] },
      transcripts: { status: 'live', reason: `read ${ESC}]0;TITLE\u0007 files` },
      hooks: { status: 'missing', reason: 'x' },
      diagnostics: {
        unparsedLines: 1,
        unknownHookShapes: 0,
        unknownTypes: { [`a${ESC}[2Kb`]: 1 },
        unparsedBy: {},
        versions: [`v${ESC}[1G`],
        sourceErrors: [`first\nfake line ${ESC}`],
      },
    })
    // eslint-disable-next-line no-control-regex
    expect(report).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(report.split('\n')).toHaveLength(6)
    const status = formatHooksStatus({
      settingsPath: `/x${ESC}[2J`,
      settingsState: 'unparseable',
      parseError: `bad${ESC}]52;c;AAAA\u0007`,
      events: [],
      tools: true,
      collectorExists: false,
      paused: false,
      eventsFile: `/y${ESC}c`,
    })
    // eslint-disable-next-line no-control-regex
    expect(status).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  })
})
