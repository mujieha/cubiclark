// Stored lines -> AgentEvents. Lines are built through toStoredLine, so the whitelist and the
// normaliser are tested together, exactly as they meet on disk.

import { describe, expect, test } from 'vitest'
import { initialHookNormState, normaliseHookLine, type HookNormState } from '../src/core/hooks/normalise.js'
import { serialiseStoredLine, toStoredLine } from '../src/core/hooks/whitelist.js'
import { reduce } from '../src/core/reducer.js'
import type { AgentEvent, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

const T = (n: number): string => new Date(Date.parse('2026-01-15T10:00:00.000Z') + n * 1000).toISOString()

function stored(payload: Record<string, unknown>, n = 0): string {
  return serialiseStoredLine(toStoredLine(payload, T(n)))
}

function norm(payload: Record<string, unknown>, state: HookNormState = initialHookNormState(), n = 0) {
  return normaliseHookLine(stored(payload, n), state)
}

const kinds = (events: AgentEvent[]): string[] => events.map((e) => e.t)

describe('one row per event', () => {
  test('SessionStart: hook_seen, session_start with source and model', () => {
    const r = norm({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/home/user/projects/demo', source: 'resume', model: 'claude-opus-5-5', permission_mode: 'plan', effort: { level: 'high' } })
    expect(kinds(r.events)).toEqual(['hook_seen', 'session_start'])
    expect(r.events[0]).toMatchObject({ agentId: 's1', tools: false, cwd: '/home/user/projects/demo', effort: 'high', permissionMode: 'plan' })
    expect(r.events[1]).toMatchObject({ agentId: 's1', source: 'resume', model: 'claude-opus-5-5', ts: T(0) })
    expect(r.unparsed).toBe(false)
    expect(r.unknownShape).toBe(false)
  })

  test('UserPromptSubmit: hook_seen, prompt', () => {
    expect(kinds(norm({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }).events)).toEqual(['hook_seen', 'prompt'])
  })

  test('PreToolUse: tool_start with the reduced target, and it marks tools as recorded', () => {
    const r = norm({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_use_id: 'tu1', tool_input: { file_path: '/x/notes.md' } })
    expect(kinds(r.events)).toEqual(['hook_seen', 'tool_start'])
    expect(r.events[0]).toMatchObject({ tools: true })
    expect(r.events[1]).toMatchObject({ toolUseId: 'tu1', name: 'Read', target: 'notes.md', agentId: 's1' })
    expect(r.events[1]).not.toHaveProperty('subagentType')
  })

  test('PreToolUse for the Agent tool carries the subagent type', () => {
    const r = norm({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 'tu1', tool_input: { subagent_type: 'Explore' } })
    expect(r.events[1]).toMatchObject({ t: 'tool_start', target: 'Explore', subagentType: 'Explore' })
  })

  test('PreToolUse without a tool id or name is an unknown shape with no events', () => {
    const r = norm({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' })
    expect(r).toMatchObject({ events: [], unknownShape: true, unparsed: false })
    expect(norm({ hook_event_name: 'PreToolUse', session_id: 's1', tool_use_id: 'x' }).unknownShape).toBe(true)
  })

  test('PostToolUse: tool_end that is neither an error nor a denial', () => {
    const r = norm({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1' })
    expect(kinds(r.events)).toEqual(['hook_seen', 'tool_end'])
    expect(r.events[1]).toMatchObject({ toolUseId: 'tu1', isError: false, denied: false })
  })

  test('PostToolUseFailure: an error, unless it was an interrupt', () => {
    const failure = norm({ hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1' })
    expect(failure.events[1]).toMatchObject({ t: 'tool_end', isError: true })
    const interrupt = norm({ hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1', is_interrupt: true })
    expect(interrupt.events[1]).toMatchObject({ t: 'tool_end', isError: false })
  })

  test('PermissionRequest: permission_wait naming the tool, no tool id needed', () => {
    const r = norm({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm x' } })
    expect(kinds(r.events)).toEqual(['hook_seen', 'permission_wait'])
    expect(r.events[1]).toMatchObject({ toolName: 'Bash' })
  })

  test('Notification: only permission_prompt becomes a permission_wait', () => {
    expect(kinds(norm({ hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt' }).events)).toEqual(['hook_seen', 'permission_wait'])
    expect(kinds(norm({ hook_event_name: 'Notification', session_id: 's1', notification_type: 'idle_prompt' }).events)).toEqual(['hook_seen'])
  })

  test('Stop: turn_end', () => {
    expect(kinds(norm({ hook_event_name: 'Stop', session_id: 's1' }).events)).toEqual(['hook_seen', 'turn_end'])
  })

  test('StopFailure: api_error kind from the documented error enum', () => {
    const kindOf = (err: string): unknown => (norm({ hook_event_name: 'StopFailure', session_id: 's1', error: err }).events[1] as { kind: string }).kind
    expect(kindOf('rate_limit')).toBe('rate_limit')
    expect(kindOf('overloaded')).toBe('overloaded')
    expect(kindOf('billing_error')).toBe('other')
    expect(kindOf('some_future_error')).toBe('other')
    expect(norm({ hook_event_name: 'StopFailure', session_id: 's1', error: 'rate_limit' }).events[1]).toMatchObject({ retrying: false })
  })

  test('PreCompact and PostCompact', () => {
    expect(norm({ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }).events[1]).toMatchObject({ t: 'compacting', trigger: 'auto' })
    expect(norm({ hook_event_name: 'PostCompact', session_id: 's1', trigger: 'manual' }).events[1]).toMatchObject({ t: 'compacted', trigger: 'manual' })
  })

  test('SessionEnd: session_end with the reason', () => {
    expect(norm({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'logout' }).events[1]).toMatchObject({ t: 'session_end', reason: 'logout' })
  })
})

describe('subagents', () => {
  const start = { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore' }
  const stop = { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'x1', agent_type: 'Explore' }

  test('SubagentStart creates the subagent under its parent session, and remembers it', () => {
    const r = norm(start)
    expect(kinds(r.events)).toEqual(['hook_seen', 'subagent_link', 'prompt'])
    expect(r.events[0]).toMatchObject({ agentId: 'x1', kind: 'subagent', parentId: 's1', tools: false })
    expect(r.events[1]).toMatchObject({ agentId: 'x1', parentId: 's1', agentType: 'Explore' })
    expect(r.events[2]).toMatchObject({ agentId: 'x1' })
    expect(r.state.knownSubagents.has('x1')).toBe(true)
  })

  test('the agent- prefix does not matter: a start and a stop spelled differently are the same agent', () => {
    const afterStart = norm(start).state
    const r = norm(stop, afterStart)
    expect(kinds(r.events)).toEqual(['hook_seen', 'turn_end'])
    expect(r.events[1]).toMatchObject({ agentId: 'x1' })
  })

  test('a tool event with an agent_id goes to the subagent, not the parent', () => {
    const r = norm({ hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'tu9' })
    expect(r.events[0]).toMatchObject({ t: 'hook_seen', agentId: 'x1', kind: 'subagent', parentId: 's1', tools: true })
    expect(r.events[1]).toMatchObject({ t: 'tool_start', agentId: 'x1' })
  })

  test('a SubagentStop with no earlier start is an internal agent: no events, not even a diagnostic', () => {
    const r = norm(stop)
    expect(r).toMatchObject({ events: [], unparsed: false, unknownShape: false })
  })

  test('a SubagentStart with an empty or missing type is ignored, and so is its stop', () => {
    const noType = { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-i1' }
    const r = norm(noType)
    expect(r.events).toEqual([])
    expect(r.state.knownSubagents.has('i1')).toBe(false)
    const stopped = norm({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'i1' }, r.state)
    expect(stopped.events).toEqual([])
  })

  test('the input state is never mutated', () => {
    const state = initialHookNormState()
    norm(start, state)
    expect(state.knownSubagents.size).toBe(0)
  })
})

describe('bad lines', () => {
  test('_malformed and _unknown lines, and a line with no session id, are unknown shapes', () => {
    const malformed = normaliseHookLine(stored({ hook_event_name: 'Stop' }).replace('"Stop"', '"_malformed"'), initialHookNormState())
    expect(malformed).toMatchObject({ events: [], unknownShape: true, unparsed: false })
    expect(norm({ hook_event_name: 'FutureThing', session_id: 's1' })).toMatchObject({ events: [], unknownShape: true })
    expect(norm({ hook_event_name: 'Stop' })).toMatchObject({ events: [], unknownShape: true })
  })

  test('garbage, the wrong version and a bad timestamp are unparsed', () => {
    const state = initialHookNormState()
    expect(normaliseHookLine('garbage', state)).toMatchObject({ events: [], unparsed: true })
    expect(normaliseHookLine('[1]', state).unparsed).toBe(true)
    expect(normaliseHookLine('{"v":2,"ts":"2026-01-15T10:00:00.000Z","e":"Stop","sid":"s1"}', state).unparsed).toBe(true)
    expect(normaliseHookLine('{"v":1,"ts":"nonsense","e":"Stop","sid":"s1"}', state).unparsed).toBe(true)
    expect(normaliseHookLine('{"v":1,"e":"Stop","sid":"s1"}', state).unparsed).toBe(true)
  })

  test('a blank line is nothing at all', () => {
    expect(normaliseHookLine('   ', initialHookNormState())).toMatchObject({ events: [], unparsed: false, unknownShape: false })
  })

  test('a known event name written by a newer collector that this build does not know is an unknown shape', () => {
    const line = '{"v":1,"ts":"2026-01-15T10:00:00.000Z","e":"BrandNewEvent","sid":"s1"}'
    expect(normaliseHookLine(line, initialHookNormState())).toMatchObject({ events: [], unknownShape: true })
  })
})

describe('end to end through the reducer', () => {
  test('a whole session with a subagent ends with the right World', () => {
    const payloads: Record<string, unknown>[] = [
      { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/home/user/projects/demo', source: 'startup', model: 'claude-opus-5-5' },
      { hook_event_name: 'UserPromptSubmit', session_id: 's1' },
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 'tuA', tool_input: { subagent_type: 'Explore' } },
      { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore' },
      { hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'tuG' },
      { hook_event_name: 'PostToolUse', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'tuG' },
      { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore' },
      { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 'tuA' },
      { hook_event_name: 'Stop', session_id: 's1' },
    ]
    let state = initialHookNormState()
    let world: World = emptyWorld(T(0), '/root')
    payloads.forEach((payload, i) => {
      const r = normaliseHookLine(stored(payload, i), state)
      state = r.state
      for (const event of r.events) world = reduce(world, event)
    })
    expect(world.agents.s1).toMatchObject({
      kind: 'session',
      project: 'demo',
      model: 'claude-opus-5-5',
      state: 'waiting_user',
      counters: { prompts: 1, tools: 1, subagents: 1 },
      openTools: [],
      hooked: { tools: true },
    })
    expect(world.agents.x1).toMatchObject({
      kind: 'subagent',
      parentId: 's1',
      state: 'finished',
      role: 'explorer',
      label: 'Explore',
      counters: { prompts: 1, tools: 1 },
    })
  })
})
