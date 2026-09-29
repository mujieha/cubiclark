// LOG.md lines, from the shapes documented in the task-folder format (ids invented).

import { describe, expect, test } from 'vitest'
import { cleanText, parseLog, parseLogLine, reducePaths } from '../src/core/adapters/task-log.js'

const S1 = '00000000-0000-4000-8000-000000000001'
const S2 = '00000000-0000-4000-8000-000000000002'

function entry(line: string) {
  const parsed = parseLogLine(line)
  if (parsed.kind !== 'entry') throw new Error(`not an entry: ${parsed.kind}`)
  return parsed
}

describe('machine lines', () => {
  test('dispatched: session, project basename, model, effort and perms', () => {
    const parsed = entry(`2026-01-15T10:00:00Z dispatched session ${S1} in /home/user/projects/demo model=claude-opus-5-5 effort=high perms=bypassPermissions`)
    expect(parsed.entry).toEqual({ ts: '2026-01-15T10:00:00Z', kind: 'dispatched', model: 'claude-opus-5-5', text: 'dispatched in demo (bypassPermissions)' })
    expect(parsed.sessions).toEqual([S1])
    expect(parsed.currentSession).toBe(S1)
    expect(parsed.effort).toBe('high')
  })

  test('forked: both ids, the new one is current; (compactions=N) shows only above zero; the note is kept', () => {
    const forked = entry(`2026-01-15T10:20:00Z forked ${S1} -> ${S2} model=claude-sonnet-5-5 effort=high (compactions=0) optional note text`)
    expect(forked.entry).toEqual({ ts: '2026-01-15T10:20:00Z', kind: 'forked', model: 'claude-sonnet-5-5', text: 'forked optional note text' })
    expect(forked.sessions).toEqual([S1, S2])
    expect(forked.currentSession).toBe(S2)

    const compacted = entry(`2026-01-15T10:20:00Z forked ${S1} -> ${S2} model=claude-sonnet-5-5 (compactions=2)`)
    expect(compacted.entry.text).toBe('forked after 2 compactions')
    expect(entry(`2026-01-15T10:20:00Z forked ${S1} -> ${S2} (compactions=1)`).entry.text).toBe('forked after 1 compaction')
  })

  test('resumed: the id, model, effort and a note', () => {
    const parsed = entry(`2026-01-15T10:40:00Z resumed ${S2} model=claude-sonnet-5-5 effort=high optional note text`)
    expect(parsed.entry).toEqual({ ts: '2026-01-15T10:40:00Z', kind: 'resumed', model: 'claude-sonnet-5-5', text: 'resumed optional note text' })
    expect(parsed.sessions).toEqual([S2])
    expect(parsed.currentSession).toBe(S2)
  })

  test('key=value pairs may come in any order', () => {
    const parsed = entry(`2026-01-15T10:00:00Z dispatched session ${S1} in /a/b effort=max perms=x model=m1`)
    expect(parsed.entry.model).toBe('m1')
    expect(parsed.effort).toBe('max')
  })

  test('paused keeps its whole text', () => {
    expect(entry('2026-01-15T11:00:00Z paused at weekly 95%; resume after Sat 17 Jan 04:00').entry).toEqual({
      ts: '2026-01-15T11:00:00Z',
      kind: 'paused',
      text: 'paused at weekly 95%; resume after Sat 17 Jan 04:00',
    })
  })

  test('verified by orchestrator is a done entry', () => {
    expect(entry('2026-01-15T12:00:00Z verified by orchestrator: free text summary').entry).toEqual({
      ts: '2026-01-15T12:00:00Z',
      kind: 'done',
      text: 'verified: free text summary',
    })
    expect(entry('2026-01-15T12:00:00Z verified').entry.text).toBe('verified')
  })

  test('an unknown verb becomes a note and is reported', () => {
    const parsed = entry('2026-01-15T12:30:00Z rerouted the thing')
    expect(parsed.entry).toEqual({ ts: '2026-01-15T12:30:00Z', kind: 'note', text: 'rerouted the thing' })
    expect(parsed.unknownVerb).toBe(true)
    expect(parsed.verb).toBe('rerouted')
  })

  test('an invalid session id keeps the entry but names no session', () => {
    const parsed = entry('2026-01-15T10:00:00Z dispatched session not-a-uuid in /a/b model=m')
    expect(parsed.sessions).toEqual([])
    expect(parsed.currentSession).toBeUndefined()
    expect(parsed.entry.kind).toBe('dispatched')
  })

  test('a timestamp with fractions is accepted', () => {
    expect(entry('2026-01-15T12:00:00.250Z paused now').entry.ts).toBe('2026-01-15T12:00:00.250Z')
  })
})

