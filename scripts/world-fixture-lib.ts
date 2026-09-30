// Builders for the World values the office is drawn and tested from (PLAN.md phase 3 §2.10). Every
// world passes through publicWorld(), so it has the exact shape the browser receives over SSE.
// Everything here is invented: ids come from the same families as scripts/fixture-lib.ts, project
// names are 'demo', 'shop' and friends, and the log is empty (so no "agentId" key ever lands in a
// fixture file, which test/personal-data.test.ts would then have to vet).

import { AGENT_STATES } from '../src/core/types.js'
import type { Agent, AgentKind, AgentRole, AgentState, CurrentTool, Task, World } from '../src/core/types.js'
import { publicWorld } from '../src/core/view.js'
import { emptyWorld } from '../src/core/world.js'
import { subagentId } from './fixture-lib.js'

export const WORLD_CLOCK = '2026-01-15T10:30:00.000Z'
const CLOCK_MS = Date.parse(WORLD_CLOCK)
const TRANSCRIPTS_ROOT = '/fixture/claude/projects'

export function worldSessionId(n: number): string {
  return `00000000-0000-4000-8000-${(0xa0000 + n).toString(16).padStart(12, '0')}`
}

export function worldSubagentId(n: number): string {
  return subagentId((0xb000 + n).toString(16))
}

const iso = (ms: number): string => new Date(ms).toISOString()

interface AgentSpec {
  id: string
  state: AgentState
  kind?: AgentKind
  parentId?: string
  project?: string
  role?: AgentRole
  label?: string
  model?: string
  tool?: CurrentTool
  taskId?: string
  /** How long ago the agent's last activity was; default 5 s. */
  quietMs?: number
  error?: Agent['error']
  evidence?: Agent['stateEvidence']
}

function makeAgent(spec: AgentSpec): Agent {
  const project = spec.project ?? 'demo'
  const lastActivity = iso(CLOCK_MS - (spec.quietMs ?? 5000))
  return {
    id: spec.id,
    kind: spec.kind ?? 'session',
    parentId: spec.parentId,
    project,
    cwd: `/home/user/projects/${project}`,
    model: spec.model ?? 'claude-sonnet-5-5',
    role: spec.role,
    label: spec.label,
    taskId: spec.taskId,
    state: spec.state,
    stateSince: iso(CLOCK_MS - Math.max(120_000, spec.quietMs ?? 0)),
    lastActivity,
    currentTool: spec.tool,
    counters: { prompts: 1, tools: 3, compactions: 0, subagents: 0 },
    openTools: [],
    error: spec.error,
    stateEvidence: spec.evidence,
  }
}

interface WorldSpec {
  agents: AgentSpec[]
  tasks?: Task[]
  withQuota?: boolean
}

function buildWorld(spec: WorldSpec): World {
  const world = emptyWorld(WORLD_CLOCK, TRANSCRIPTS_ROOT)
  const agents: Record<string, Agent> = {}
  for (const agentSpec of spec.agents) agents[agentSpec.id] = makeAgent(agentSpec)
  const tasks: Record<string, Task> = {}
  for (const task of spec.tasks ?? []) tasks[task.id] = task
  return publicWorld({
    ...world,
    agents,
    tasks,
    quota: spec.withQuota ? { p5h: 100, p7d: 40, resets5h: iso(CLOCK_MS + 42 * 60_000) } : undefined,
    sources: {
      transcripts: { status: 'live', root: TRANSCRIPTS_ROOT, files: 5, inWindow: 5, windowHours: 12 },
      hooks: { status: 'live', events: 42, lastEventTs: WORLD_CLOCK },
    },
  })
}

const TOOL_FOR_STATE: Partial<Record<AgentState, CurrentTool>> = {
  reading: { name: 'Read', target: 'index.ts' },
  searching: { name: 'Grep', target: 'TODO' },
  browsing: { name: 'WebFetch', target: 'example.com' },
  editing: { name: 'Edit', target: 'app.ts' },
  running: { name: 'Bash', target: 'npm' },
}

