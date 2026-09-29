// The pure view layer between World and anything that shows it to a person or sends it off the
// machine: the HTTP/SSE layer (publicWorld) and the list page's table and its four empty
// screens (agentRows, diagnosticsLine, emptyScreen/emptyScreenText). No I/O, same as the rest of
// core/ — the client passes in `world.clock` (or its own idea of "now") rather than this module
// ever reading a clock itself.

import { projectName } from './transcript/paths.js'
import { UNPARSED_REASONS, type Agent, type AgentState, type UnparsedBreakdown, type UnparsedReason, type World } from './types.js'

/** The World as it is safe to hand to the browser: real tool_use ids are never useful to a
 * viewer and are a needless thing to leak, and a full cwd would show more of the filesystem
 * than the page needs (design §4/§9: file paths are shown as basenames unless the user turns
 * full paths on — full paths are a later phase; for now the raw cwd never leaves the server). */
export function publicWorld(world: World, home?: string): World {
  const agents: Record<string, Agent> = {}
  for (const [id, agent] of Object.entries(world.agents)) {
    agents[id] = {
      ...agent,
      cwd: projectName(agent.cwd),
      spawnToolUseId: undefined,
      closedToolIds: undefined,
      openTools: agent.openTools.map((tool) => ({ ...tool, id: '' })),
    }
  }
  const { transcripts, hooks } = world.sources
  return {
    ...world,
    agents,
    diagnostics: { ...world.diagnostics, sourceErrors: world.diagnostics.sourceErrors.map((error) => tildePath(error, home)) },
    sources: {
      ...world.sources,
      transcripts: {
        ...transcripts,
        root: tildePath(transcripts.root, home),
        ...(transcripts.error !== undefined ? { error: tildePath(transcripts.error, home) } : {}),
      },
      hooks: { ...hooks, ...(hooks.eventsFile !== undefined ? { eventsFile: tildePath(hooks.eventsFile, home) } : {}) },
    },
  }
}

/** The text with the home directory written as `~` (S1-15): what leaves the machine, as a
 * screenshot, a `world.json` or a HAR file, names no user directory. */
export function tildePath(text: string, home: string | undefined): string {
  if (home === undefined || home.length < 2) return text
  const trimmed = home.replace(/\/+$/, '')
  if (trimmed.length < 2) return text
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`${escaped}(?![A-Za-z0-9_.-])`, 'g'), '~')
}

// --- The four empty screens (design §3.1, PLAN.md §1.9) ------------------------------------

export type EmptyScreenId = 'no-data' | 'unreadable' | 'no-collector' | 'no-agents'

/** Picks exactly one of the four empty screens, or null when there is at least one agent to
 * show a table for. `world` is undefined only before the client has received its first
 * snapshot at all (not even the "starting" one). */
export function emptyScreen(world: World | undefined): EmptyScreenId | null {
  if (!world || world.sources.transcripts.status === 'starting') return 'no-data'
  if (world.sources.transcripts.status === 'unreadable') return 'unreadable'
  if (Object.keys(world.agents).length > 0) return null
  const { files } = world.sources.transcripts
  if (files === 0 && world.sources.hooks.status === 'not_installed') return 'no-collector'
  return 'no-agents'
}

/** The message text for a given screen id, filled in from the World that produced it. */
export function emptyScreenText(id: EmptyScreenId, world: World | undefined): string {
  const transcripts = world?.sources.transcripts
  switch (id) {
    case 'no-data':
      return 'No data yet — reading transcripts…'
    case 'unreadable':
      return `Cannot read the transcripts folder ${transcripts?.root ?? ''}: ${transcripts?.error ?? 'unknown error'}`
    case 'no-collector':
      return `No transcripts found in ${transcripts?.root ?? ''}, and the live collector is not installed (run \`cubiclark hooks on\`)`
    case 'no-agents': {
      const windowHours = transcripts?.windowHours
      const older = (transcripts?.files ?? 0) - (transcripts?.inWindow ?? 0)
      const windowText = windowHours ? `in the last ${windowHours} hours` : 'right now'
      const olderText = older > 0 ? ` (${older} older transcript${older === 1 ? '' : 's'} not shown)` : ''
      return `No agents active ${windowText}${olderText}`
    }
  }
}

// --- The agent table -------------------------------------------------------------------------

