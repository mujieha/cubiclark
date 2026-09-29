// S1-1: an id that is also a property of every plain object (`constructor`, `__proto__`, ...) must
// never crash the reducer or corrupt a count. Such an id is not a real Claude Code id, so the event
// is ignored, leaves one source error, and everything else carries on.

import { describe, expect, test } from 'vitest'
import { reduce } from '../src/core/reducer.js'
import { isSafeKey, bump } from '../src/core/keys.js'
import { classifyPath } from '../src/core/transcript/paths.js'
import { normaliseHookLine, initialHookNormState } from '../src/core/hooks/normalise.js'
import { parseLog } from '../src/core/adapters/task-log.js'
import { mergeUnparsedBy } from '../src/core/world.js'
import type { AgentEvent, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

const TS = '2026-01-15T10:00:00.000Z'
const UNSAFE = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']

function run(events: AgentEvent[], from: World = emptyWorld(TS, '/root')): World {
  return events.reduce((w, e) => reduce(w, e), from)
}

describe('isSafeKey', () => {
  test('names every plain object already has are unsafe; ordinary ids are safe', () => {
    for (const key of UNSAFE) expect(isSafeKey(key), key).toBe(false)
    expect(isSafeKey('')).toBe(false)
    expect(isSafeKey('00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isSafeKey('fx000000000000001')).toBe(true)
  })

  test('bump counts under an own property, even for a name every object has', () => {
    const map: Record<string, number> = {}
    bump(map, 'constructor')
    bump(map, 'constructor')
    bump(map, '__proto__')
    bump(map, 'ordinary')
    expect(map.ordinary).toBe(1)
    expect(map['(invalid)']).toBe(3)
    expect(Object.keys(map).sort()).toEqual(['(invalid)', 'ordinary'])
  })
})

describe('the reducer', () => {
  test.each(UNSAFE)('a prompt for an agent called %s is ignored and the next agent is fine', (id) => {
    const world = run([
      { t: 'prompt', ts: TS, agentId: id },
      { t: 'prompt', ts: TS, agentId: id },
      { t: 'prompt', ts: TS, agentId: 'good' },
    ])
    expect(Object.keys(world.agents)).toEqual(['good'])
    expect(world.agents.good?.counters.prompts).toBe(1)
    expect(world.diagnostics.sourceErrors.length).toBeGreaterThan(0)
  })

  test.each(UNSAFE)('a subagent link whose parent is called %s is ignored', (id) => {
    const world = run([{ t: 'subagent_link', ts: TS, agentId: 'child', parentId: id, agentType: 'Explore' }])
    expect(world.agents.child).toBeUndefined()
  })

  test.each(UNSAFE)('a hook_seen and a session start for %s do not throw', (id) => {
    const world = run([
      { t: 'hook_seen', ts: TS, agentId: id, tools: false },
      { t: 'session_start', ts: TS, agentId: id, source: 'startup' },
      { t: 'tool_start', ts: TS, agentId: id, toolUseId: 't1', name: 'Bash' },
    ])
    expect(Object.keys(world.agents)).toEqual([])
  })

  test('the same complaint is not repeated for every event', () => {
    const events: AgentEvent[] = Array.from({ length: 100 }, () => ({ t: 'prompt', ts: TS, agentId: 'constructor' }))
    const world = run(events)
    expect(world.diagnostics.sourceErrors).toHaveLength(1)
  })

  test('diagnostics for a type called constructor count as numbers', () => {
    // JSON.parse, as real input arrives: an object literal's __proto__ would set the prototype instead.
    const unknownTypes = JSON.parse('{"constructor":1,"__proto__":1}') as Record<string, number>
    const event: AgentEvent = { t: 'diagnostics', ts: TS, unparsed: 2, unknownTypes, versions: [] }
    const world = run([event, event])
    for (const count of Object.values(world.diagnostics.unknownTypes)) expect(typeof count).toBe('number')
    expect(world.diagnostics.unknownTypes['(invalid)']).toBe(4)
  })

  test('mergeUnparsedBy counts a record type called constructor under (invalid)', () => {
    const types = JSON.parse('{"constructor":2,"__proto__":1}') as Record<string, number>
    const merged = mergeUnparsedBy({}, { unknown_type: types })
    expect(merged.unknown_type).toEqual({ '(invalid)': 3 })
  })
})

describe('the file layout', () => {
  test('a transcript, subagent transcript or sidecar named after an object property is ignored', () => {
    for (const id of UNSAFE) {
      expect(classifyPath(`projects/-demo/${id}.jsonl`).kind, id).toBe('ignore')
      expect(classifyPath(`projects/-demo/${id}/subagents/agent-a1.jsonl`).kind, id).toBe('ignore')
      expect(classifyPath(`projects/-demo/s1/subagents/agent-${id}.jsonl`).kind, id).toBe('ignore')
      expect(classifyPath(`projects/-demo/s1/subagents/agent-${id}.meta.json`).kind, id).toBe('ignore')
    }
    expect(classifyPath('projects/-demo/s1.jsonl').kind).toBe('session')
  })
})

describe('hook lines', () => {
  test.each(UNSAFE)('a stored line with sid %s becomes no events and is not an unknown shape', (id) => {
    const line = JSON.stringify({ v: 1, ts: TS, e: 'UserPromptSubmit', sid: id })
    const result = normaliseHookLine(line, initialHookNormState())
    expect(result.events).toEqual([])
    expect(result.unknownShape).toBe(true)
  })

  test('an aid that is an object property is refused too', () => {
    const line = JSON.stringify({ v: 1, ts: TS, e: 'PreToolUse', sid: 's1', aid: 'constructor', tool: 'Bash', tuid: 't1' })
    const result = normaliseHookLine(line, initialHookNormState())
    expect(result.events).toEqual([])
    expect(result.unknownShape).toBe(true)
  })
})

describe('task-log verbs', () => {
  test('an unknown verb called constructor is counted as a number', () => {
    const log = parseLog(`${TS} constructor a\n${TS} constructor b\n${TS} __proto__ c`)
    for (const count of Object.values(log.unknownVerbs)) expect(typeof count).toBe('number')
    expect(log.unknownVerbs['(invalid)']).toBe(3)
  })
})
