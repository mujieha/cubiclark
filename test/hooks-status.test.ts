import { describe, expect, test } from 'vitest'
import { classifyHooks, classifyTranscripts, hooksSourceStatus } from '../src/core/hooks/status.js'
import type { HooksInspection, TranscriptSourceStatus } from '../src/core/types.js'

const NOW = Date.parse('2026-01-15T10:00:30.000Z')

function transcripts(overrides: Partial<TranscriptSourceStatus>): TranscriptSourceStatus {
  return { status: 'live', root: '/claude', files: 5, inWindow: 5, windowHours: 12, ...overrides }
}

function inspection(overrides: Partial<HooksInspection> = {}): HooksInspection {
  return {
    settingsPath: '/claude/settings.json',
    settingsState: 'ok',
    events: Array.from({ length: 14 }, (_, i) => `E${i}`),
    tools: true,
    collectorPath: '/state/bin/hook/cubiclark-collector.js',
    collectorExists: true,
    paused: false,
    eventsFile: '/state/events.jsonl',
    ...overrides,
  }
}

describe('classifyTranscripts', () => {
  test('live names the file counts and the root', () => {
    expect(classifyTranscripts(transcripts({}))).toEqual({
      status: 'live',
      reason: '5 transcript files, 5 read (/claude)',
    })
    expect(classifyTranscripts(transcripts({ files: 1, inWindow: 1 })).reason).toContain('1 transcript file,')
  })

  test('a folder that does not exist is missing, not failing', () => {
    const check = classifyTranscripts(transcripts({ status: 'unreadable', error: "ENOENT: no such file or directory, scandir '/claude'" }))
    expect(check).toEqual({ status: 'missing', reason: 'no transcripts folder at /claude' })
  })

  test('any other read error is failing, with the error as the reason', () => {
    const check = classifyTranscripts(transcripts({ status: 'unreadable', error: "EACCES: permission denied, scandir '/claude'" }))
    expect(check.status).toBe('failing')
    expect(check.reason).toContain('EACCES')
    expect(check.reason).toContain('/claude')
  })

  test('a source that never finished starting is failing', () => {
    expect(classifyTranscripts(transcripts({ status: 'starting' })).status).toBe('failing')
  })
})

describe('classifyHooks', () => {
  test('not installed is missing, with the command that fixes it', () => {
    expect(classifyHooks(inspection({ events: [], collectorPath: undefined, collectorExists: false }), NOW)).toEqual({
      status: 'missing',
      reason: 'not installed: run `cubiclark hooks on`',
    })
  })

  test('an unparseable settings.json is failing', () => {
    const check = classifyHooks(inspection({ settingsState: 'unparseable', parseError: 'invalid JSON: nope', events: [] }), NOW)
    expect(check.status).toBe('failing')
    expect(check.reason).toContain('invalid JSON: nope')
  })

  test('installed but the collector copy is gone is failing', () => {
    const check = classifyHooks(inspection({ collectorExists: false }), NOW)
    expect(check.status).toBe('failing')
    expect(check.reason).toContain('/state/bin/hook/cubiclark-collector.js')
    expect(check.reason).toContain('cubiclark hooks on')
  })

  test('paused is missing, and names the file and the command to resume', () => {
    const check = classifyHooks(inspection({ paused: true }), NOW)
    expect(check.status).toBe('missing')
    expect(check.reason).toContain('/state/off')
    expect(check.reason).toContain('cubiclark hooks resume')
  })

  test('live with events says how long ago the last one was', () => {
    const check = classifyHooks(inspection({ lastEventTs: '2026-01-15T10:00:18.000Z' }), NOW)
    expect(check).toEqual({ status: 'live', reason: '14 events (tools on); last event 12s ago' })
    expect(classifyHooks(inspection({ lastEventTs: '2026-01-15T09:55:30.000Z', tools: false, events: ['a', 'b'] }), NOW).reason).toBe(
      '2 events (tools off); last event 5m ago'
    )
  })

  test('live with no events yet says so', () => {
    expect(classifyHooks(inspection(), NOW).reason).toBe('14 events (tools on); no events recorded yet')
  })

  // C3: with a home directory given, a reason writes it as `~` in every path it names.
  test('given the home directory, the paths in a reason are reduced to ~ (C3)', () => {
    const home = '/home/alice'
    const at = (overrides: Partial<HooksInspection>): string => classifyHooks(inspection(overrides), NOW, home).reason
    expect(at({ paused: true, eventsFile: `${home}/.cubiclark/events.jsonl` })).toBe(
      'paused by ~/.cubiclark/off; run `cubiclark hooks resume`'
    )
    expect(at({ collectorExists: false, collectorPath: `${home}/.cubiclark/bin/hook/cubiclark-collector.js` })).toBe(
      'the collector copy is missing (~/.cubiclark/bin/hook/cubiclark-collector.js); run `cubiclark hooks on` again'
    )
    expect(at({ settingsState: 'unparseable', events: [], parseError: `cannot read '${home}/.claude/settings.json'` })).toBe(
      "settings.json does not parse: cannot read '~/.claude/settings.json'"
    )
  })
})

describe('hooksSourceStatus', () => {
  const stats = { events: 7, lastEventTs: '2026-01-15T10:00:20.000Z' }

  test('not installed', () => {
    expect(hooksSourceStatus(inspection({ events: [] }), { events: 0 }, NOW)).toMatchObject({ status: 'not_installed', events: 0 })
  })

  test('live carries the counters, tools flag and paused flag', () => {
    expect(hooksSourceStatus(inspection(), stats, NOW)).toMatchObject({
      status: 'live',
      events: 7,
      lastEventTs: '2026-01-15T10:00:20.000Z',
      tools: true,
      paused: false,
      eventsFile: '/state/events.jsonl',
    })
  })

  test('paused stays live (it is installed and not broken) but says paused', () => {
    expect(hooksSourceStatus(inspection({ paused: true }), stats, NOW)).toMatchObject({ status: 'live', paused: true })
  })

  test('a missing collector copy, an unparseable settings file and a read error are all failing', () => {
    expect(hooksSourceStatus(inspection({ collectorExists: false }), stats, NOW).status).toBe('failing')
    expect(hooksSourceStatus(inspection({ settingsState: 'unparseable', events: [] }), stats, NOW).status).toBe('failing')
    const readError = hooksSourceStatus(inspection(), { events: 0, error: 'cannot open: EACCES' }, NOW)
    expect(readError.status).toBe('failing')
    expect(readError.reason).toContain('EACCES')
  })

  test('falls back to the inspected last-event time when nothing was read this run', () => {
    expect(hooksSourceStatus(inspection({ lastEventTs: '2026-01-15T10:00:01.000Z' }), { events: 0 }, NOW).lastEventTs).toBe(
      '2026-01-15T10:00:01.000Z'
    )
  })
})
