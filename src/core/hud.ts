// The HUD panel's view model (design §8): what its five parts say, as plain data. Pure, like the
// rest of core/: `nowMs` and `world.clock` come in as arguments. src/client/hud.ts only prints it,
// through textContent.

import { phaseAfterCut } from './adapters/apply.js'
import { accessoryFor, effectiveRole, modelFamily, type Accessory, type ModelFamily } from './office/roles.js'
import type { Agent, AgentRole, Task, TaskPhase, World } from './types.js'
import { agentStateLabel, BUSY_STATES, relativeSince, shortId } from './view.js'
import { hiddenText, type HiddenCounts } from './visible.js'

// --- Status bar ---------------------------------------------------------------------------------

export interface StatusSegment {
  /** 'sources' | 'agents' | 'hidden' | 'permission' | 'quota' | 'diagnostics' | 'replay' */
  id: string
  text: string
}

function sourcesText(world: World): string {
  const { transcripts, hooks, adapters } = world.sources
  const parts = [`transcripts ${transcripts.status === 'unreadable' ? 'unreadable' : transcripts.status}`]
  parts.push(hooks.status === 'not_installed' ? 'hooks off' : hooks.status === 'failing' ? 'hooks failing' : hooks.paused ? 'hooks paused' : 'hooks live')
  for (const adapter of adapters ?? []) {
    const name = adapter.id === 'task-folders' ? `tasks ${Object.keys(world.tasks).length}` : adapter.id === 'quota-samples' ? 'quota' : 'claude agents'
    if (adapter.status === 'live') parts.push(name)
    else if (adapter.status === 'failing') parts.push(`${name} failing`)
  }
  return parts.join(' · ')
}

/** The status bar, in order: sources, busy/total agents (of the World it is given: the agents in
 * view), how many are not shown (only when some are), permission waits (always, zero too: design §6,
 * the state a person must act on), quota, diagnostics, and replay progress. */
export function statusBar(world: World, hidden?: HiddenCounts): StatusSegment[] {
  const agents = Object.values(world.agents)
  const busy = agents.filter((agent) => BUSY_STATES.has(agent.state)).length
  const waiting = agents.filter((agent) => agent.state === 'waiting_permission').length
  const notShown = hiddenText(hidden)
  const d = world.diagnostics
  const diagnostics = [`unparsed ${d.unparsedLines}`]
  if (d.unknownHookShapes > 0) diagnostics.push(`unknown hook shapes ${d.unknownHookShapes}`)
  if (d.sourceErrors.length > 0) diagnostics.push(`errors ${d.sourceErrors.length}`)

  const segments: StatusSegment[] = [
    { id: 'sources', text: sourcesText(world) },
    { id: 'agents', text: `busy ${busy}/${agents.length}` },
    // The trace of the quiet office: what is not in the office or the list is counted here.
    ...(notShown === undefined ? [] : [{ id: 'hidden', text: notShown }]),
    { id: 'permission', text: `permission ${waiting}` },
    { id: 'quota', text: world.quota ? `5h ${Math.round(world.quota.p5h)}% · 7d ${Math.round(world.quota.p7d)}%` : 'quota —' },
    { id: 'diagnostics', text: diagnostics.join(' · ') },
  ]
  if (world.replay) {
    const at = `${world.clock.slice(11, 19)}Z`
    segments.push({ id: 'replay', text: `replay ${world.replay.speed}× · ${at}${world.replay.done ? ' · done' : ''}` })
  }
  return segments
}

// --- Selected agent card ------------------------------------------------------------------------

export interface CardField {
  label: string
  value: string
}

export interface AgentCard {
  title: string
  fields: CardField[]
}

function countersText(agent: Agent): string {
  const c = agent.counters
  const base = `prompts ${c.prompts} · tools ${c.tools} · subagents ${c.subagents} · compactions ${c.compactions}`
  return c.tokensOut !== undefined ? `${base} · tokens out ${c.tokensOut}` : base
}

