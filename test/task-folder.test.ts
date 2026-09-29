// TASK.md / STATUS.md parsing, the phase rules and the timeline, from strings written by hand
// from the documented format (never from a real task folder).

import { describe, expect, test } from 'vitest'
import { buildTask, MAX_TIMELINE_ENTRIES, parseStatusMd, parseTaskMd, taskLinks, taskPhase } from '../src/core/adapters/task-folder.js'
import type { TaskTimelineEntry } from '../src/core/types.js'

const S1 = '00000000-0000-4000-8000-000000000001'
const S2 = '00000000-0000-4000-8000-000000000002'
const NOW = Date.parse('2026-01-15T18:00:00Z')

const TASK_MD = [
  '# demo-login',
  'Goal: make the login form reject empty passwords in /home/user/projects/demo with an inline error.',
  'Project: /home/user/projects/demo',
  'Scope: Sources/Login',
  'Model: claude-sonnet-5-5',
  'PlanModel: claude-opus-5-5',
  'Effort: high',
  '',
  '## Operator\'s view',
  '- Goal: not this one',
].join('\n')

describe('parseTaskMd', () => {
  test('goal, project (basename), model, plan model and effort', () => {
    expect(parseTaskMd(TASK_MD)).toEqual({
      heading: 'demo-login',
      goal: 'make the login form reject empty passwords in demo with an inline error.',
      project: 'demo',
      model: 'claude-sonnet-5-5',
      planModel: 'claude-opus-5-5',
      effort: 'high',
    })
  })
  test('a file with none of them is empty; CRLF is tolerated; the first key line wins', () => {
    expect(parseTaskMd('just text')).toEqual({})
    expect(parseTaskMd('Goal: one\r\nGoal: two\r\n').goal).toBe('one')
  })
  test('"Project dir:" is accepted when there is no "Project:"', () => {
    expect(parseTaskMd('Project dir: /home/user/projects/shop').project).toBe('shop')
  })
})

describe('parseStatusMd', () => {
  test('the state is read from the first non-blank line', () => {
    expect(parseStatusMd('state: planned\n\nrest').state).toBe('planned')
    expect(parseStatusMd('\n\nState: In_Progress').state).toBe('in_progress')
    expect(parseStatusMd('state: done').state).toBe('done')
    expect(parseStatusMd('state: blocked').state).toBe('blocked')
    expect(parseStatusMd('state: weird').state).toBe('other')
    expect(parseStatusMd('no state line').state).toBeUndefined()
    expect(parseStatusMd('summary\nstate: done').state).toBeUndefined()
  })
  test('a PR number, in each spelling', () => {
    expect(parseStatusMd('state: done\nPR #12 is open').pr).toBe(12)
    expect(parseStatusMd('state: done\nhttps://github.com/x/y/pull/34').pr).toBe(34)
    expect(parseStatusMd('state: done\nOpened pull request #56').pr).toBe(56)
    expect(parseStatusMd('state: done\nno mention').pr).toBeUndefined()
  })
})

const at = (time: string, kind: TaskTimelineEntry['kind'], model?: string): TaskTimelineEntry => ({
  ts: `2026-01-15T${time}:00Z`,
  kind,
  text: kind,
  ...(model ? { model } : {}),
})

describe('taskPhase: first match wins', () => {
  test('1. a verified line newer than every start is done, even over blocked', () => {
    const entries = [at('10:00', 'dispatched'), at('12:00', 'done')]
    expect(taskPhase({ status: { state: 'in_progress' }, entries })).toBe('done')
    expect(taskPhase({ status: { state: 'blocked' }, entries })).toBe('done')
    expect(taskPhase({ entries: [at('12:00', 'done')] })).toBe('done')
  })
  test('1b. a dispatch newer than the verified line reopens the task', () => {
    const entries = [at('10:00', 'dispatched'), at('12:00', 'done'), at('13:00', 'dispatched')]
    expect(taskPhase({ status: { state: 'in_progress' }, entries })).toBe('building')
    expect(taskPhase({ entries: [...entries.slice(0, 2), at('13:00', 'forked')] })).toBe('building')
  })
  test('2. blocked', () => {
    expect(taskPhase({ status: { state: 'blocked' }, entries: [at('10:00', 'dispatched')] })).toBe('blocked')
  })
  test('3. planned is planning', () => {
    expect(taskPhase({ status: { state: 'planned' }, entries: [] })).toBe('planning')
  })
  test('4. in_progress is building', () => {
    expect(taskPhase({ status: { state: 'in_progress' }, entries: [] })).toBe('building')
  })
  test('5. done without a verified line is review, with or without a PR', () => {
    expect(taskPhase({ status: { state: 'done', pr: 12 }, entries: [at('10:00', 'dispatched')] })).toBe('review')
    expect(taskPhase({ status: { state: 'done' }, entries: [at('10:00', 'dispatched')] })).toBe('review')
  })
  test('6. no STATUS.md: the newest start decides, by the plan model', () => {
    const entries = [at('10:00', 'dispatched', 'claude-opus-5-5')]
    expect(taskPhase({ entries, planModel: 'claude-opus-5-5' })).toBe('planning')
    expect(taskPhase({ entries, planModel: 'claude-sonnet-5-5' })).toBe('building')
    expect(taskPhase({ entries })).toBe('building')
    const later = [...entries, at('11:00', 'forked', 'claude-sonnet-5-5')]
    expect(taskPhase({ entries: later, planModel: 'claude-opus-5-5' })).toBe('building')
    expect(taskPhase({ status: { state: 'other' }, entries, planModel: 'claude-opus-5-5' })).toBe('planning')
  })
  test('7. nothing to go on is undefined', () => {
    expect(taskPhase({ entries: [] })).toBeUndefined()
    expect(taskPhase({ status: { state: 'other' }, entries: [at('10:00', 'note')] })).toBeUndefined()
  })
})