const STATE_LABELS: Record<AgentState, string> = {
  starting: 'starting',
  thinking: 'thinking',
  reading: 'reading',
  editing: 'editing',
  running: 'running',
  searching: 'searching',
  browsing: 'browsing',
  delegating: 'delegating',
  waiting_permission: 'waiting for permission',
  waiting_user: 'waiting for you',
  compacting: 'compacting',
  stuck: 'stuck',
  rate_limited: 'rate limited',
  failed: 'failed',
  finished: 'finished',
  ended: 'ended',
}

export interface AgentRow {
  id: string
  /** The raw state, so the list and the office can be compared on the same value. */
  state: AgentState
  /** 0 for a top-level agent, 1+ for a subagent/teammate, one level per nesting step. */
  depth: number
  kind: Agent['kind']
  /** A short id plus the parent's label, if it has one and if it has a parent at all. */
  parentLabel?: string
  project: string
  model?: string
  /** Always text, with "(inferred)" appended when stateEvidence is 'inferred' — the state is
   * never shown by colour alone. */
  stateLabel: string
  /** Relative to nowMs, e.g. "3m ago". */
  since: string
  /** "<name> <target>", or just "<name>" when there is no target. */
  currentTool?: string
}

// The *last* 8 characters, not the first: every synthetic id in this codebase (and, in
// practice, every real Claude Code session id) shares a long common prefix, so a prefix-based
// "short id" would render identically for every agent. The tail is what actually varies.
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id
}

/** The state as text, shared by the list, the office's tooltips and its screen-reader labels. */
export function agentStateLabel(agent: Agent): string {
  const base = STATE_LABELS[agent.state]
  if (agent.stateEvidence !== 'inferred') return base
  // A guess is worded as one: "waiting for permission?" and never shown by text alone.
  return `${agent.state === 'waiting_permission' ? `${base}?` : base} (inferred)`
}

