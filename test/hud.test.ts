// The HUD's view model: status bar, agent card, session log rows and filters, task timeline.

import { describe, expect, test } from 'vitest'
import { buildTask } from '../src/core/adapters/task-folder.js'
import { agentCard, defaultTaskId, LEGEND, logFilterOptions, logRows, statusBar, timelineView } from '../src/core/hud.js'
import { reduce } from '../src/core/reducer.js'
import type { AdapterStatus, AgentEvent, Task, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

const S1 = '00000000-0000-4000-8000-000000000001'
const S2 = '00000000-0000-4000-8000-000000000002'
const A1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const A2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const T0 = '2026-01-16T10:00:00.000Z'
const NOW = Date.parse('2026-01-16T10:03:00Z')

function world(events: AgentEvent[] = [], patch: Partial<World> = {}): World {
  return { ...events.reduce(reduce, emptyWorld(T0, '/root')), ...patch }
}
const meta = (agentId: string, cwd = '/home/user/projects/demo', kind: 'session' | 'background' = 'session'): AgentEvent => ({ t: 'agent_meta', ts: T0, agentId, kind, cwd })
const live = (id: string, detail = 'x'): AdapterStatus => ({ id, status: 'live', detail })

const TASK_MD = ['# t', 'Goal: g', 'Project: /home/user/projects/demo', 'PlanModel: claude-opus-5-5', 'Effort: high'].join('\n')
function forkedTask(statusMd = 'state: in_progress'): Task {
  return buildTask({
    id: 'beta-build',
    taskMd: TASK_MD,
    statusMd,
    statusMtimeMs: Date.parse('2026-01-16T09:00:00Z'),
    logText: [
      `2026-01-15T09:00:00Z dispatched session ${S1} in /a/b model=claude-opus-5-5 effort=high`,
      `2026-01-15T09:30:00Z forked ${S1} -> ${S2} model=claude-sonnet-5-5 effort=high (compactions=1)`,
      '2026-01-15T10:15:00Z paused at weekly 95%',
      `2026-01-15T11:00:00Z resumed ${S2} model=claude-sonnet-5-5 effort=high`,
    ].join('\n'),
    nowMs: NOW,
  }).task
}

describe('statusBar', () => {
  test('an empty world: sources, busy 0/0, permission 0, no quota, unparsed 0', () => {
    expect(statusBar(world())).toEqual([
      { id: 'sources', text: 'transcripts starting · hooks off' },
      { id: 'agents', text: 'busy 0/0' },
      { id: 'permission', text: 'permission 0' },
      { id: 'quota', text: 'quota —' },
      { id: 'diagnostics', text: 'unparsed 0' },
    ])
  })

  test('busy counts, the permission waits, the quota and the diagnostics', () => {
    const w = world(
      [
        meta(A1),
        { t: 'prompt', ts: T0, agentId: A1 },
        meta(A2),
        { t: 'permission_wait', ts: T0, agentId: A2 },
      ],
      { quota: { p5h: 62.4, p7d: 40, resets5h: T0 } }
    )
    w.diagnostics = { ...w.diagnostics, unparsedLines: 3, unknownHookShapes: 2, sourceErrors: ['x'] }
    const bar = Object.fromEntries(statusBar(w).map((s) => [s.id, s.text]))
    expect(bar.agents).toBe('busy 1/2')
    expect(bar.permission).toBe('permission 1')
    expect(bar.quota).toBe('5h 62% · 7d 40%')
    expect(bar.diagnostics).toBe('unparsed 3 · unknown hook shapes 2 · errors 1')
  })

  test('the sources segment names the live adapters, marks failing ones, and leaves out missing and off', () => {
    const base = world([], { tasks: { a: { id: 'a', timeline: [] }, b: { id: 'b', timeline: [] } } })
    base.sources = {
      ...base.sources,
      transcripts: { ...base.sources.transcripts, status: 'live' },
      hooks: { status: 'live', events: 3 },
      adapters: [live('task-folders'), { id: 'quota-samples', status: 'failing', detail: 'x' }, { id: 'claude-agents', status: 'missing', detail: 'x' }],
    }
    expect(statusBar(base)[0]?.text).toBe('transcripts live · hooks live · tasks 2 · quota failing')
    base.sources = { ...base.sources, hooks: { status: 'live', events: 3, paused: true }, adapters: [live('quota-samples'), live('claude-agents'), { id: 'task-folders', status: 'off', detail: '' }] }
    expect(statusBar(base)[0]?.text).toBe('transcripts live · hooks paused · quota · claude agents')
    base.sources = { ...base.sources, hooks: { status: 'failing', events: 0 }, adapters: undefined }
    expect(statusBar(base)[0]?.text).toBe('transcripts live · hooks failing')
  })

  test('agents that are not shown are counted in a segment right after the agents, and only when there are some', () => {
    const w = world([meta(A1), { t: 'prompt', ts: T0, agentId: A1 }])
    const ids = (hidden?: { idle: number; finished: number }): string[] => statusBar(w, hidden).map((s) => s.id)
    expect(ids()).toEqual(['sources', 'agents', 'permission', 'quota', 'diagnostics'])
    expect(ids({ idle: 0, finished: 0 })).toEqual(['sources', 'agents', 'permission', 'quota', 'diagnostics'])
    expect(ids({ idle: 3, finished: 0 })).toEqual(['sources', 'agents', 'hidden', 'permission', 'quota', 'diagnostics'])
    expect(statusBar(w, { idle: 3, finished: 0 })[2]).toEqual({ id: 'hidden', text: '3 idle not shown' })
    expect(statusBar(w, { idle: 0, finished: 2 })[2]?.text).toBe('2 finished not shown')
    expect(statusBar(w, { idle: 195, finished: 6 })[2]?.text).toBe('195 idle not shown · 6 finished not shown')
    // the agents segment counts what it is given: the agents in view
    expect(statusBar(w, { idle: 3, finished: 0 })[1]?.text).toBe('busy 1/1')
  })

  test('replay adds a segment with the speed, the clock and, at the end, done', () => {
    const w = world([], { clock: '2026-01-16T15:04:05.000Z', replay: { sinceTs: T0, endTs: T0, speed: 10, done: false } })
    expect(statusBar(w).at(-1)).toEqual({ id: 'replay', text: 'replay 10× · 15:04:05Z' })
    expect(statusBar({ ...w, replay: { sinceTs: T0, endTs: T0, speed: 10, done: true } }).at(-1)?.text).toBe('replay 10× · 15:04:05Z · done')
    expect(statusBar(world()).some((s) => s.id === 'replay')).toBe(false)
  })
})

describe('agentCard', () => {
  test('undefined for an id that is not in the World, or none', () => {
    expect(agentCard(world(), 'nope', NOW)).toBeUndefined()
    expect(agentCard(world(), undefined, NOW)).toBeUndefined()
  })

  test('the fields in order, for a bare agent', () => {
    const card = agentCard(world([meta(A1)]), A1, NOW)
    expect(card?.title).toBe('00000001')
    expect(card?.fields).toEqual([
      { label: 'Kind', value: 'session' },
      { label: 'Role', value: 'builder' },
      { label: 'Model', value: '—' },
      { label: 'Effort', value: '—' },
      { label: 'Task', value: '—' },
      { label: 'State', value: 'starting · since 3m ago' },
      { label: 'Counters', value: 'prompts 0 · tools 0 · subagents 0 · compactions 0' },
    ])
  })

  test('model, effort, task, tokens, the claude agents answer and the error', () => {
    let w = world([
      meta(A1),
      { t: 'assistant', ts: T0, agentId: A1, model: 'claude-sonnet-5-5', tokensOut: 120, thinking: false, text: true },
      { t: 'api_error', ts: T0, agentId: A1, kind: 'other', retrying: false, message: 'boom' },
    ])
    w = {
      ...w,
      tasks: { 'beta-build': forkedTask() },
      agents: { ...w.agents, [A1]: { ...w.agents[A1]!, effort: 'high', taskId: 'beta-build', label: 'demo-worker', cli: { state: 'blocked', status: 'waiting', waitingFor: 'permission prompt', fetchedAt: T0 } } },
    }
    const card = agentCard(w, A1, NOW)
    const field = (label: string) => card?.fields.find((f) => f.label === label)?.value
    expect(card?.title).toBe('00000001 demo-worker')
    expect(field('Model')).toBe('claude-sonnet-5-5')
    expect(field('Effort')).toBe('high')
    expect(field('Task')).toBe('beta-build · building')
    expect(field('State')).toBe('failed · since 3m ago')
    expect(field('Counters')).toContain('tokens out 120')
    expect(field('claude agents')).toBe('blocked · waiting · permission prompt')
    expect(field('Error')).toBe('boom')
    expect(card?.fields.at(-1)?.label).toBe('Error')
  })

  test('a task the World does not have reads "no phase"; an inferred state says so', () => {
    const w0 = world([meta(A1)])
    const w = { ...w0, agents: { ...w0.agents, [A1]: { ...w0.agents[A1]!, taskId: 'ghost', state: 'waiting_permission' as const, stateEvidence: 'inferred' as const } } }
    const card = agentCard(w, A1, NOW)
    expect(card?.fields.find((f) => f.label === 'Task')?.value).toBe('ghost · no phase')
    expect(card?.fields.find((f) => f.label === 'State')?.value).toBe('waiting for permission? (inferred) · since 3m ago')
  })
})

describe('the session log', () => {
  function logged(): World {
    return world([
      meta(A1, '/home/user/projects/demo'),
      meta(A2, '/home/user/projects/shop'),
      { t: 'prompt', ts: '2026-01-16T10:00:01.000Z', agentId: A1 },
      { t: 'prompt', ts: '2026-01-16T10:00:02.000Z', agentId: A2 },
      { t: 'turn_end', ts: '2026-01-16T10:00:03.000Z', agentId: A1 },
    ])
  }

  test('rows are oldest first, with the agent as a short id and role', () => {
    expect(logRows(logged(), {})).toEqual([
      { ts: '2026-01-16T10:00:01.000Z', agentId: A1, agent: '00000001 builder', event: 'prompt', result: 'prompt' },
      { ts: '2026-01-16T10:00:02.000Z', agentId: A2, agent: '00000002 builder', event: 'prompt', result: 'prompt' },
      { ts: '2026-01-16T10:00:03.000Z', agentId: A1, agent: '00000001 builder', event: 'turn', result: 'turn done' },
    ])
  })

  test('rows are in time order whatever order the lines arrived in, and lines of one moment keep theirs', () => {
    const w0 = logged()
    const w = {
      ...w0,
      log: [
        { ts: '2026-01-16T10:00:09.000Z', agentId: A1, kind: 'turn', text: 'late' },
        { ts: '2026-01-16T10:00:01.000Z', agentId: A1, kind: 'prompt', text: 'first' },
        { ts: '2026-01-16T10:00:05.000Z', agentId: A2, kind: 'tool', text: 'b' },
        { ts: '2026-01-16T10:00:05.000Z', agentId: A1, kind: 'tool', text: 'c' },
      ],
    }
    expect(logRows(w, {}).map((r) => r.result)).toEqual(['first', 'b', 'c', 'late'])
    expect(logRows(w, {}, 2).map((r) => r.result)).toEqual(['c', 'late'])
  })

  test('the limit keeps the newest rows', () => {
    expect(logRows(logged(), {}, 2).map((r) => r.result)).toEqual(['prompt', 'turn done'])
  })

  test('filter by project, and by task', () => {
    let w = logged()
    w = { ...w, agents: { ...w.agents, [A1]: { ...w.agents[A1]!, taskId: 'beta-build' } } }
    expect(logRows(w, { project: 'shop' }).map((r) => r.agentId)).toEqual([A2])
    expect(logRows(w, { taskId: 'beta-build' }).map((r) => r.agentId)).toEqual([A1, A1])
    expect(logRows(w, { project: 'demo', taskId: 'beta-build' })).toHaveLength(2)
    expect(logRows(w, { project: 'shop', taskId: 'beta-build' })).toEqual([])
  })

  test('a line whose agent has left the World stays unfiltered and goes when filtering', () => {
    const w = { ...logged(), log: [...logged().log, { ts: '2026-01-16T10:00:10.000Z', agentId: 'gone', kind: 'tool', text: 'Read x · ok' }] }
    expect(logRows(w, {}).at(-1)).toMatchObject({ agentId: 'gone', agent: 'gone' })
    expect(logRows(w, { project: 'demo' }).some((r) => r.agentId === 'gone')).toBe(false)
  })

  test('the agent column prefers the label over the role', () => {
    const w0 = logged()
    const w = { ...w0, agents: { ...w0.agents, [A1]: { ...w0.agents[A1]!, label: 'Explore' } } }
    expect(logRows(w, {})[0]?.agent).toBe('00000001 Explore')
  })

  test('filter options are sorted and unique', () => {
    const w = { ...logged(), tasks: { b: { id: 'b', timeline: [] }, a: { id: 'a', timeline: [] } } }
    expect(logFilterOptions(w)).toEqual({ projects: ['demo', 'shop'], tasks: ['a', 'b'] })
    expect(logFilterOptions(world())).toEqual({ projects: [], tasks: [] })
  })
})

describe('timelineView', () => {
  test('stages follow the phase; earlier ones are past, later ones future', () => {
    const states = (task: Task) => timelineView(task).stages.map((s) => `${s.stage}:${s.state}`)
    expect(states({ id: 't', timeline: [], phase: 'planning' })).toEqual(['planning:current', 'building:future', 'review:future', 'done:future'])
    expect(states({ id: 't', timeline: [], phase: 'building' })).toEqual(['planning:past', 'building:current', 'review:future', 'done:future'])
    expect(states({ id: 't', timeline: [], phase: 'review' })).toEqual(['planning:past', 'building:past', 'review:current', 'done:future'])
    expect(states({ id: 't', timeline: [], phase: 'done' })).toEqual(['planning:past', 'building:past', 'review:past', 'done:current'])
    expect(states({ id: 't', timeline: [] })).toEqual(['planning:future', 'building:future', 'review:future', 'done:future'])
  })

  test('a blocked task marks the stage it stopped in', () => {
    const at = (kind: 'planned' | 'dispatched' | 'pr', model?: string): Task => ({
      id: 't',
      phase: 'blocked',
      planModel: 'opus',
      timeline: [{ ts: '2026-01-16T09:00:00Z', kind, text: kind, ...(model ? { model } : {}) }, { ts: '2026-01-16T10:00:00Z', kind: 'blocked', text: 'blocked' }],
    })
    const stage = (task: Task) => timelineView(task).stages.map((s) => s.state)
    expect(stage(at('planned'))).toEqual(['blocked', 'future', 'future', 'future'])
    expect(stage(at('dispatched', 'sonnet'))).toEqual(['past', 'blocked', 'future', 'future'])
    expect(stage(at('pr'))).toEqual(['past', 'past', 'blocked', 'future'])
    expect(stage({ id: 't', phase: 'blocked', timeline: [] })).toEqual(['past', 'blocked', 'future', 'future'])
  })

  test('the model change on the fork: opus -> sonnet, once', () => {
    const view = timelineView(forkedTask())
    expect(view.entries.map((e) => e.kind)).toEqual(['dispatched', 'forked', 'paused', 'resumed'])
    expect(view.entries.map((e) => e.modelChange)).toEqual([undefined, 'opus → sonnet', undefined, undefined])
    expect(view).toMatchObject({ taskId: 'beta-build', title: 'g', project: 'demo', model: 'claude-sonnet-5-5', effort: 'high' })
  })

  test('two models of one family are named by id; an unknown model by its id', () => {
    const task: Task = {
      id: 't',
      timeline: [
        { ts: '2026-01-16T09:00:00Z', kind: 'dispatched', text: 'x', model: 'claude-opus-5' },
        { ts: '2026-01-16T10:00:00Z', kind: 'forked', text: 'x', model: 'claude-opus-5-5' },
        { ts: '2026-01-16T11:00:00Z', kind: 'resumed', text: 'x', model: 'mystery-1' },
      ],
    }
    expect(timelineView(task).entries.map((e) => e.modelChange)).toEqual([undefined, 'claude-opus-5 → claude-opus-5-5', 'opus → mystery-1'])
  })

  test('the pr is carried', () => {
    expect(timelineView({ id: 't', timeline: [], pr: 12 }).pr).toBe(12)
  })
})

describe('defaultTaskId', () => {
  const tasks: Record<string, Task> = {
    old: { id: 'old', phase: 'building', timeline: [], lastActivity: '2026-01-16T08:00:00.000Z' },
    fresh: { id: 'fresh', phase: 'planning', timeline: [], lastActivity: '2026-01-16T09:00:00.000Z' },
    done: { id: 'done', phase: 'done', timeline: [], lastActivity: '2026-01-16T09:59:00.000Z' },
  }
  test('the selected agent\'s task, else the newest that is not done, else none', () => {
    const w0 = world([meta(A1)], { tasks })
    const w = { ...w0, agents: { ...w0.agents, [A1]: { ...w0.agents[A1]!, taskId: 'old' } } }
    expect(defaultTaskId(w, A1)).toBe('old')
    expect(defaultTaskId(w, undefined)).toBe('fresh')
    expect(defaultTaskId(w, 'unknown-agent')).toBe('fresh')
    expect(defaultTaskId(world([], { tasks: { done: tasks.done as Task } }))).toBeUndefined()
    expect(defaultTaskId(world())).toBeUndefined()
  })
  test('a tie goes to the smaller id', () => {
    const at = '2026-01-16T09:00:00.000Z'
    const w = world([], { tasks: { b: { id: 'b', timeline: [], lastActivity: at }, a: { id: 'a', timeline: [], lastActivity: at } } })
    expect(defaultTaskId(w)).toBe('a')
  })
})

describe('LEGEND', () => {
  test('every model family and the five roles with their accessories', () => {
    expect(LEGEND.models.map((m) => m.family)).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'other'])
    expect(LEGEND.roles).toEqual([
      { role: 'orchestrator', accessory: 'tie' },
      { role: 'planner', accessory: 'clipboard' },
      { role: 'reviewer', accessory: 'magnifier' },
      { role: 'builder', accessory: 'headphones' },
      { role: 'explorer', accessory: 'cap' },
    ])
  })
})
