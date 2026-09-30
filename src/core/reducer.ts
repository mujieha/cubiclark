// events -> World. Pure: every timestamp comes from the event, nothing reads a clock. The
// state machine here is PLAN.md §1.6's table; `tick()` (a separate pure function) is where
// `stuck` and the inferred permission wait live, since both need a clock the reducer never sees.

import { MAX_COUNTED_NAMES, bump, isSafeKey } from './keys.js'
import { projectName } from './transcript/paths.js'
import { toolStateForName } from './transcript/tools.js'
import type {
  AgentEvent,
  AgentMetaEvent,
  AgentRole,
  ApiErrorEvent,
  AssistantEvent,
  CompactedEvent,
  CompactingEvent,
  CompactionEvent,
  HookSeenEvent,
  InterruptedEvent,
  ModelChangedEvent,
  PermissionModeEvent,
  PermissionWaitEvent,
  PromptEvent,
  SessionEndEvent,
  SessionStartEvent,
  SubagentLinkEvent,
  ToolEndEvent,
  ToolStartEvent,
  TurnEndEvent,
  World,
} from './types.js'
import { ensureAgent, mergeUnparsedBy, noteVersion, pushLog, pushSourceError, setState, updateAgent } from './world.js'

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

const MAX_CLOSED_TOOL_IDS = 64

/** Remembers a closed tool id (newest last, capped) so a late duplicate tool_start cannot reopen
 * it. The empty id is never tracked: it stands for "the record had no id" and would match every
 * other id-less tool. */
function rememberClosed(ids: readonly string[] | undefined, id: string): string[] | undefined {
  if (id === '') return ids ? [...ids] : undefined
  const list = (ids ?? []).filter((x) => x !== id)
  list.push(id)
  return list.length > MAX_CLOSED_TOOL_IDS ? list.slice(-MAX_CLOSED_TOOL_IDS) : list
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(['finished', 'failed', 'ended'])

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
  // The first link a helper gets (it has no label or spawn id yet) is the moment it "started";
  // a later re-link of the same helper is not news.
  const known = world.agents[event.agentId]
  const firstLink = known === undefined || (known.label === undefined && known.spawnToolUseId === undefined)
  let next = ensureAgent(world, event.agentId, event.ts)

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

  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    kind: event.name ? 'teammate' : 'subagent',
    parentId,
    label: event.agentType ?? agent.label,
    spawnToolUseId: event.spawnToolUseId ?? agent.spawnToolUseId,
    role: roleFromAgentType(event.agentType) ?? agent.role,
    lastActivity: event.ts,
  }))
  return firstLink ? pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'subagent', text: `started ${event.agentType ?? 'subagent'}` }) : next
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
  next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'prompt', text: 'prompt' })
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
  // fillOnly: the merge gate lets a hooked agent's transcript record fill in the model and the
  // token count, but hooks own its state.
  if (!event.fillOnly && agent && agent.openTools.length === 0 && agent.state !== 'delegating') {
    next = setState(next, event.agentId, 'thinking', event.ts)
  }
  return next
}

function applyToolStart(world: World, event: ToolStartEvent): World {
  // Order-proof dedup: the same tool can arrive from both the hook source and the transcript,
  // and an async hook's PostToolUse can land before its PreToolUse.
  const known = world.agents[event.agentId]
  if (
    known &&
    event.toolUseId !== '' &&
    (known.openTools.some((t) => t.id === event.toolUseId) || known.closedToolIds?.includes(event.toolUseId))
  ) {
    return world
  }
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
  const openTool = next.agents[event.agentId]?.openTools.find((t) => t.id === event.toolUseId)
  const wasOpen = openTool !== undefined
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    openTools: agent.openTools.filter((t) => t.id !== event.toolUseId),
    closedToolIds: rememberClosed(agent.closedToolIds, event.toolUseId),
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

  // One line per tool that was open here: its name and reduced target, and how it ended. A result
  // that arrives for a tool this World never saw open (the other source got there first) has no line.
  if (openTool) {
    const result = event.denied ? 'denied' : event.isError ? 'error' : 'ok'
    const what = openTool.target ? `${openTool.name} ${openTool.target}` : openTool.name
    next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'tool', text: `${what} · ${result}` })
  }

  // A tool_end whose tool was never open here (its start arrived from the other source, or has
  // not arrived yet) is remembered above but must not move the agent's state.
  if (!wasOpen) return next

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
  const helper = isHelperKind(next.agents[event.agentId]?.kind ?? 'session')
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    openTools: [],
    currentTool: undefined,
    lastActivity: event.ts,
  }))
  next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'turn', text: helper ? 'finished' : 'turn done' })
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
    next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'error', text: event.kind === 'overloaded' ? 'overloaded' : 'rate limited' })
    return setState(next, event.agentId, 'rate_limited', event.ts)
  }
  if (!event.retrying) {
    next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'error', text: `failed: ${event.kind}` })
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
  const unknownTypes = { ...next.diagnostics.unknownTypes }
  for (const [type, count] of Object.entries(event.unknownTypes)) bump(unknownTypes, type, count, MAX_COUNTED_NAMES)
  if (Object.keys(event.unknownTypes).length > 0) next = { ...next, diagnostics: { ...next.diagnostics, unknownTypes } }
  if (event.unparsedBy) {
    next = { ...next, diagnostics: { ...next.diagnostics, unparsedBy: mergeUnparsedBy(next.diagnostics.unparsedBy, event.unparsedBy) } }
  }
  for (const version of event.versions) next = noteVersion(next, version)
  if (event.sourceError) next = pushSourceError(next, event.sourceError)
  if (event.unknownHookShapes) {
    next = {
      ...next,
      diagnostics: {
        ...next.diagnostics,
        unknownHookShapes: next.diagnostics.unknownHookShapes + event.unknownHookShapes,
      },
    }
  }
  return next
}

