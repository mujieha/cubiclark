// Folding an adapter snapshot into the World: tasks, links, roles, `claude agents` and quota.

import { describe, expect, test } from 'vitest'
import { applyAdapters, tasksAt } from '../src/core/adapters/apply.js'
import type { AdapterSnapshot } from '../src/core/adapters/types.js'
import { layout } from '../src/core/office/layout.js'
import { reduce } from '../src/core/reducer.js'
import type { Agent, AgentEvent, Task, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'
import { Store } from '../src/server/store.js'

const T0 = '2026-01-16T10:00:00.000Z'
const T0_MS = Date.parse(T0)
const NOW = Date.parse('2026-01-16T10:10:00Z')
const REAL: { replay: boolean } = { replay: false }
const A1 = '00000000-0000-4000-8000-000000000001'
const A2 = '00000000-0000-4000-8000-000000000002'
const A3 = '00000000-0000-4000-8000-000000000003'
const CLI_AT = '2026-01-16T10:05:00.000Z'

function world(...agents: { id: string; cwd?: string; kind?: Agent['kind']; parentId?: string }[]): World {
  let w = emptyWorld(T0, '/root')
  for (const a of agents) {
    w = reduce(w, { t: 'agent_meta', ts: T0, agentId: a.id, kind: a.kind ?? 'session', cwd: a.cwd ?? '/home/user/projects/demo', parentId: a.parentId })
  }
  return w
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, timeline: [], ...patch }
}

const snap = (patch: Partial<AdapterSnapshot> = {}): AdapterSnapshot => ({ ...patch, diagnostics: { unparsed: 0, errors: [] } })

describe('tasks', () => {
  test('the snapshot\'s tasks are keyed by id; no snapshot, or none for tasks, leaves the World alone', () => {
    const w = world({ id: A1 })
    expect(applyAdapters(w, undefined, NOW, REAL)).toBe(w)
    expect(applyAdapters(w, snap(), NOW, REAL).tasks).toEqual({})
    const withTasks = applyAdapters(w, snap({ tasks: [task('t1'), task('t2')] }), NOW, REAL)
    expect(Object.keys(withTasks.tasks)).toEqual(['t1', 't2'])
    expect(applyAdapters(withTasks, snap(), NOW, REAL).tasks).toBe(withTasks.tasks)
    expect(applyAdapters(withTasks, snap({ tasks: [] }), NOW, REAL).tasks).toEqual({})
  })
})

