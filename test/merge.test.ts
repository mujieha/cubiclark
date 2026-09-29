// The merge gate (PLAN.md phase 2 §2.6): hooks win on timing, transcripts fill in model and
// compactions. Every cell of the table, the timestamp boundaries, and one whole scenario through
// the Store.

import { describe, expect, test } from 'vitest'
import { gateTranscriptEvent } from '../src/core/merge.js'
import type { AgentEvent, World } from '../src/core/types.js'
import { emptyWorld, ensureAgent, updateAgent } from '../src/core/world.js'
import { Store } from '../src/server/store.js'

const T = (n: number): string => new Date(Date.parse('2026-01-15T10:00:00.000Z') + n * 1000).toISOString()

function worldWith(hooked: { lastTs: string; tools: boolean } | undefined): World {
  let world = ensureAgent(emptyWorld(T(0), '/root'), 's1', T(0))
  if (hooked) world = updateAgent(world, 's1', (agent) => ({ ...agent, hooked }))
  return world
}

const prompt: AgentEvent = { t: 'prompt', ts: T(5), agentId: 's1' }
const turnEnd: AgentEvent = { t: 'turn_end', ts: T(5), agentId: 's1' }
const assistant: AgentEvent = { t: 'assistant', ts: T(5), agentId: 's1', model: 'm', tokensOut: 3, thinking: false, text: true }
const toolStart = (n: number): AgentEvent => ({ t: 'tool_start', ts: T(n), agentId: 's1', toolUseId: 't', name: 'Bash' })
const toolEnd = (denied: boolean): AgentEvent => ({ t: 'tool_end', ts: T(5), agentId: 's1', toolUseId: 't', isError: false, denied })
const interrupted = (n: number): AgentEvent => ({ t: 'interrupted', ts: T(n), agentId: 's1' })
const apiError = (n: number): AgentEvent => ({ t: 'api_error', ts: T(n), agentId: 's1', kind: 'rate_limit', retrying: false })

const HOOKED_WITH_TOOLS = { lastTs: T(10), tools: true }
const HOOKED_LIFECYCLE = { lastTs: T(10), tools: false }

describe('an agent no hook has seen: every transcript event passes untouched', () => {
  const world = worldWith(undefined)
  for (const event of [prompt, turnEnd, assistant, toolStart(1), toolEnd(false), toolEnd(true), interrupted(1), apiError(1)]) {
    test(event.t, () => {
      expect(gateTranscriptEvent(world, event)).toBe(event)
    })
  }
})

describe('a hooked agent', () => {
  const world = worldWith(HOOKED_WITH_TOOLS)

  test('prompt and turn_end are dropped: UserPromptSubmit and Stop own them', () => {
    expect(gateTranscriptEvent(world, prompt)).toBeUndefined()
    expect(gateTranscriptEvent(world, turnEnd)).toBeUndefined()
  })

  test('assistant passes as fillOnly: model and tokens, never a state change', () => {
    expect(gateTranscriptEvent(world, assistant)).toEqual({ ...assistant, fillOnly: true })
  })

  test('tool_start is dropped when hooks record tools', () => {
    expect(gateTranscriptEvent(world, toolStart(20))).toBeUndefined()
  })

  test('tool_end is dropped when hooks record tools, except a denial, which no hook ever reports', () => {
    expect(gateTranscriptEvent(world, toolEnd(false))).toBeUndefined()
    const denied = toolEnd(true)
    expect(gateTranscriptEvent(world, denied)).toBe(denied)
  })

  test('interrupted and api_error pass only when not older than the last hook event', () => {
    expect(gateTranscriptEvent(world, interrupted(9))).toBeUndefined()
    expect(gateTranscriptEvent(world, interrupted(10))).toBeDefined()
    expect(gateTranscriptEvent(world, interrupted(11))).toBeDefined()
    expect(gateTranscriptEvent(world, apiError(9))).toBeUndefined()
    expect(gateTranscriptEvent(world, apiError(10))).toBeDefined()
  })

  test('agent_meta, subagent_link, compaction, permission_mode and diagnostics pass', () => {
    const passing: AgentEvent[] = [
      { t: 'agent_meta', ts: T(1), agentId: 's1', kind: 'background' },
      { t: 'subagent_link', ts: T(1), agentId: 's1', parentId: 'p' },
      { t: 'compaction', ts: T(1), agentId: 's1' },
      { t: 'permission_mode', ts: T(1), agentId: 's1', mode: 'default' },
      { t: 'diagnostics', ts: T(1), unparsed: 1, unknownTypes: {}, versions: [] },
    ]
    for (const event of passing) expect(gateTranscriptEvent(world, event)).toBe(event)
  })
})