const EXPLORE_CHILD = (parentId: string, n: number): AgentSpec => ({
  id: worldSubagentId(n),
  kind: 'subagent',
  parentId,
  label: 'Explore',
  role: 'explorer',
  state: 'searching',
  tool: TOOL_FOR_STATE.searching,
})

function specForState(id: string, state: AgentState): AgentSpec {
  return {
    id,
    state,
    role: 'builder',
    tool: TOOL_FOR_STATE[state],
    quietMs: state === 'stuck' ? 12 * 60_000 : undefined,
    error:
      state === 'failed'
        ? { kind: 'other', message: 'API Error: invalid request: missing required field' }
        : undefined,
  }
}

/** One session in `state`, always at the same seat; `delegating` adds its subagent. */
export function stateWorld(state: AgentState): World {
  const agents: AgentSpec[] = [specForState(worldSessionId(1), state)]
  if (state === 'delegating') agents.push(EXPLORE_CHILD(worldSessionId(1), 1))
  return buildWorld({ agents, withQuota: state === 'rate_limited' })
}

/** One session per state, in AGENT_STATES order, plus the delegating one's subagent. */
export function allStatesWorld(): World {
  const agents = AGENT_STATES.map((state, index) => specForState(worldSessionId(index + 1), state))
  const delegatingIndex = AGENT_STATES.indexOf('delegating')
  agents.push(EXPLORE_CHILD(worldSessionId(delegatingIndex + 1), 1))
  return buildWorld({ agents, withQuota: true })
}

export function roomsWorld(): World {
  const s = worldSessionId
  const sub = worldSubagentId
  const agents: AgentSpec[] = [
    { id: s(1), state: 'waiting_user', role: 'orchestrator', model: 'claude-opus-5-5' },
    // No role of its own: it is an orchestrator because it started a background session.
    { id: s(2), state: 'thinking', model: 'claude-opus-5-5' },
    { id: s(3), state: 'running', kind: 'background', parentId: s(2), project: 'shop', tool: TOOL_FOR_STATE.running },
    { id: s(4), state: 'thinking', role: 'planner', model: 'claude-opus-5-5' },
    // A planner only because its task is in the planning phase.
    { id: s(5), state: 'thinking', taskId: 'task-plan' },
    { id: s(6), state: 'editing', role: 'builder', tool: TOOL_FOR_STATE.editing },
    { id: s(7), state: 'reading', role: 'builder', project: 'shop', model: 'claude-haiku-4-5-20251001', tool: TOOL_FOR_STATE.reading },
    // A reviewer only because its label says so.
    { id: sub(1), state: 'reading', kind: 'subagent', parentId: s(6), label: 'code-reviewer', tool: TOOL_FOR_STATE.reading },
    { id: sub(2), state: 'searching', kind: 'subagent', parentId: s(6), label: 'Explore', role: 'explorer', tool: TOOL_FOR_STATE.searching },
    // A subagent of a subagent sits by the root builder's desk.
    { id: sub(3), state: 'reading', kind: 'subagent', parentId: sub(2), label: 'Explore', role: 'explorer', tool: TOOL_FOR_STATE.reading },
    { id: s(8), state: 'thinking', kind: 'teammate', parentId: s(6) },
    // Its parent is not in the world at all.
    { id: sub(5), state: 'thinking', kind: 'subagent', parentId: sub(99), label: 'Explore', role: 'explorer' },
    { id: sub(6), state: 'thinking', kind: 'subagent', parentId: s(6), label: 'Plan', role: 'planner' },
    // Five helpers under one builder: three stools and two on the bench.
    ...[7, 8, 9, 10, 11].map((n) => EXPLORE_CHILD(s(7), n)),
    { id: s(9), state: 'finished', role: 'builder', quietMs: 10 * 60_000 },
    { id: s(10), state: 'ended', role: 'builder', quietMs: 20 * 60_000 },
  ]
  return buildWorld({
    agents,
    tasks: [{ id: 'task-plan', phase: 'planning', timeline: [] }],
    withQuota: true,
  })
}