describe('links', () => {
  const tasks = [task('t1', { phase: 'building', lastActivity: '2026-01-16T09:00:00.000Z' }), task('t2', { phase: 'planning', lastActivity: '2026-01-16T09:30:00.000Z' })]

  test('taskId, and effort and model only where the agent has none', () => {
    let w = world({ id: A1 }, { id: A2 })
    w = reduce(w, { t: 'assistant', ts: T0, agentId: A2, model: 'claude-haiku-4-5', thinking: false, text: true })
    const out = applyAdapters(w, snap({ tasks, links: [{ agentId: A1, taskId: 't1', effort: 'high', model: 'claude-opus-5-5' }, { agentId: A2, taskId: 't1', model: 'claude-opus-5-5' }] }), NOW, REAL)
    expect(out.agents[A1]).toMatchObject({ taskId: 't1', effort: 'high', model: 'claude-opus-5-5' })
    expect(out.agents[A2]).toMatchObject({ taskId: 't1', model: 'claude-haiku-4-5' }) // the transcript wins
    expect(out.agents[A2]?.effort).toBeUndefined()
  })

  test('a link to an agent or a task that is not there does nothing', () => {
    const w = world({ id: A1 })
    const out = applyAdapters(w, snap({ tasks, links: [{ agentId: A2, taskId: 't1' }, { agentId: A1, taskId: 'nope' }] }), NOW, REAL)
    expect(out.agents[A1]?.taskId).toBeUndefined()
    expect(out.agents[A2]).toBeUndefined()
  })

  test('with several links for one agent, the task with the newest activity wins', () => {
    const out = applyAdapters(world({ id: A1 }), snap({ tasks, links: [{ agentId: A1, taskId: 't2' }, { agentId: A1, taskId: 't1' }] }), NOW, REAL)
    expect(out.agents[A1]?.taskId).toBe('t2')
  })

  test('roles: replaced when undefined, builder, planner or reviewer; never an orchestrator or explorer', () => {
    let w = world({ id: A1 }, { id: A2, kind: 'subagent', parentId: A1 })
    w = reduce(w, { t: 'subagent_link', ts: T0, agentId: A2, parentId: A1, agentType: 'Explore' })
    const links = [{ agentId: A1, taskId: 't2', role: 'planner' as const }, { agentId: A2, taskId: 't2', role: 'planner' as const }]
    const out = applyAdapters(w, snap({ tasks, links }), NOW, REAL)
    expect(out.agents[A1]?.role).toBe('planner')
    expect(out.agents[A2]?.role).toBe('explorer')

    const building = applyAdapters(out, snap({ tasks, links: [{ agentId: A1, taskId: 't1', role: 'builder' }] }), NOW, REAL)
    expect(building.agents[A1]?.role).toBe('builder')

    const orchestrator = applyAdapters(building, snap({ tasks, orchestratorCwds: ['/home/user/projects/demo'] }), NOW, REAL)
    expect(orchestrator.agents[A1]?.role).toBe('orchestrator')
    expect(applyAdapters(orchestrator, snap({ tasks, links: [{ agentId: A1, taskId: 't1', role: 'planner' }] }), NOW, REAL).agents[A1]?.role).toBe('orchestrator')
  })

  test('the planning room fills from task phases', () => {
    const w = world({ id: A1 }, { id: A2 })
    const out = applyAdapters(w, snap({ tasks, links: [{ agentId: A1, taskId: 't2', role: 'planner' }, { agentId: A2, taskId: 't1', role: 'builder' }] }), NOW, REAL)
    const room = (agentId: string): string | undefined => layout(out).placements.find((p) => p.agentId === agentId)?.room
    expect(room(A1)).toBe('planning')
    expect(room(A2)).toBe('floor')
  })
})

describe('the orchestrator is found by its working directory', () => {
  test('a top-level session or background worker there; trailing slashes ignored; not a helper or a child', () => {
    const w = world(
      { id: A1, cwd: '/home/user/hq/' },
      { id: A2, cwd: '/home/user/hq', kind: 'background' },
      { id: A3, cwd: '/home/user/hq', kind: 'subagent', parentId: A1 }
    )
    const out = applyAdapters(w, snap({ orchestratorCwds: ['/home/user/hq'] }), NOW, REAL)
    expect(out.agents[A1]?.role).toBe('orchestrator')
    expect(out.agents[A2]?.role).toBe('orchestrator')
    expect(out.agents[A3]?.role).toBeUndefined()
    expect(applyAdapters(world({ id: A1, cwd: '/home/user/elsewhere' }), snap({ orchestratorCwds: ['/home/user/hq'] }), NOW, REAL).agents[A1]?.role).toBeUndefined()
  })
})