describe('a hooked agent whose hooks do not record tools (--no-tools)', () => {
  const world = worldWith(HOOKED_LIFECYCLE)

  test('a tool_start newer than the last hook event passes, an older one is dropped', () => {
    expect(gateTranscriptEvent(world, toolStart(9))).toBeUndefined()
    expect(gateTranscriptEvent(world, toolStart(10))).toBeDefined()
    expect(gateTranscriptEvent(world, toolStart(11))).toBeDefined()
  })

  test('tool_end passes: transcripts are the only tool source', () => {
    const event = toolEnd(false)
    expect(gateTranscriptEvent(world, event)).toBe(event)
  })

  test('prompt and turn_end are still dropped', () => {
    expect(gateTranscriptEvent(world, prompt)).toBeUndefined()
    expect(gateTranscriptEvent(world, turnEnd)).toBeUndefined()
  })
})

describe('the Store applies the gate to transcript events only', () => {
  const store = (): Store => new Store({ nowMs: () => Date.parse(T(100)), transcriptsRoot: '/root', throttleMs: 1_000_000 })

  test('the whole merge: history from transcripts, then hooks, then late transcript lines', () => {
    const s = store()
    // 1. The session's past comes from transcripts alone.
    s.applyTranscriptEvents([
      { t: 'agent_meta', ts: T(1), agentId: 's1', kind: 'session', cwd: '/home/user/projects/demo' },
      { t: 'prompt', ts: T(1), agentId: 's1' },
      { t: 'tool_start', ts: T(2), agentId: 's1', toolUseId: 'T1', name: 'Read', target: 'a.ts' },
      { t: 'tool_end', ts: T(3), agentId: 's1', toolUseId: 'T1', isError: false, denied: false },
      { t: 'turn_end', ts: T(4), agentId: 's1' },
    ])
    expect(s.getWorld().agents.s1).toMatchObject({ state: 'waiting_user', counters: { prompts: 1, tools: 1 } })
    expect(s.getWorld().agents.s1?.hooked).toBeUndefined()

    // 2. Hooks take over from there.
    s.applyEvents([
      { t: 'hook_seen', ts: T(5), agentId: 's1', tools: false },
      { t: 'prompt', ts: T(5), agentId: 's1' },
      { t: 'hook_seen', ts: T(6), agentId: 's1', tools: true },
      { t: 'tool_start', ts: T(6), agentId: 's1', toolUseId: 'T2', name: 'Bash', target: 'npm' },
      { t: 'hook_seen', ts: T(7), agentId: 's1', tools: false },
      { t: 'permission_wait', ts: T(7), agentId: 's1', toolName: 'Bash' },
    ])

    // 3. The transcript catches up: its copies of what hooks already said are gated out, and
    // what only it knows (the model, a compaction) is filled in.
    s.applyTranscriptEvents([
      { t: 'prompt', ts: T(5), agentId: 's1' },
      { t: 'assistant', ts: T(6), agentId: 's1', model: 'claude-opus-5-5', tokensOut: 8, thinking: false, text: false },
      { t: 'tool_start', ts: T(6), agentId: 's1', toolUseId: 'T2', name: 'Bash', target: 'npm' },
      { t: 'compaction', ts: T(6), agentId: 's1', trigger: 'auto' },
    ])

    expect(s.getWorld().agents.s1).toMatchObject({
      state: 'waiting_permission',
      stateEvidence: 'observed',
      model: 'claude-opus-5-5',
      counters: { prompts: 2, tools: 2, compactions: 1, tokensOut: 8 },
      currentTool: { name: 'Bash' },
    })
    expect(s.getWorld().agents.s1?.openTools).toHaveLength(1)
    s.stop()
  })

  test('applyEvents does not gate: a hook prompt is counted even for a hooked agent', () => {
    const s = store()
    s.applyEvents([
      { t: 'hook_seen', ts: T(1), agentId: 's1', tools: false },
      { t: 'prompt', ts: T(1), agentId: 's1' },
      { t: 'prompt', ts: T(2), agentId: 's1' },
    ])
    expect(s.getWorld().agents.s1?.counters.prompts).toBe(2)
    s.stop()
  })
})