const CROWD_PROJECTS = ['demo', 'shop', 'blog', 'api', 'docs'] as const
const CROWD_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'other-model'] as const
const LIVE_STATES = AGENT_STATES.filter((state) => state !== 'finished' && state !== 'ended')
const HELPER_STATES: AgentState[] = ['searching', 'reading', 'thinking', 'running', 'editing']

/** 50 agents: 30 live sessions over 5 projects, 15 subagents under 10 of them, 5 that left. */
export function crowdWorld(): World {
  const agents: AgentSpec[] = []
  for (let i = 0; i < 30; i++) {
    const state = LIVE_STATES[i % LIVE_STATES.length] as AgentState
    const role: AgentRole = i === 10 ? 'orchestrator' : i === 11 ? 'planner' : i === 12 ? 'reviewer' : 'builder'
    agents.push({
      ...specForState(worldSessionId(i + 1), state),
      role,
      project: CROWD_PROJECTS[i % CROWD_PROJECTS.length],
      model: CROWD_MODELS[i % CROWD_MODELS.length],
    })
  }
  // Sessions 1..5 get two helpers each, 6..10 get one: 15 in all.
  let next = 1
  for (let parent = 1; parent <= 10; parent++) {
    const count = parent <= 5 ? 2 : 1
    for (let k = 0; k < count; k++) {
      const state = HELPER_STATES[next % HELPER_STATES.length] as AgentState
      agents.push({
        id: worldSubagentId(next),
        kind: 'subagent',
        parentId: worldSessionId(parent),
        project: CROWD_PROJECTS[(parent - 1) % CROWD_PROJECTS.length],
        label: 'Explore',
        role: 'explorer',
        state,
        tool: TOOL_FOR_STATE[state],
      })
      next++
    }
  }
  for (let i = 0; i < 5; i++) {
    agents.push({
      id: worldSessionId(31 + i),
      state: i % 2 === 0 ? 'finished' : 'ended',
      role: 'builder',
      project: CROWD_PROJECTS[i % CROWD_PROJECTS.length],
      quietMs: (10 + i) * 60_000,
    })
  }
  return buildWorld({ agents, withQuota: true })
}

const CROWD_PROJECTS_100 = ['demo', 'shop', 'blog', 'api', 'docs', 'ops', 'web', 'cli'] as const

/** 100 agents (phase 5): 60 live sessions over 8 projects, 30 subagents under 20 of them (two each
 * under the first ten, one each under the next ten), 10 that left. */
export function crowd100World(): World {
  const agents: AgentSpec[] = []
  for (let i = 0; i < 60; i++) {
    const state = LIVE_STATES[i % LIVE_STATES.length] as AgentState
    const role: AgentRole = i === 10 ? 'orchestrator' : i === 11 ? 'planner' : i === 12 ? 'reviewer' : 'builder'
    agents.push({
      ...specForState(worldSessionId(i + 1), state),
      role,
      project: CROWD_PROJECTS_100[i % CROWD_PROJECTS_100.length],
      model: CROWD_MODELS[i % CROWD_MODELS.length],
    })
  }
  let next = 1
  for (let parent = 1; parent <= 20; parent++) {
    const count = parent <= 10 ? 2 : 1
    for (let k = 0; k < count; k++) {
      const state = HELPER_STATES[next % HELPER_STATES.length] as AgentState
      agents.push({
        id: worldSubagentId(next),
        kind: 'subagent',
        parentId: worldSessionId(parent),
        project: CROWD_PROJECTS_100[(parent - 1) % CROWD_PROJECTS_100.length],
        label: 'Explore',
        role: 'explorer',
        state,
        tool: TOOL_FOR_STATE[state],
      })
      next++
    }
  }
  for (let i = 0; i < 10; i++) {
    agents.push({
      id: worldSessionId(61 + i),
      state: i % 2 === 0 ? 'finished' : 'ended',
      role: 'builder',
      project: CROWD_PROJECTS_100[i % CROWD_PROJECTS_100.length],
      quietMs: (10 + i) * 60_000,
    })
  }
  return buildWorld({ agents, withQuota: true })
}

