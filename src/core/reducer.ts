// events -> World. Pure: every timestamp comes from the event, nothing reads a clock. The
// state machine here is PLAN.md §1.6's table; `tick()` (a separate pure function) is where
// `stuck` and the inferred permission wait live, since both need a clock the reducer never sees.

import { projectName } from './transcript/paths.js'
import { toolStateForName } from './transcript/tools.js'
import type {
  AgentEvent,
  AgentMetaEvent,
  AgentRole,
  ApiErrorEvent,
  AssistantEvent,
  CompactionEvent,
  InterruptedEvent,
  PermissionModeEvent,
  PromptEvent,
  SubagentLinkEvent,
  ToolEndEvent,
  ToolStartEvent,
  TurnEndEvent,
  World,
} from './types.js'
import { ensureAgent, noteVersion, pushLog, pushSourceError, setState, updateAgent } from './world.js'

function roleFromAgentType(agentType: string | undefined): AgentRole | undefined {
  if (!agentType) return undefined
  if (agentType === 'Explore') return 'explorer'
  if (agentType === 'Plan') return 'planner'
  if (/review|verif/i.test(agentType)) return 'reviewer'
  return undefined
}

function isHelperKind(kind: string): boolean {
  return kind === 'subagent' || kind === 'teammate'
}

function applyAgentMeta(world: World, event: AgentMetaEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    kind: event.kind ?? agent.kind,
    parentId: event.parentId ?? agent.parentId,
    cwd: event.cwd ?? agent.cwd,
    project: event.cwd ? projectName(event.cwd) : agent.project,
    label: event.label ?? agent.label,
    lastActivity: event.ts,
  }))
  if (event.version) next = noteVersion(next, event.version)
  return next
}

function applySubagentLink(world: World, event: SubagentLinkEvent): World {
  const next = ensureAgent(world, event.agentId, event.ts)

  // A nested subagent (one that started another subagent, not the top-level session) re-
  // parents to whichever helper currently has this spawn id as an open tool.
  let parentId: string = event.parentId
  if (event.spawnToolUseId) {
    for (const agent of Object.values(next.agents)) {
      if (isHelperKind(agent.kind) && agent.openTools.some((t) => t.id === event.spawnToolUseId)) {
        parentId = agent.id
        break
      }
    }
  }

  return updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    kind: event.name ? 'teammate' : 'subagent',
    parentId,
    label: event.agentType ?? agent.label,
    spawnToolUseId: event.spawnToolUseId ?? agent.spawnToolUseId,
    role: roleFromAgentType(event.agentType) ?? agent.role,
    lastActivity: event.ts,
  }))
}

function applyPrompt(world: World, event: PromptEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    counters: { ...agent.counters, prompts: agent.counters.prompts + 1 },
    openTools: [],
    error: undefined,
    lastActivity: event.ts,
  }))
  return setState(next, event.agentId, 'thinking', event.ts)
}

function applyAssistant(world: World, event: AssistantEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    model: event.model ?? agent.model,
    counters: event.tokensOut
      ? { ...agent.counters, tokensOut: (agent.counters.tokensOut ?? 0) + event.tokensOut }
      : agent.counters,
    lastActivity: event.ts,
  }))
  const agent = next.agents[event.agentId]
  if (agent && agent.openTools.length === 0 && agent.state !== 'delegating') {
    next = setState(next, event.agentId, 'thinking', event.ts)
  }
  return next
}

function applyToolStart(world: World, event: ToolStartEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  const state = toolStateForName(event.name)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    counters: {
      ...agent.counters,
      tools: agent.counters.tools + 1,
      subagents: state === 'delegating' ? agent.counters.subagents + 1 : agent.counters.subagents,
    },
    openTools: [...agent.openTools, { id: event.toolUseId, name: event.name, target: event.target, since: event.ts }],
    currentTool: { name: event.name, target: event.target },
    lastActivity: event.ts,
  }))
  return setState(next, event.agentId, state, event.ts)
}