function applyHookSeen(world: World, event: HookSeenEvent): World {
  const existed = world.agents[event.agentId] !== undefined
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => {
    const previous = agent.hooked
    const keepPrevious = previous !== undefined && Date.parse(previous.lastTs) > Date.parse(event.ts)
    return {
      ...agent,
      kind: !existed && event.kind ? event.kind : agent.kind,
      parentId: agent.parentId ?? event.parentId,
      cwd: event.cwd ?? agent.cwd,
      project: event.cwd ? projectName(event.cwd) : agent.project,
      effort: event.effort ?? agent.effort,
      permissionMode: event.permissionMode ?? agent.permissionMode,
      hooked: { lastTs: keepPrevious ? previous.lastTs : event.ts, tools: (previous?.tools ?? false) || event.tools },
    }
  })
  return next
}

function applySessionStart(world: World, event: SessionStartEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  const fresh = event.source !== 'compact'
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    model: agent.model ?? event.model,
    openTools: fresh ? [] : agent.openTools,
    currentTool: fresh ? undefined : agent.currentTool,
    error: fresh ? undefined : agent.error,
    lastActivity: event.ts,
  }))
  if (!fresh) return next
  next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'session', text: `session started (${event.source})` })
  return setState(next, event.agentId, 'waiting_user', event.ts)
}

function endAgent(world: World, agentId: string, ts: string, seen: Set<string>): World {
  if (seen.has(agentId)) return world
  seen.add(agentId)
  let next = updateAgent(world, agentId, (agent) => ({ ...agent, openTools: [], currentTool: undefined, lastActivity: ts }))
  next = setState(next, agentId, 'ended', ts)
  for (const child of Object.values(next.agents)) {
    if (child.parentId === agentId && !TERMINAL_STATES.has(child.state)) next = endAgent(next, child.id, ts, seen)
  }
  return next
}

function applySessionEnd(world: World, event: SessionEndEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'session', text: event.reason ? `session ended (${event.reason})` : 'session ended' })
  return endAgent(next, event.agentId, event.ts, new Set())
}

function applyPermissionWait(world: World, event: PermissionWaitEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({
    ...agent,
    currentTool: agent.currentTool ?? (event.toolName ? { name: event.toolName } : undefined),
    lastActivity: event.ts,
  }))
  next = pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'permission', text: event.toolName ? `waiting for permission (${event.toolName})` : 'waiting for permission' })
  return setState(next, event.agentId, 'waiting_permission', event.ts)
}

function applyCompacting(world: World, event: CompactingEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({ ...agent, lastActivity: event.ts }))
  return setState(next, event.agentId, 'compacting', event.ts)
}

function applyCompacted(world: World, event: CompactedEvent): World {
  let next = ensureAgent(world, event.agentId, event.ts)
  next = updateAgent(next, event.agentId, (agent) => ({ ...agent, lastActivity: event.ts }))
  return setState(next, event.agentId, event.trigger === 'manual' ? 'waiting_user' : 'thinking', event.ts)
}

const UNSAFE_ID_ERROR = 'ignored an event whose agent id is not a plain name'

function applyModelChanged(world: World, event: ModelChangedEvent): World {
  const known = Object.hasOwn(world.agents, event.agentId) ? world.agents[event.agentId] : undefined
  if (known?.model === event.model) return world
  let next = ensureAgent(world, event.agentId, event.ts)
  // Only the model: the state, its timer and the last activity are not touched by a model switch.
  next = updateAgent(next, event.agentId, (agent) => ({ ...agent, model: event.model }))
  return pushLog(next, { ts: event.ts, agentId: event.agentId, kind: 'model', text: `model → ${event.model}` })
}

export function reduce(world: World, event: AgentEvent): World {
  if (event.t !== 'diagnostics') {
    // An id such as `constructor` is not a real one and would find an inherited property (S1-1).
    const ids = event as { agentId: string; parentId?: string }
    if (!isSafeKey(ids.agentId) || (ids.parentId !== undefined && !isSafeKey(ids.parentId))) {
      const errors = world.diagnostics.sourceErrors
      return errors[errors.length - 1] === UNSAFE_ID_ERROR ? world : pushSourceError(world, UNSAFE_ID_ERROR)
    }
  }
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
    case 'hook_seen':
      return applyHookSeen(world, event)
    case 'session_start':
      return applySessionStart(world, event)
    case 'session_end':
      return applySessionEnd(world, event)
    case 'permission_wait':
      return applyPermissionWait(world, event)
    case 'compacting':
      return applyCompacting(world, event)
    case 'compacted':
      return applyCompacted(world, event)
    case 'model_changed':
      return applyModelChanged(world, event)
  }
}