describe('claude agents', () => {
  const cli = (patch: Partial<NonNullable<AdapterSnapshot['cliSessions']>[number]> = {}): AdapterSnapshot =>
    snap({ cliFetchedAt: CLI_AT, cliSessions: [{ sessionId: A1, kind: 'background', state: 'working', status: 'busy', name: 'demo-worker', ...patch }] })

  test('its answer is kept on the agent; a session that is a plain one becomes background; the name is a label', () => {
    const out = applyAdapters(world({ id: A1 }, { id: A2 }), cli(), NOW, REAL)
    expect(out.agents[A1]).toMatchObject({ kind: 'background', label: 'demo-worker', cli: { kind: 'background', state: 'working', status: 'busy', name: 'demo-worker', fetchedAt: CLI_AT } })
    expect(out.agents[A2]?.cli).toBeUndefined()
    expect(JSON.stringify(out.agents[A1]?.cli)).not.toContain('/home/user') // the CLI's cwd is not copied
  })

  test('an existing label is kept; a session that leaves the list forgets what it said', () => {
    let w = world({ id: A1 })
    w = reduce(w, { t: 'agent_meta', ts: T0, agentId: A1, label: 'mine' })
    const out = applyAdapters(w, cli(), NOW, REAL)
    expect(out.agents[A1]?.label).toBe('mine')
    const later = applyAdapters(out, snap({ cliFetchedAt: '2026-01-16T10:06:00.000Z', cliSessions: [] }), NOW, REAL)
    expect(later.agents[A1]?.cli).toBeUndefined()
  })

  const waiting = (): AdapterSnapshot => cli({ status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' })

  test('a permission prompt it reports makes the agent wait, observed', () => {
    const out = applyAdapters(world({ id: A1 }), waiting(), NOW, REAL)
    expect(out.agents[A1]).toMatchObject({ state: 'waiting_permission', stateEvidence: 'observed', stateSince: CLI_AT })
  })

  test('only once per fetch: a later event is not overridden by the same stale answer', () => {
    let w = applyAdapters(world({ id: A1 }), waiting(), NOW, REAL)
    const prompt: AgentEvent = { t: 'prompt', ts: '2026-01-16T10:07:00.000Z', agentId: A1 }
    w = reduce(w, prompt)
    expect(w.agents[A1]?.state).toBe('thinking')
    expect(applyAdapters(w, waiting(), NOW, REAL).agents[A1]?.state).toBe('thinking')
  })

  test('a fetch that is not newer than the agent\'s last activity does not', () => {
    const w = reduce(world({ id: A1 }), { t: 'prompt', ts: '2026-01-16T10:06:00.000Z', agentId: A1 })
    expect(applyAdapters(w, waiting(), NOW, REAL).agents[A1]?.state).toBe('thinking')
  })

  test('a hooked agent is left to its hooks; a finished one stays finished; a different wait is not a permission wait', () => {
    let hooked = world({ id: A1 })
    hooked = reduce(hooked, { t: 'hook_seen', ts: T0, agentId: A1, tools: true })
    expect(applyAdapters(hooked, waiting(), NOW, REAL).agents[A1]?.state).not.toBe('waiting_permission')

    let done = world({ id: A1 })
    done = reduce(done, { t: 'session_end', ts: T0, agentId: A1 })
    expect(applyAdapters(done, waiting(), NOW, REAL).agents[A1]?.state).toBe('ended')

    const input = cli({ status: 'waiting', waitingFor: 'input needed' })
    expect(applyAdapters(world({ id: A1 }), input, NOW, REAL).agents[A1]?.state).not.toBe('waiting_permission')
  })
})

describe('quota', () => {
  const samples = [{ ts: '2026-01-16T10:00:00.000Z', p5h: 62, p7d: 40, resets5h: '2026-01-16T11:00:00.000Z', resets7d: '2026-01-19T04:00:00.000Z' }]

  test('the quota at the clock, and a reset past the clock reads 0', () => {
    const w = world({ id: A1 })
    expect(applyAdapters(w, snap({ quotaSamples: samples }), NOW, REAL).quota).toMatchObject({ p5h: 62, p7d: 40 })
    expect(applyAdapters(w, snap({ quotaSamples: samples }), Date.parse('2026-01-16T11:30:00Z'), REAL).quota).toMatchObject({ p5h: 0, p7d: 40 })
  })

  test('no samples key leaves the quota alone; none at or before the clock removes it', () => {
    const w = applyAdapters(world({ id: A1 }), snap({ quotaSamples: samples }), NOW, REAL)
    expect(applyAdapters(w, snap(), NOW, REAL).quota).toBeDefined()
    expect(applyAdapters(w, snap({ quotaSamples: samples }), T0_MS - 3_600_000, REAL).quota).toBeUndefined()
    expect(applyAdapters(w, snap({ quotaSamples: [] }), NOW, REAL).quota).toBeUndefined()
  })

  test('through the store: a tick past the reset zeroes the 5 h window without a new snapshot', () => {
    let now = NOW
    const store = new Store({ nowMs: () => now, transcriptsRoot: '/root', throttleMs: 1_000_000 })
    store.setAdapterSnapshot(snap({ quotaSamples: samples }))
    expect(store.getWorld().quota).toMatchObject({ p5h: 62 })
    now = Date.parse('2026-01-16T11:01:00Z')
    store.tickNow()
    expect(store.getWorld().quota).toMatchObject({ p5h: 0, p7d: 40 })
    store.stop()
  })
})

describe('tasksAt: a task as it was at a moment', () => {
  const entry = (time: string, kind: Task['timeline'][number]['kind'], model?: string) => ({
    ts: `2026-01-16T${time}:00.000Z`,
    kind,
    text: kind,
    ...(model ? { model } : {}),
  })
  const full: Task = task('t', {
    phase: 'review',
    planModel: 'opus',
    model: 'sonnet',
    pr: 7,
    lastActivity: '2026-01-16T15:00:00.000Z',
    timeline: [entry('09:00', 'dispatched', 'opus'), entry('10:00', 'planned'), entry('11:00', 'forked', 'sonnet'), entry('12:00', 'paused'), entry('15:00', 'pr')],
  })
  const at = (time: string): Task[] => tasksAt([full], Date.parse(`2026-01-16T${time}:00Z`))

  test('before its first entry the task does not exist', () => {
    expect(at('08:59')).toEqual([])
  })
  test('a dispatch with the plan model is planning; a plan written is planning', () => {
    expect(at('09:30')[0]).toMatchObject({ phase: 'planning', model: 'opus', lastActivity: '2026-01-16T09:00:00.000Z' })
    expect(at('10:30')[0]?.phase).toBe('planning')
  })
  test('after a fork to another model it is building; a pause keeps what was running', () => {
    expect(at('11:30')[0]).toMatchObject({ phase: 'building', model: 'sonnet' })
    expect(at('12:30')[0]).toMatchObject({ phase: 'building', model: 'sonnet' })
  })
  test('the PR appears with its entry; before it there is no pr', () => {
    expect(at('14:00')[0]?.pr).toBeUndefined()
    expect(at('15:00')[0]).toMatchObject({ phase: 'review', pr: 7 })
  })
  test('the whole task, unchanged, once the clock is past everything', () => {
    expect(tasksAt([full], Date.parse('2026-01-17T00:00:00Z'))[0]).toBe(full)
  })
  test('done and blocked entries decide the phase', () => {
    const t = task('t', { timeline: [entry('09:00', 'dispatched', 'x'), entry('10:00', 'blocked'), entry('11:00', 'done')] })
    expect(tasksAt([t], Date.parse('2026-01-16T10:30:00Z'))[0]?.phase).toBe('blocked')
    expect(tasksAt([t], Date.parse('2026-01-16T11:30:00Z'))[0]).toBe(t)
    const cut = tasksAt([task('t', { timeline: [entry('09:00', 'dispatched', 'x'), entry('11:00', 'done')] })], Date.parse('2026-01-16T09:30:00Z'))[0]
    expect(cut?.phase).toBe('building')
  })
  test('in replay mode applyAdapters cuts the tasks at the clock', () => {
    const w = applyAdapters(world({ id: A1 }), snap({ tasks: [full] }), Date.parse('2026-01-16T09:30:00Z'), { replay: true })
    expect(w.tasks.t?.phase).toBe('planning')
    expect(applyAdapters(world({ id: A1 }), snap({ tasks: [full] }), Date.parse('2026-01-16T09:30:00Z'), { replay: false }).tasks.t?.phase).toBe('review')
  })
})

describe('idempotence', () => {
  test('applying the same snapshot twice equals applying it once', () => {
    const w = world({ id: A1, cwd: '/home/user/hq' }, { id: A2 }, { id: A3 })
    const snapshot = snap({
      tasks: [task('t1', { phase: 'building', lastActivity: '2026-01-16T09:00:00.000Z' })],
      links: [{ agentId: A2, taskId: 't1', role: 'builder', effort: 'high' }],
      orchestratorCwds: ['/home/user/hq'],
      quotaSamples: [{ ts: '2026-01-16T10:00:00.000Z', p5h: 10, p7d: 20 }],
      cliFetchedAt: CLI_AT,
      cliSessions: [
        { sessionId: A2, kind: 'background', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' },
        { sessionId: A3, kind: 'interactive', status: 'idle' },
      ],
    })
    const once = applyAdapters(w, snapshot, NOW, REAL)
    expect(applyAdapters(once, snapshot, NOW, REAL)).toEqual(once)
    expect(once.agents[A2]?.state).toBe('waiting_permission')
    expect(once.agents[A1]?.role).toBe('orchestrator')
  })
})