function applyToolEnd(world: World, event: ToolEndEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    openTools: agent.openTools.filter((t) => t.id !== event.toolUseId),
    lastActivity: event.ts,
  }))

  // A safety net for a subagent whose own transcript never cleanly ends: when the parent's
  // matching tool_end arrives, force it to a terminal state here too.
  for (const [id, agent] of Object.entries(next.agents)) {
    if (agent.spawnToolUseId === event.toolUseId && agent.state !== 'finished' && agent.state !== 'failed') {
      next = setState(next, id, event.isError ? 'failed' : 'finished', event.ts)
    }
  }

  if (event.denied) {
    next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'permission', text: 'permission denied' })
  }

  const agent = next.agents[event.agentId]
  if (agent) {
    const lastOpen = agent.openTools[agent.openTools.length - 1]
    next = updateAgent(next, event.agentId, (a) => ({
      ...a,
      currentTool: lastOpen ? { name: lastOpen.name, target: lastOpen.target } : undefined,
    }))
    next = setState(next, event.agentId, lastOpen ? toolStateForName(lastOpen.name) : 'thinking', event.ts)
  }
  return next
}

function finishOrWait(world: World, agentId: string, ts: string): World {
  const agent = world.agents[agentId]
  const targetState = agent && isHelperKind(agent.kind) ? 'finished' : 'waiting_user'
  return setState(world, agentId, targetState, ts)
}

function applyTurnEnd(world: World, event: TurnEndEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    openTools: [],
    currentTool: undefined,
    lastActivity: event.ts,
  }))
  return finishOrWait(next, event.agentId, event.ts)
}

function applyInterrupted(world: World, event: InterruptedEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    openTools: [],
    currentTool: undefined,
    lastActivity: event.ts,
  }))
  return finishOrWait(next, event.agentId, event.ts)
}

function applyCompaction(world: World, event: CompactionEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    counters: { ...agent.counters, compactions: agent.counters.compactions + 1 },
    lastActivity: event.ts,
  }))
  const text = event.trigger ? `compacted (${event.trigger})` : 'compacted'
  return pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'compaction', text })
}

function applyApiError(world: World, event: ApiErrorEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    error: { kind: event.kind, status: event.status, message: event.message },
    lastActivity: event.ts,
  }))
  if (event.kind === 'rate_limit' || event.kind === 'overloaded') {
    return setState(next, event.agentId, 'rate_limited', event.ts)
  }
  if (!event.retrying) {
    return setState(next, event.agentId, 'failed', event.ts)
  }
  return pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'error', text: 'retrying after an error' })
}

function applyPermissionMode(world: World, event: PermissionModeEvent): World {
  const next = ensureAgent(world, event.agentId, event.ts)
  return updateAgent(next, event.agentId, (agent) => ({ ...agent, permissionMode: event.mode, lastActivity: event.ts }))
}

function applyDiagnostics(world: World, event: Extract<AgentEvent, { t: 'diagnostics' }>): World {
  let next = world
  if (event.unparsed > 0) {
    next = { ...next, diagnostics: { ...next.diagnostics, unparsedLines: next.diagnostics.unparsedLines + event.unparsed } }
  }
  for (const [type, count] of Object.entries(event.unknownTypes)) {
    next = {
      ...next,
      diagnostics: {
        ...next.diagnostics,
        unknownTypes: { ...next.diagnostics.unknownTypes, [type]: (next.diagnostics.unknownTypes[type] ?? 0) + count },
      },
    }
  }
  for (const version of event.versions) next = noteVersion(next, version)
  if (event.sourceError) next = pushSourceError(next, event.sourceError)
  return next
}

export function reduce(world: World, event: AgentEvent): World {
  switch (event.t) {
    case 'agent_meta':
      return applyAgentMeta(world, event)
    case 'subagent_link':
      return applySubagentLink(world, event)
    case 'prompt':
      return applyPrompt(world, event)
    case 'assistant':
      return applyAssistant(world, event)
    case 'tool_start':
      return applyToolStart(world, event)
    case 'tool_end':
      return applyToolEnd(world, event)
    case 'turn_end':
      return applyTurnEnd(world, event)
    case 'interrupted':
      return applyInterrupted(world, event)
    case 'compaction':
      return applyCompaction(world, event)
    case 'api_error':
      return applyApiError(world, event)
    case 'permission_mode':
      return applyPermissionMode(world, event)
    case 'diagnostics':
      return applyDiagnostics(world, event)
  }
}
