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