describe('note lines', () => {
  test('the date and time are local time (the test zone is UTC)', () => {
    expect(entry('- 2026-01-15 13:00 DECISION: free text written by the orchestrator').entry).toEqual({
      ts: '2026-01-15T13:00:00.000Z',
      kind: 'note',
      text: 'DECISION: free text written by the orchestrator',
    })
  })
  test('a date that does not exist is unparsed', () => {
    expect(parseLogLine('- 2026-02-31 13:00 nope').kind).toBe('unparsed')
    expect(parseLogLine('- 2026-13-01 13:00 nope').kind).toBe('unparsed')
  })
})

describe('lines that are not entries', () => {
  test('headings, blank lines and rules are skipped', () => {
    for (const line of ['', '   ', '# Log', '## Notes', '---', '-----']) expect(parseLogLine(line).kind).toBe('skip')
  })
  test('anything else is unparsed', () => {
    for (const line of ['garbage', '- a bullet without a date', '2026-01-15 no T and no Z dispatched', 'dispatched session x']) {
      expect(parseLogLine(line).kind, line).toBe('unparsed')
    }
  })
})

describe('no filesystem path reaches an entry', () => {
  test('reducePaths keeps the last segment of each path-looking token', () => {
    expect(reducePaths('/a/b/c')).toBe('c')
    expect(reducePaths('in ~/x/y now')).toBe('in y now')
    expect(reducePaths('see ./rel/z, then')).toBe('see z, then')
    expect(reducePaths('(/abs/path)')).toBe('(path)')
    expect(reducePaths('and/or stays')).toBe('and/or stays')
    expect(reducePaths('no path here')).toBe('no path here')
    expect(reducePaths('https://host/path')).toBe('https:path')
  })
  test('cleanText also collapses spaces and caps at 160 characters', () => {
    expect(cleanText('  a   b  ')).toBe('a b')
    expect(cleanText('x'.repeat(500))).toHaveLength(160)
    expect(cleanText('x'.repeat(500)).endsWith('…')).toBe(true)
  })
  test('a home path inside a machine line and a note line is reduced', () => {
    expect(entry('2026-01-15T12:30:00Z rerouted /home/user/projects/shop/src/x.ts').entry.text).toBe('rerouted x.ts')
    expect(entry('- 2026-01-15 13:00 look in /home/user/projects/shop').entry.text).toBe('look in shop')
  })
})

describe('parseLog', () => {
  const TEXT = [
    '# Log',
    '',
    `2026-01-15T10:00:00Z dispatched session ${S1} in /home/user/projects/demo model=claude-opus-5-5 effort=high perms=bypassPermissions`,
    `2026-01-15T10:20:00Z forked ${S1} -> ${S2} model=claude-sonnet-5-5 effort=medium (compactions=1)`,
    'garbage line',
    '2026-01-15T10:30:00Z rerouted x',
    '2026-01-15T10:31:00Z rerouted y',
    '- 2026-01-15 13:00 DECISION: note',
  ].join('\n')

  test('entries, sessions, current session, per-session model and effort, counts', () => {
    const log = parseLog(TEXT)
    expect(log.entries).toHaveLength(5)
    expect(log.sessions).toEqual([S1, S2])
    expect(log.currentSession).toBe(S2)
    expect(log.effortBySession).toEqual({ [S1]: 'high', [S2]: 'medium' })
    expect(log.modelBySession).toEqual({ [S1]: 'claude-opus-5-5', [S2]: 'claude-sonnet-5-5' })
    expect(log.newestEffort).toBe('medium')
    expect(log.unparsed).toBe(1)
    expect(log.unknownVerbs).toEqual({ rerouted: 2 })
  })

  test('an empty log is empty', () => {
    expect(parseLog('')).toEqual({ entries: [], sessions: [], effortBySession: {}, modelBySession: {}, unparsed: 0, unknownVerbs: {} })
  })

  test('at most 20 distinct unknown verbs are named', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `2026-01-15T10:00:${String(i).padStart(2, '0')}Z verb${i} x`)
    expect(Object.keys(parseLog(lines.join('\n')).unknownVerbs)).toHaveLength(20)
  })
})
