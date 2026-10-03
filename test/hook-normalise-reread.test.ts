// C5: the whitelist binds the writer, and a line in events.jsonl is read back by a program that cannot know
// the writer was the collector. normaliseHookLine applies the collector's own per-field matchers again, so a
// value the collector would have dropped is dropped here too: lines are written by hand, not through
// toStoredLine.

import { describe, expect, test } from 'vitest'
import { initialHookNormState, normaliseHookLine } from '../src/core/hooks/normalise.js'
import type { AgentEvent } from '../src/core/types.js'

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

  test('a session source and an end reason outside the fixed lists fall back as the collector would', () => {
    expect(events({ e: 'SessionStart', sid: 's1', src: 'teleport' })[1]).toMatchObject({ source: 'startup' })
    expect(events({ e: 'SessionEnd', sid: 's1', reason: 'because' })[1]).not.toHaveProperty('reason')
    expect(events({ e: 'SessionEnd', sid: 's1', reason: 'logout' })[1]).toMatchObject({ reason: 'logout' })
  })
})
