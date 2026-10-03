// One stored hook line (core/hooks/whitelist.ts) -> AgentEvents (PLAN.md phase 2 §2.3). Pure and
// never throws: a line that cannot be understood becomes a counted diagnostic, not an exception.
// The only state is the set of subagents seen starting, needed because SubagentStop also fires
// for Claude Code's own internal agents (prompt suggestions, /btw) and those must not appear.

import { isSafeKey } from '../keys.js'
import type { AgentEvent, HookSeenEvent } from '../types.js'
import { HOOK_EVENT_NAMES, TOOL_HOOK_EVENTS, type HookEventName } from './whitelist.js'

export interface HookNormState {
  knownSubagents: ReadonlySet<string>
}

export function initialHookNormState(): HookNormState {
  return { knownSubagents: new Set() }
}

export interface HookLineResult {
  events: AgentEvent[]
  state: HookNormState
  /** Not JSON, wrong version, or missing its timestamp or event name. */
  unparsed: boolean
  /** Parsed, but not something this build can turn into events (malformed input, an unknown
   * event, or a required field missing). */
  unknownShape: boolean
}

function result(state: HookNormState, events: AgentEvent[] = [], flags: Partial<HookLineResult> = {}): HookLineResult {
  return { events, state, unparsed: false, unknownShape: false, ...flags }
}

function isHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(name)
}

export function normaliseHookLine(line: string, state: HookNormState): HookLineResult {
  const trimmed = line.trim()
  if (trimmed.length === 0) return result(state)

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return result(state, [], { unparsed: true })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result(state, [], { unparsed: true })
  const record = value as Record<string, unknown>

  const str = (key: string): string | undefined => (typeof record[key] === 'string' ? (record[key] as string) : undefined)
  const ts = str('ts')
  const e = str('e')
  if (record.v !== 1 || ts === undefined || e === undefined || Number.isNaN(Date.parse(ts))) {
    return result(state, [], { unparsed: true })
  }

  if (e === '_malformed' || e === '_unknown' || !isHookEvent(e)) return result(state, [], { unknownShape: true })
  const sid = str('sid')
  if (sid === undefined || !isSafeKey(sid)) return result(state, [], { unknownShape: true })

  const aid = str('aid')
  // A subagent that is its own session would be its own parent (R2-3).
  if (aid !== undefined && (!isSafeKey(aid) || aid === sid)) return result(state, [], { unknownShape: true })
  const agentId = aid ?? sid
  const tool = str('tool')
  const tuid = str('tuid')
  const target = str('target')
  const trig = record.trig === 'manual' || record.trig === 'auto' ? record.trig : undefined

  const seen = (): HookSeenEvent => {
    const event: HookSeenEvent = { t: 'hook_seen', ts, agentId, tools: TOOL_HOOK_EVENTS.includes(e) }
    if (aid !== undefined) {
      event.kind = 'subagent'
      event.parentId = sid
    }
    const cwd = str('cwd')
    if (cwd !== undefined) event.cwd = cwd
    const eff = str('eff')
    if (eff !== undefined) event.effort = eff
    const pm = str('pm')
    if (pm !== undefined) event.permissionMode = pm
    return event
  }

  switch (e) {
    case 'SessionStart': {
      const model = str('model')
      return result(state, [seen(), { t: 'session_start', ts, agentId, source: str('src') ?? 'startup', ...(model ? { model } : {}) }])
    }
    case 'UserPromptSubmit':
      return result(state, [seen(), { t: 'prompt', ts, agentId }])
    case 'PreToolUse': {
      if (tuid === undefined || tool === undefined) return result(state, [], { unknownShape: true })
      const delegating = tool === 'Agent' || tool === 'Task'
      return result(state, [
        seen(),
        {
          t: 'tool_start',
          ts,
          agentId,
          toolUseId: tuid,
          name: tool,
          target,
          ...(delegating ? { subagentType: target } : {}),
        },
      ])
    }
    case 'PostToolUse':
      if (tuid === undefined) return result(state, [], { unknownShape: true })
      return result(state, [seen(), { t: 'tool_end', ts, agentId, toolUseId: tuid, isError: false, denied: false }])
    case 'PostToolUseFailure':
      if (tuid === undefined) return result(state, [], { unknownShape: true })
      return result(state, [
        seen(),
        { t: 'tool_end', ts, agentId, toolUseId: tuid, isError: record.intr !== true, denied: false },
      ])
    case 'PermissionRequest':
      return result(state, [seen(), { t: 'permission_wait', ts, agentId, ...(tool ? { toolName: tool } : {}) }])
    case 'Notification':
      return str('nt') === 'permission_prompt'
        ? result(state, [seen(), { t: 'permission_wait', ts, agentId }])
        : result(state, [seen()])
    case 'Stop':
      return result(state, [seen(), { t: 'turn_end', ts, agentId }])
    case 'StopFailure': {
      const err = str('err')
      const kind = err === 'rate_limit' ? 'rate_limit' : err === 'overloaded' ? 'overloaded' : 'other'
      return result(state, [seen(), { t: 'api_error', ts, agentId, kind, retrying: false }])
    }
    case 'SubagentStart': {
      const at = str('at')
      // No id or type: one of Claude Code's own internal agents. Not shown.
      if (aid === undefined || at === undefined) return result(state)
      return result(
        { knownSubagents: new Set([...state.knownSubagents, aid]) },
        [seen(), { t: 'subagent_link', ts, agentId: aid, parentId: sid, agentType: at }, { t: 'prompt', ts, agentId: aid }]
      )
    }
    case 'SubagentStop':
      if (aid === undefined || !state.knownSubagents.has(aid)) return result(state)
      return result(state, [seen(), { t: 'turn_end', ts, agentId: aid }])
    case 'PreCompact':
      return result(state, [seen(), { t: 'compacting', ts, agentId, ...(trig ? { trigger: trig } : {}) }])
    case 'PostCompact':
      return result(state, [seen(), { t: 'compacted', ts, agentId, ...(trig ? { trigger: trig } : {}) }])
    case 'PostModelSwitch': {
      const model = str('model')
      return model === undefined ? result(state, [seen()]) : result(state, [seen(), { t: 'model_changed', ts, agentId, model }])
    }
    case 'SessionEnd': {
      const reason = str('reason')
      return result(state, [seen(), { t: 'session_end', ts, agentId, ...(reason ? { reason } : {}) }])
    }
  }
}