/** The four worlds `emptyScreen` maps to its four screens. */
export function emptyWorlds(): Record<'starting' | 'unreadable' | 'no-collector' | 'no-agents', World> {
  const base = emptyWorld(WORLD_CLOCK, TRANSCRIPTS_ROOT)
  const withTranscripts = (transcripts: World['sources']['transcripts']): World => ({
    ...base,
    sources: { ...base.sources, transcripts },
  })
  return {
    starting: base,
    unreadable: withTranscripts({
      status: 'unreadable',
      root: TRANSCRIPTS_ROOT,
      error: 'permission denied',
      files: 0,
      inWindow: 0,
      windowHours: 12,
    }),
    'no-collector': withTranscripts({ status: 'live', root: TRANSCRIPTS_ROOT, files: 0, inWindow: 0, windowHours: 12 }),
    'no-agents': withTranscripts({ status: 'live', root: TRANSCRIPTS_ROOT, files: 3, inWindow: 0, windowHours: 12 }),
  }
}

/** Before: one builder thinking. After: it delegates to a new subagent (which walks to its
 * parent) and a second builder walks in from the door. */
export function arriveWorlds(): { before: World; after: World } {
  const first = worldSessionId(1)
  return {
    before: buildWorld({ agents: [{ id: first, state: 'thinking', role: 'builder' }] }),
    after: buildWorld({
      agents: [
        { id: first, state: 'delegating', role: 'builder' },
        EXPLORE_CHILD(first, 1),
        { id: worldSessionId(2), state: 'thinking', role: 'builder' },
      ],
    }),
  }
}

/** Before: two builders thinking. After: the second has finished and walks out. */
export function departWorlds(): { before: World; after: World } {
  const a = worldSessionId(1)
  const b = worldSessionId(2)
  return {
    before: buildWorld({
      agents: [
        { id: a, state: 'thinking', role: 'builder' },
        { id: b, state: 'thinking', role: 'builder' },
      ],
    }),
    after: buildWorld({
      agents: [
        { id: a, state: 'thinking', role: 'builder' },
        { id: b, state: 'finished', role: 'builder' },
      ],
    }),
  }
}

/** Morty's office (cubiclark-morty): four agents on one project floor and in the planning room.
 * s(1) has been waiting for you for five minutes (the only one who may play ball), s(2) waits for
 * a permission (who must never look like it is playing), s(3) is editing and s(4) is a planner
 * thinking, so the planning room is occupied and the whiteboard is not free. */
export function mascotPlayWorld(): World {
  return buildWorld({
    agents: [
      { id: worldSessionId(1), state: 'waiting_user', role: 'builder', quietMs: 5 * 60_000 },
      { id: worldSessionId(2), state: 'waiting_permission', role: 'builder' },
      { id: worldSessionId(3), state: 'editing', role: 'builder', tool: TOOL_FOR_STATE.editing },
      { id: worldSessionId(4), state: 'thinking', role: 'planner' },
    ],
  })
}

/** Every checked-in file under test/fixtures/worlds/, by name without `.json`. */
export const WORLD_FIXTURES: Record<string, () => World> = {
  ...Object.fromEntries(AGENT_STATES.map((state) => [`state-${state}`, () => stateWorld(state)])),
  'all-states': allStatesWorld,
  rooms: roomsWorld,
  'crowd-50': crowdWorld,
  'crowd-100': crowd100World,
  'empty-starting': () => emptyWorlds().starting,
  'empty-unreadable': () => emptyWorlds().unreadable,
  'empty-no-collector': () => emptyWorlds()['no-collector'],
  'empty-no-agents': () => emptyWorlds()['no-agents'],
  'arrive-before': () => arriveWorlds().before,
  'arrive-after': () => arriveWorlds().after,
  'depart-before': () => departWorlds().before,
  'depart-after': () => departWorlds().after,
  'mascot-play': mascotPlayWorld,
}