/** Kind, role, model, effort, task, state, counters, and what `claude agents` and the error say. */
export function agentCard(world: World, agentId: string | undefined, nowMs: number): AgentCard | undefined {
  const agent = agentId === undefined ? undefined : world.agents[agentId]
  if (!agent) return undefined
  const task = agent.taskId === undefined ? undefined : world.tasks[agent.taskId]
  const fields: CardField[] = [
    { label: 'Kind', value: agent.kind },
    { label: 'Role', value: effectiveRole(agent, world) ?? '—' },
    { label: 'Model', value: agent.model ?? '—' },
    { label: 'Effort', value: agent.effort ?? '—' },
    { label: 'Task', value: agent.taskId === undefined ? '—' : `${agent.taskId} · ${task?.phase ?? 'no phase'}` },
    { label: 'State', value: `${agentStateLabel(agent)} · since ${relativeSince(agent.stateSince, nowMs)}` },
    { label: 'Counters', value: countersText(agent) },
  ]
  if (agent.cli) {
    const said = [agent.cli.state, agent.cli.status, agent.cli.waitingFor].filter((part): part is string => part !== undefined)
    fields.push({ label: 'claude agents', value: said.length > 0 ? said.join(' · ') : 'listed' })
  }
  if (agent.error) fields.push({ label: 'Error', value: agent.error.message ?? agent.error.kind })
  return { title: `${shortId(agent.id)}${agent.label ? ` ${agent.label}` : ''}`, fields }
}

// --- Session log --------------------------------------------------------------------------------

export interface LogFilter {
  project?: string
  taskId?: string
}

export interface LogRow {
  ts: string
  agentId: string
  /** A short id and the agent's label or role. */
  agent: string
  event: string
  result: string
}

export function logFilterOptions(world: World): { projects: string[]; tasks: string[] } {
  const projects = new Set<string>()
  for (const agent of Object.values(world.agents)) if (agent.project !== '') projects.add(agent.project)
  return { projects: [...projects].sort(), tasks: Object.keys(world.tasks).sort() }
}

function agentText(agent: Agent | undefined, agentId: string, world: World): string {
  if (!agent) return shortId(agentId)
  const who = agent.label ?? effectiveRole(agent, world)
  return who ? `${shortId(agentId)} ${who}` : shortId(agentId)
}

/** The newest `limit` lines that pass the filter, oldest first: newest at the bottom. A line whose
 * agent is no longer in the World is kept when nothing is filtered and dropped when something is. */
export function logRows(world: World, filter: LogFilter, limit = 200): LogRow[] {
  const filtering = filter.project !== undefined || filter.taskId !== undefined
  const rows: LogRow[] = []
  // Lines arrive per source and per file, so the log is in arrival order: the panel shows it by
  // time (a stable sort: lines of one moment keep their order).
  const ordered = [...world.log].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  for (const line of ordered) {
    const agent = world.agents[line.agentId]
    if (filtering) {
      if (!agent) continue
      if (filter.project !== undefined && agent.project !== filter.project) continue
      if (filter.taskId !== undefined && agent.taskId !== filter.taskId) continue
    }
    rows.push({ ts: line.ts, agentId: line.agentId, agent: agentText(agent, line.agentId, world), event: line.kind, result: line.text })
  }
  return rows.length > limit ? rows.slice(-limit) : rows
}

// --- Task timeline ------------------------------------------------------------------------------

export type StageName = 'planning' | 'building' | 'review' | 'done'
export type StageState = 'past' | 'current' | 'future' | 'blocked'

export interface TimelineEntryView {
  ts: string
  kind: string
  model?: string
  /** "opus → sonnet", when the model differs from the previous entry that had one. */
  modelChange?: string
  text: string
}

export interface TimelineView {
  taskId: string
  title?: string
  project?: string
  model?: string
  effort?: string
  pr?: number
  stages: { stage: StageName; state: StageState }[]
  entries: TimelineEntryView[]
}