describe('buildTask', () => {
  const LOG = [
    `2026-01-15T10:00:00Z dispatched session ${S1} in /home/user/projects/demo model=claude-opus-5-5 effort=high perms=bypassPermissions`,
    `2026-01-15T10:20:00Z forked ${S1} -> ${S2} model=claude-sonnet-5-5 effort=medium (compactions=1)`,
    '2026-01-15T10:40:00Z paused at weekly 95%; resume after Sat 17 Jan 04:00',
  ].join('\n')

  test('a building task: timeline, sessions, current session, model and effort', () => {
    const built = buildTask({
      id: 'demo-login',
      taskMd: TASK_MD,
      statusMd: 'state: in_progress',
      statusMtimeMs: Date.parse('2026-01-15T11:00:00Z'),
      logText: LOG,
      sessionFile: `${S2}\n`,
      nowMs: NOW,
    })
    const { task } = built
    expect(task.phase).toBe('building')
    expect(task.source).toBe('task-folders')
    expect(task.title).toBe('make the login form reject empty passwords in demo with an inline error.')
    expect(task.project).toBe('demo')
    expect(task.sessionIds).toEqual([S1, S2])
    expect(task.currentSessionId).toBe(S2)
    expect(task.model).toBe('claude-sonnet-5-5')
    expect(task.planModel).toBe('claude-opus-5-5')
    expect(task.effort).toBe('medium')
    expect(task.timeline.map((e) => e.kind)).toEqual(['dispatched', 'forked', 'paused'])
    expect(task.timeline.map((e) => e.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', undefined])
    expect(task.lastActivity).toBe('2026-01-15T10:40:00Z')
    expect(built.effortBySession).toEqual({ [S1]: 'high', [S2]: 'medium' })
    expect(built.unparsedLogLines).toBe(0)
  })

  test('STATUS.md adds one entry at its mtime, capped at now', () => {
    const base = { id: 't', taskMd: TASK_MD, logText: '', nowMs: NOW }
    const planned = buildTask({ ...base, statusMd: 'state: planned', statusMtimeMs: Date.parse('2026-01-15T09:00:00Z') }).task
    expect(planned.timeline).toEqual([{ ts: '2026-01-15T09:00:00.000Z', kind: 'planned', text: 'plan written' }])
    const blocked = buildTask({ ...base, statusMd: 'state: blocked', statusMtimeMs: Date.parse('2026-01-15T09:00:00Z') }).task
    expect(blocked.timeline[0]).toMatchObject({ kind: 'blocked', text: 'blocked' })
    const review = buildTask({ ...base, statusMd: 'state: done\nPR #12 is open', statusMtimeMs: Date.parse('2026-01-15T09:00:00Z') }).task
    expect(review.timeline[0]).toMatchObject({ kind: 'pr', text: 'PR #12' })
    expect(review.pr).toBe(12)
    expect(review.phase).toBe('review')
    const done = buildTask({ ...base, statusMd: 'state: done', statusMtimeMs: Date.parse('2026-01-15T09:00:00Z') }).task
    expect(done.timeline[0]).toMatchObject({ kind: 'note', text: 'worker reports done' })
    expect(buildTask({ ...base, statusMd: 'state: in_progress', statusMtimeMs: NOW }).task.timeline).toEqual([])
    const future = buildTask({ ...base, statusMd: 'state: planned', statusMtimeMs: NOW + 3_600_000 }).task
    expect(future.timeline[0]?.ts).toBe(new Date(NOW).toISOString())
  })

  test('a done task whose log ends in a verified line is done', () => {
    const { task } = buildTask({
      id: 'demo-done',
      taskMd: TASK_MD,
      statusMd: 'state: done\nPR #3',
      statusMtimeMs: Date.parse('2026-01-15T11:00:00Z'),
      logText: `2026-01-15T10:00:00Z dispatched session ${S1} in /x/y model=m\n2026-01-15T12:00:00Z verified by orchestrator: merged PR 3`,
      nowMs: NOW,
    })
    expect(task.phase).toBe('done')
    expect(task.timeline.map((e) => e.kind)).toEqual(['dispatched', 'pr', 'done'])
  })

  test('a re-dispatch after verification is building again', () => {
    const { task } = buildTask({
      id: 'demo-again',
      taskMd: TASK_MD,
      statusMd: 'state: in_progress',
      statusMtimeMs: Date.parse('2026-01-15T14:00:00Z'),
      logText: [
        `2026-01-15T10:00:00Z dispatched session ${S1} in /x/y model=m`,
        '2026-01-15T11:00:00Z verified by orchestrator: ok',
        `2026-01-15T13:00:00Z dispatched session ${S2} in /x/y model=m`,
      ].join('\n'),
      nowMs: NOW,
    })
    expect(task.phase).toBe('building')
  })

  test('the session file wins as current session and is added when the log does not name it', () => {
    const { task } = buildTask({ id: 't', taskMd: TASK_MD, logText: `2026-01-15T10:00:00Z dispatched session ${S1} in /x/y`, sessionFile: S2, nowMs: NOW })
    expect(task.sessionIds).toEqual([S1, S2])
    expect(task.currentSessionId).toBe(S2)
    const bad = buildTask({ id: 't', taskMd: TASK_MD, logText: `2026-01-15T10:00:00Z dispatched session ${S1} in /x/y`, sessionFile: 'not an id', nowMs: NOW }).task
    expect(bad.sessionIds).toEqual([S1])
    expect(bad.currentSessionId).toBe(S1)
  })

  test('with no log, the model and effort come from TASK.md', () => {
    const { task } = buildTask({ id: 't', taskMd: TASK_MD, nowMs: NOW })
    expect(task.model).toBe('claude-sonnet-5-5')
    expect(task.effort).toBe('high')
    expect(task.phase).toBeUndefined()
    expect(task.lastActivity).toBeUndefined()
    expect(task.sessionIds).toBeUndefined()
  })

  test('equal times keep file order; more than 200 entries keep the newest', () => {
    const same = buildTask({
      id: 't',
      taskMd: TASK_MD,
      logText: '2026-01-15T10:00:00Z alpha 1\n2026-01-15T10:00:00Z beta 2\n2026-01-15T09:00:00Z gamma 3',
      nowMs: NOW,
    }).task
    expect(same.timeline.map((e) => e.text)).toEqual(['gamma 3', 'alpha 1', 'beta 2'])

    const lines = Array.from({ length: 250 }, (_, i) => `2026-01-15T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z n ${i}`)
    const capped = buildTask({ id: 't', taskMd: TASK_MD, logText: lines.join('\n'), nowMs: NOW }).task
    expect(capped.timeline).toHaveLength(MAX_TIMELINE_ENTRIES)
    expect(capped.timeline[0]?.text).toBe('n 50')
    expect(capped.timeline[MAX_TIMELINE_ENTRIES - 1]?.text).toBe('n 249')
  })

  test('no absolute path survives in the task or its entries', () => {
    const { task } = buildTask({
      id: 't',
      taskMd: TASK_MD,
      logText: `2026-01-15T10:00:00Z dispatched session ${S1} in /home/user/projects/demo\n- 2026-01-15 13:00 see /home/user/projects/shop/notes`,
      nowMs: NOW,
    })
    expect(JSON.stringify(task)).not.toContain('/home/')
  })
})

describe('taskLinks', () => {
  const LOG = [
    `2026-01-15T10:00:00Z dispatched session ${S1} in /x/y model=claude-opus-5-5 effort=high`,
    `2026-01-15T10:20:00Z forked ${S1} -> ${S2} model=claude-sonnet-5-5 effort=medium`,
  ].join('\n')

  test.each([
    ['state: planned', 'planner'],
    ['state: in_progress', 'builder'],
    ['state: done\nPR #1', 'reviewer'],
  ])('a task in %j gives its sessions the role %s', (statusMd, role) => {
    const links = taskLinks(buildTask({ id: 't', taskMd: TASK_MD, statusMd, logText: LOG, nowMs: NOW }))
    expect(links).toEqual([
      { agentId: S1, taskId: 't', role, effort: 'high', model: 'claude-opus-5-5' },
      { agentId: S2, taskId: 't', role, effort: 'medium', model: 'claude-sonnet-5-5' },
    ])
  })

  test('blocked, done and undecided tasks give no role; the task effort fills a session without one', () => {
    const noRole = taskLinks(buildTask({ id: 't', taskMd: TASK_MD, statusMd: 'state: blocked', logText: LOG, nowMs: NOW }))
    expect(noRole.every((link) => link.role === undefined)).toBe(true)
    const fromTask = taskLinks(buildTask({ id: 't', taskMd: TASK_MD, sessionFile: S1, nowMs: NOW }))
    expect(fromTask).toEqual([{ agentId: S1, taskId: 't', effort: 'high' }])
  })
})