export function relativeSince(sinceIso: string, nowMs: number): string {
  const sinceMs = Date.parse(sinceIso)
  if (Number.isNaN(sinceMs)) return ''
  const deltaSec = Math.max(0, Math.round((nowMs - sinceMs) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  const deltaMin = Math.round(deltaSec / 60)
  if (deltaMin < 60) return `${deltaMin}m ago`
  const deltaHour = Math.round(deltaMin / 60)
  return `${deltaHour}h ago`
}

function currentToolText(agent: Agent): string | undefined {
  if (!agent.currentTool) return undefined
  return agent.currentTool.target ? `${agent.currentTool.name} ${agent.currentTool.target}` : agent.currentTool.name
}

function toRow(agent: Agent, world: World, depth: number, nowMs: number): AgentRow {
  const parent = agent.parentId ? world.agents[agent.parentId] : undefined
  return {
    id: agent.id,
    state: agent.state,
    depth,
    kind: agent.kind,
    parentLabel: parent ? `${shortId(parent.id)}${parent.label ? ` ${parent.label}` : ''}` : undefined,
    project: agent.project,
    model: agent.model,
    stateLabel: agentStateLabel(agent),
    since: relativeSince(agent.stateSince, nowMs),
    currentTool: currentToolText(agent),
  }
}

/** The table's rows, parents first and each agent's subagents/teammates immediately after it
 * and indented one level deeper — `layout(world)` in a later phase draws the same tree as desks
 * instead of rows, so both views always agree. `nowMs` drives the "since" column; pass
 * Date.parse(world.clock) to match the diagnostics line and the rest of the page. */
export function agentRows(world: World, nowMs: number): AgentRow[] {
  const children = new Map<string | undefined, Agent[]>()
  for (const agent of Object.values(world.agents)) {
    const parentKey = agent.parentId && world.agents[agent.parentId] ? agent.parentId : undefined
    const siblings = children.get(parentKey) ?? []
    siblings.push(agent)
    children.set(parentKey, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.id.localeCompare(b.id))

  const rows: AgentRow[] = []
  const visit = (parentKey: string | undefined, depth: number): void => {
    for (const agent of children.get(parentKey) ?? []) {
      rows.push(toRow(agent, world, depth, nowMs))
      visit(agent.id, depth + 1)
    }
  }
  visit(undefined, 0)
  return rows
}

/** One line naming each source and its health, e.g. "transcripts: live · hooks: live (14 events,
 * last 3s ago)". Measured against `world.clock`, like the rest of the page. */
export function sourcesLine(world: World): string {
  const { transcripts, hooks } = world.sources
  const transcriptsText = transcripts.status === 'live' ? 'live' : transcripts.status === 'starting' ? 'starting' : 'unreadable'

  let hooksText: string
  if (hooks.status === 'not_installed') {
    hooksText = 'not installed'
  } else if (hooks.status === 'failing') {
    hooksText = `failing${hooks.reason ? ` — ${hooks.reason}` : ''}`
  } else if (hooks.paused) {
    hooksText = 'paused'
  } else {
    const last = hooks.lastEventTs ? `, last ${relativeSince(hooks.lastEventTs, Date.parse(world.clock))}` : ''
    hooksText = `live (${hooks.events} events${last})`
  }
  // Each adapter that is on says how it is doing. One that is off is left out, unless a problem
  // with the configuration file is being reported beside it.
  const adapters = (world.sources.adapters ?? [])
    .filter((adapter) => adapter.status !== 'off' || adapter.detail.includes('config:'))
    .map((adapter) => ` · ${adapter.id}: ${adapter.status === 'live' ? '' : `${adapter.status} — `}${adapter.detail}`)
    .join('')
  return `transcripts: ${transcriptsText} · hooks: ${hooksText}${adapters}`
}

export const BUSY_STATES: ReadonlySet<AgentState> = new Set([
  'starting',
  'thinking',
  'reading',
  'editing',
  'running',
  'searching',
  'browsing',
  'delegating',
  'compacting',
])

/** Above this many agents the office is too crowded to read and the status line says so. */
export const BUSY_OFFICE_AGENTS = 50

/** The office's status line, e.g. "12 agents · 7 busy · 2 waiting for permission · 1 rate limited".
 * Waiting for permission is counted here on purpose (design §6): it is the state a person must act on. */
export function officeStatusLine(world: World): string {
  const agents = Object.values(world.agents)
  const busy = agents.filter((agent) => BUSY_STATES.has(agent.state)).length
  const waiting = agents.filter((agent) => agent.state === 'waiting_permission').length
  const limited = agents.filter((agent) => agent.state === 'rate_limited').length
  const parts = [`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`, `${busy} busy`]
  if (waiting > 0) parts.push(`${waiting} waiting for permission`)
  if (limited > 0) parts.push(`${limited} rate limited`)
  if (agents.length > BUSY_OFFICE_AGENTS) parts.push('busy office: the list view may be easier')
  return parts.join(' · ')
}

/** Reason -> total, biggest first (ties in the order of UNPARSED_REASONS). Names and counts only. */
export function unparsedReasonTotals(by: UnparsedBreakdown | undefined): [UnparsedReason, number][] {
  const totals: [UnparsedReason, number][] = []
  for (const reason of UNPARSED_REASONS) {
    const types = by?.[reason]
    if (!types) continue
    const sum = Object.values(types).reduce((a, b) => a + b, 0)
    if (sum > 0) totals.push([reason, sum])
  }
  return totals.sort((a, b) => b[1] - a[1])
}

/** The top record types for one reason, biggest first, then by name. */
export function unparsedTypeCounts(by: UnparsedBreakdown | undefined, reason: UnparsedReason, limit = 5): [string, number][] {
  return Object.entries(by?.[reason] ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
}

/** One line summarizing the World's diagnostics, e.g. "unparsed 3 · unknown types 2 · versions
 * 2.1.284 · source errors 1". Parts with nothing to report are left out; an all-clean World
 * produces "unparsed 0" alone. */
export function diagnosticsLine(world: World): string {
  const d = world.diagnostics
  const unknownTypeCount = Object.keys(d.unknownTypes).length
  const reasons = unparsedReasonTotals(d.unparsedBy)
    .slice(0, 3)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ')
  const parts = [
    `unparsed ${d.unparsedLines}${d.unparsedLines > 0 && reasons ? ` (${reasons})` : ''}`,
    unknownTypeCount > 0 ? `unknown types ${unknownTypeCount}` : undefined,
    d.versions.length > 0 ? `versions ${d.versions.join(', ')}` : undefined,
    d.unknownHookShapes > 0 ? `unknown hook shapes ${d.unknownHookShapes}` : undefined,
    d.sourceErrors.length > 0 ? `source errors ${d.sourceErrors.length}` : undefined,
  ]
  return parts.filter((p): p is string => p !== undefined).join(' · ')
}
