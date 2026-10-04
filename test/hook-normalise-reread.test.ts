// C5: the whitelist binds the writer, and a line in events.jsonl is read back by a program that cannot know
// the writer was the collector. normaliseHookLine applies the collector's own per-field matchers again, so a
// value the collector would have dropped is dropped here too: lines are written by hand, not through
// toStoredLine.

import { describe, expect, test } from 'vitest'
import { initialHookNormState, normaliseHookLine } from '../src/core/hooks/normalise.js'
import { reduce } from '../src/core/reducer.js'
import { initialParseState, parseLine } from '../src/core/transcript/parse.js'
import type { AgentEvent } from '../src/core/types.js'
import { publicWorld } from '../src/core/view.js'
import { emptyWorld } from '../src/core/world.js'

const TS = '2026-01-15T10:00:00.000Z'
const BIDI = String.fromCodePoint(0x202e)

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ts: TS, ...fields })
}

function events(fields: Record<string, unknown>): AgentEvent[] {
  return normaliseHookLine(line(fields), initialHookNormState()).events
}

describe('a stored line is checked again on read (C5)', () => {
  test('a 320-character path target with a bidi override, and a 500-character model, give a clean event', () => {
    const target = `/home/alice/${'x'.repeat(300)}${BIDI}evil`
    expect(target.length).toBeGreaterThan(300)
    const [seen, started] = events({ e: 'PreToolUse', sid: 's1', tool: 'Read', tuid: 'tu1', target, model: 'm'.repeat(500) })
    expect(started).toMatchObject({ t: 'tool_start', name: 'Read', toolUseId: 'tu1' })
    expect((started as { target?: string }).target).toBeUndefined()
    expect(JSON.stringify([seen, started])).not.toContain('/home/alice')
    expect(JSON.stringify([seen, started])).not.toContain(BIDI)

    const [, start] = events({ e: 'SessionStart', sid: 's1', model: 'm'.repeat(500) })
    expect(start).toMatchObject({ t: 'session_start', source: 'startup' })
    expect(start).not.toHaveProperty('model')
  })

  test('a model that passes the collector rule is kept; one that does not is not', () => {
    expect(events({ e: 'PostModelSwitch', sid: 's1', model: 'claude-opus-5-5' })[1]).toMatchObject({ t: 'model_changed', model: 'claude-opus-5-5' })
    expect(events({ e: 'PostModelSwitch', sid: 's1', model: `claude${BIDI}` })).toHaveLength(1)
    expect(events({ e: 'PostModelSwitch', sid: 's1', model: 'two words' })).toHaveLength(1)
  })

  test('a target with a separator, a control character or a format character is dropped, a plain one kept', () => {
    const target = (value: string) => (events({ e: 'PreToolUse', sid: 's1', tool: 'Bash', tuid: 'tu1', target: value })[1] as { target?: string }).target
    expect(target('npm')).toBe('npm')
    expect(target('a/b')).toBeUndefined()
    expect(target('a\\b')).toBeUndefined()
    expect(target('a\u0007b')).toBeUndefined()
    expect(target(`a${BIDI}b`)).toBeUndefined()
    expect(target('t'.repeat(101))).toBeUndefined()
  })

  test('a tool name that is not a plain name is not an event: no tool, no tool_start', () => {
    const r = normaliseHookLine(line({ e: 'PreToolUse', sid: 's1', tool: `Re${BIDI}ad`, tuid: 'tu1' }), initialHookNormState())
    expect(r).toMatchObject({ events: [], unknownShape: true })
    const wait = events({ e: 'PermissionRequest', sid: 's1', tool: 'x'.repeat(101) })
    expect(wait[1]).toMatchObject({ t: 'permission_wait' })
    expect(wait[1]).not.toHaveProperty('toolName')
  })

  test('a tool use id that is not a plain id is not a tool start', () => {
    expect(normaliseHookLine(line({ e: 'PreToolUse', sid: 's1', tool: 'Read', tuid: 'a b' }), initialHookNormState()).unknownShape).toBe(true)
  })

  test('cwd, effort and permission mode must be what the collector would have stored', () => {
    const [seen] = events({ e: 'Stop', sid: 's1', cwd: 'relative/dir', eff: 'extreme', pm: 'yolo' })
    expect(seen).toMatchObject({ t: 'hook_seen' })
    expect(seen).not.toHaveProperty('cwd')
    expect(seen).not.toHaveProperty('effort')
    expect(seen).not.toHaveProperty('permissionMode')
    const [kept] = events({ e: 'Stop', sid: 's1', cwd: '/home/user/projects/demo', eff: 'xhigh', pm: 'acceptEdits' })
    expect(kept).toMatchObject({ cwd: '/home/user/projects/demo', effort: 'xhigh', permissionMode: 'acceptEdits' })
    const [long] = events({ e: 'Stop', sid: 's1', cwd: `/${'d'.repeat(1030)}` })
    expect(long).not.toHaveProperty('cwd')
    const [bidi] = events({ e: 'Stop', sid: 's1', cwd: `/home/user${BIDI}` })
    expect(bidi).not.toHaveProperty('cwd')
  })

  test('a subagent type is checked as a name, a session or agent id as an id', () => {
    const start = normaliseHookLine(line({ e: 'SubagentStart', sid: 's1', aid: 'a1', at: `Ex${BIDI}plore` }), initialHookNormState())
    expect(start.events).toEqual([])
    expect(events({ e: 'SubagentStart', sid: 's1', aid: 'a1', at: 'Explore' })[1]).toMatchObject({ t: 'subagent_link', agentType: 'Explore' })
    expect(normaliseHookLine(line({ e: 'Stop', sid: 'a b' }), initialHookNormState()).unknownShape).toBe(true)
    expect(normaliseHookLine(line({ e: 'Stop', sid: 's1', aid: `a${BIDI}` }), initialHookNormState()).unknownShape).toBe(true)
  })

  test('the time is only an ISO instant (R4-3): the round-4 probe is not a line, an ISO one is', () => {
    const probe = `Oct 3 2026 10:00:00 GMT (${`/home/alice/${'x'.repeat(1987)}${BIDI}`})`
    expect(probe.length).toBeGreaterThan(2000)
    expect(Number.isNaN(Date.parse(probe))).toBe(false)
    const bad = normaliseHookLine(JSON.stringify({ v: 1, ts: probe, e: 'UserPromptSubmit', sid: 's1' }), initialHookNormState())
    expect(bad).toMatchObject({ events: [], unparsed: true })

    const good = normaliseHookLine(JSON.stringify({ v: 1, ts: TS, e: 'UserPromptSubmit', sid: 's1' }), initialHookNormState())
    expect(good.unparsed).toBe(false)
    expect(good.events).toHaveLength(2)
    for (const event of good.events) expect(event.ts).toBe(TS)
  })

  test('nothing of the probe reaches the world the page and the terminal are drawn from', () => {
    const probe = `Oct 3 2026 10:00:00 GMT (/home/alice/${'x'.repeat(2000)}${BIDI})`
    const hookLine = JSON.stringify({ v: 1, ts: probe, e: 'UserPromptSubmit', sid: 's1', cwd: '/home/user/projects/demo' })
    const transcriptLine = JSON.stringify({ type: 'user', timestamp: probe, cwd: '/home/user/projects/demo', message: { role: 'user', content: 'x' } })
    const fromHook = normaliseHookLine(hookLine, initialHookNormState()).events
    const fromTranscript = parseLine(transcriptLine, { agentId: 's1', kind: 'session' }, initialParseState()).events
    expect([...fromHook, ...fromTranscript]).toEqual([])

    const good = normaliseHookLine(line({ e: 'UserPromptSubmit', sid: 's1' }), initialHookNormState()).events
    const world = good.reduce(reduce, emptyWorld(TS, '/home/user/.claude/projects'))
    const text = JSON.stringify(publicWorld(world))
    expect(text).not.toContain('Oct 3 2026')
    expect(text).not.toContain('/home/alice')
    for (const match of text.matchAll(/"(?:ts|at|since|lastEventAt)":"([^"]*)"/g)) expect(match[1]?.length).toBeLessThanOrEqual(24)
  })

  test.each([
    ['2026-01-15T10:00:00Z', true],
    ['2026-01-15T10:00:00.5Z', true],
    ['2026-01-15T10:00:00.123Z', true],
    ['2026-01-15T10:00:00.1234Z', false],
    ['2026-01-15T10:00:00+02:00', false],
    ['2026-01-15 10:00:00Z', false],
    ['2026-01-15T10:00:00.000Z ', false],
    ['2026-01-15T10:00:00.000Z\n', false],
    ['2026-13-45T99:99:99.000Z', false],
    ['+010000-01-15T10:00:00.000Z', false],
    ['1768471200000', false],
  ])('the time %j is %s', (ts, accepted) => {
    const r = normaliseHookLine(JSON.stringify({ v: 1, ts, e: 'UserPromptSubmit', sid: 's1' }), initialHookNormState())
    expect(r.unparsed).toBe(!accepted)
    expect(r.events.length > 0).toBe(accepted)
  })

  test('a session source and an end reason outside the fixed lists fall back as the collector would', () => {
    expect(events({ e: 'SessionStart', sid: 's1', src: 'teleport' })[1]).toMatchObject({ source: 'startup' })
    expect(events({ e: 'SessionEnd', sid: 's1', reason: 'because' })[1]).not.toHaveProperty('reason')
    expect(events({ e: 'SessionEnd', sid: 's1', reason: 'logout' })[1]).toMatchObject({ reason: 'logout' })
  })
})