const STAGES: readonly StageName[] = ['planning', 'building', 'review', 'done']

function modelLabel(model: string): string {
  const family = modelFamily(model)
  return family === 'other' ? model : family
}

function stageIndex(phase: TaskPhase | undefined): number {
  return phase === 'planning' ? 0 : phase === 'building' ? 1 : phase === 'review' ? 2 : phase === 'done' ? 3 : -1
}

/** planning -> building -> review -> done, with where the task is. A blocked task marks the stage
 * it stopped in: the one its newest non-blocking entry implies (building when that says nothing). */
export function timelineView(task: Task): TimelineView {
  let stages: TimelineView['stages']
  if (task.phase === undefined) {
    stages = STAGES.map((stage) => ({ stage, state: 'future' as const }))
  } else if (task.phase === 'blocked') {
    const before = phaseAfterCut(task.timeline.filter((entry) => entry.kind !== 'blocked'), task.planModel)
    const at = stageIndex(before === 'blocked' || before === 'done' || before === undefined ? 'building' : before)
    stages = STAGES.map((stage, i) => ({ stage, state: i < at ? ('past' as const) : i === at ? ('blocked' as const) : ('future' as const) }))
  } else {
    const at = stageIndex(task.phase)
    stages = STAGES.map((stage, i) => ({ stage, state: i < at ? ('past' as const) : i === at ? ('current' as const) : ('future' as const) }))
  }

  let previousModel: string | undefined
  const entries = task.timeline.map((entry): TimelineEntryView => {
    const view: TimelineEntryView = { ts: entry.ts, kind: entry.kind, text: entry.text }
    if (entry.model) {
      view.model = entry.model
      if (previousModel !== undefined && previousModel !== entry.model) {
        const from = modelLabel(previousModel)
        const to = modelLabel(entry.model)
        view.modelChange = `${from === to ? previousModel : from} → ${from === to ? entry.model : to}`
      }
      previousModel = entry.model
    }
    return view
  })

  const out: TimelineView = { taskId: task.id, stages, entries }
  if (task.title !== undefined) out.title = task.title
  if (task.project !== undefined) out.project = task.project
  if (task.model !== undefined) out.model = task.model
  if (task.effort !== undefined) out.effort = task.effort
  if (task.pr !== undefined) out.pr = task.pr
  return out
}

/** The task the timeline shows when nobody chose one: the selected agent's, else the task that is
 * not done and was active most recently. */
export function defaultTaskId(world: World, selectedAgentId?: string): string | undefined {
  const own = selectedAgentId === undefined ? undefined : world.agents[selectedAgentId]?.taskId
  if (own !== undefined && world.tasks[own]) return own
  let best: Task | undefined
  for (const task of Object.values(world.tasks)) {
    if (task.phase === 'done') continue
    const at = task.lastActivity === undefined ? Number.NEGATIVE_INFINITY : Date.parse(task.lastActivity)
    const bestAt = best?.lastActivity === undefined ? Number.NEGATIVE_INFINITY : Date.parse(best.lastActivity)
    if (!best || at > bestAt || (at === bestAt && task.id < best.id)) best = task
  }
  return best?.id
}

// --- Legend -------------------------------------------------------------------------------------

export const LEGEND: {
  models: { family: ModelFamily; label: string }[]
  roles: { role: AgentRole; accessory: Accessory }[]
} = {
  models: [
    { family: 'opus', label: 'Opus' },
    { family: 'sonnet', label: 'Sonnet' },
    { family: 'haiku', label: 'Haiku' },
    { family: 'fable', label: 'Fable' },
    { family: 'other', label: 'other' },
  ],
  roles: (['orchestrator', 'planner', 'reviewer', 'builder', 'explorer'] as const).map((role) => ({ role, accessory: accessoryFor(role) })),
}
