// The task-folders adapter over a copy of the fixture tree (test/fixtures/tasks/, generated from
// the documented format). STATUS.md mtimes are set by the tests: a checkout's are arbitrary.

import { appendFile, chmod, cp, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TASK_SESSIONS } from '../scripts/task-fixture-lib.js'
import { TaskFoldersAdapter } from '../src/server/adapters/task-folders.js'
import type { AdapterEnv } from '../src/core/adapters/types.js'
import type { Task } from '../src/core/types.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/tasks', import.meta.url))
const NOW = Date.parse('2026-01-15T18:00:00Z')
const STATUS_AT = new Date('2026-01-15T16:00:00Z')
const env: AdapterEnv = { nowMs: () => NOW, home: '/home/user' }

let root: string

async function stamp(mtimes: Record<string, Date> = {}): Promise<void> {
  for (const name of ['beta-build', 'gamma-review', 'delta-done', 'epsilon-blocked', 'zeta-noisy', 'eta-redispatched']) {
    await utimes(join(root, name, 'STATUS.md'), STATUS_AT, mtimes[name] ?? STATUS_AT)
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubiclark-tasks-'))
  await cp(FIXTURE, root, { recursive: true })
  await stamp({ 'delta-done': new Date('2026-01-15T13:00:00Z') })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function adapter(overrides: { windowHours?: number | null } = {}): TaskFoldersAdapter {
  return new TaskFoldersAdapter({ roots: [root], orchestratorCwds: ['/home/user/projects/hq'], windowHours: overrides.windowHours ?? null }, env)
}

function byId(tasks: Task[] | undefined): Record<string, Task> {
  return Object.fromEntries((tasks ?? []).map((task) => [task.id, task]))
}

describe('the fixture tree becomes tasks with the right phases, timelines and model changes', () => {
  test('seven tasks; README.md and not-a-task/ are ignored', async () => {
    const snap = await adapter().snapshot()
    expect(Object.keys(byId(snap.tasks)).sort()).toEqual([
      'alpha-plan',
      'beta-build',
      'delta-done',
      'epsilon-blocked',
      'eta-redispatched',
      'gamma-review',
      'zeta-noisy',
    ])
    expect(snap.orchestratorCwds).toEqual(['/home/user/projects/hq'])
  })

  test('phases', async () => {
    const tasks = byId((await adapter().snapshot()).tasks)
    expect(Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, task.phase]))).toEqual({
      'alpha-plan': 'planning',
      'beta-build': 'building',
      'gamma-review': 'review',
      'delta-done': 'done',
      'epsilon-blocked': 'blocked',
      'zeta-noisy': 'planning',
      'eta-redispatched': 'building',
    })
  })

  test('alpha-plan: one dispatch with the plan model', async () => {
    const task = byId((await adapter().snapshot()).tasks)['alpha-plan'] as Task
    expect(task.timeline.map((e) => [e.kind, e.model])).toEqual([['dispatched', 'claude-opus-5-5']])
    expect(task.model).toBe('claude-opus-5-5')
    expect(task.currentSessionId).toBe(TASK_SESSIONS.alpha)
  })

  test('beta-build: four entries, a model change opus -> sonnet, the fork is the current session', async () => {
    const task = byId((await adapter().snapshot()).tasks)['beta-build'] as Task
    expect(task.timeline.map((e) => e.kind)).toEqual(['dispatched', 'forked', 'paused', 'resumed'])
    expect(task.timeline.map((e) => e.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', undefined, 'claude-sonnet-5-5'])
    expect(task.timeline[1]?.text).toBe('forked after 1 compaction plan reviewed')
    expect(task.timeline[2]?.text).toBe('paused at weekly 95%; resume after Sat 17 Jan 04:00')
    expect(task.sessionIds).toEqual([TASK_SESSIONS.betaFirst, TASK_SESSIONS.betaFork])
    expect(task.currentSessionId).toBe(TASK_SESSIONS.betaFork)
    expect(task.model).toBe('claude-sonnet-5-5')
    expect(task.effort).toBe('high')
    expect(task.project).toBe('demo')
  })

  test('gamma-review: PR 12', async () => {
    const task = byId((await adapter().snapshot()).tasks)['gamma-review'] as Task
    expect(task.pr).toBe(12)
    expect(task.timeline.map((e) => [e.kind, e.text])).toEqual([
      ['dispatched', 'dispatched in demo (bypassPermissions)'],
      ['pr', 'PR #12'],
    ])
    expect(task.timeline[1]?.ts).toBe('2026-01-15T16:00:00.000Z')
  })

  test('delta-done: verified after the PR line', async () => {
    const task = byId((await adapter().snapshot()).tasks)['delta-done'] as Task
    expect(task.timeline.map((e) => e.kind)).toEqual(['dispatched', 'pr', 'done'])
  })

  test('epsilon-blocked: a blocked entry and no sessions', async () => {
    const task = byId((await adapter().snapshot()).tasks)['epsilon-blocked'] as Task
    expect(task.timeline.map((e) => e.kind)).toEqual(['blocked'])
    expect(task.sessionIds).toBeUndefined()
  })

  test('zeta-noisy: one unparsed line, the unknown verb as a note, no path in any text', async () => {
    const snap = await adapter().snapshot()
    const task = byId(snap.tasks)['zeta-noisy'] as Task
    expect(snap.diagnostics.unparsed).toBe(1)
    expect(task.timeline.map((e) => e.kind)).toEqual(['dispatched', 'note', 'note', 'planned'])
    expect(task.timeline.map((e) => e.text)).toEqual([
      'dispatched in shop (bypassPermissions)',
      'rerouted the plan',
      'DECISION: split the work in two',
      'plan written',
    ])
    expect(JSON.stringify(snap.tasks)).not.toContain('/home/')
  })

  test('eta-redispatched: building again after a verification', async () => {
    const task = byId((await adapter().snapshot()).tasks)['eta-redispatched'] as Task
    expect(task.timeline.map((e) => e.kind)).toEqual(['dispatched', 'done', 'dispatched'])
    expect(task.phase).toBe('building')
  })

  test('links carry the phase roles, the efforts and the models', async () => {
    const snap = await adapter().snapshot()
    const link = (agentId: string) => snap.links?.find((l) => l.agentId === agentId)
    expect(link(TASK_SESSIONS.alpha)).toEqual({ agentId: TASK_SESSIONS.alpha, taskId: 'alpha-plan', role: 'planner', effort: 'high', model: 'claude-opus-5-5' })
    expect(link(TASK_SESSIONS.betaFork)).toMatchObject({ taskId: 'beta-build', role: 'builder', model: 'claude-sonnet-5-5' })
    expect(link(TASK_SESSIONS.gamma)).toMatchObject({ taskId: 'gamma-review', role: 'reviewer' })
    expect(link(TASK_SESSIONS.delta)?.role).toBeUndefined()
  })
})

describe('reading', () => {
  test('a second snapshot re-reads nothing; touching one LOG.md re-reads only that file', async () => {
    const a = adapter()
    await a.snapshot()
    const first = a.readCount
    expect(first).toBeGreaterThan(20)
    await a.snapshot()
    expect(a.readCount).toBe(first)

    await appendFile(join(root, 'beta-build', 'LOG.md'), `2026-01-15T12:00:00Z paused again\n`)
    const snap = await a.snapshot()
    expect(a.readCount).toBe(first + 1)
    expect(byId(snap.tasks)['beta-build']?.timeline.map((e) => e.kind)).toEqual(['dispatched', 'forked', 'paused', 'resumed', 'paused'])
  })

  test('a STATUS.md entry is dated by its mtime clamped to wall time, not to the clock the World runs on', async () => {
    // a replay: the World's clock is early in the day, wall time is the end of it
    const replayEnv: AdapterEnv = { nowMs: () => Date.parse('2026-01-15T09:00:00Z'), wallMs: () => Date.parse('2026-01-15T18:00:00Z'), home: '/home/user' }
    const a = new TaskFoldersAdapter({ roots: [root], orchestratorCwds: [], windowHours: null }, replayEnv)
    const task = byId((await a.snapshot()).tasks)['gamma-review'] as Task
    expect(task.timeline.find((e) => e.kind === 'pr')?.ts).toBe('2026-01-15T16:00:00.000Z')
    // without wallMs the clamp is the World's clock, as before
    const plain = new TaskFoldersAdapter({ roots: [root], orchestratorCwds: [], windowHours: null }, { nowMs: () => Date.parse('2026-01-15T09:00:00Z'), home: '/home/user' })
    const clamped = byId((await plain.snapshot()).tasks)['gamma-review'] as Task
    expect(clamped.timeline.find((e) => e.kind === 'pr')?.ts).toBe('2026-01-15T09:00:00.000Z')
  })

  test('the time window keeps only recent tasks', async () => {
    const lateEnv: AdapterEnv = { nowMs: () => NOW + 24 * 3_600_000, home: '/home/user' }
    const a = new TaskFoldersAdapter({ roots: [root], orchestratorCwds: [], windowHours: 1 }, lateEnv)
    expect((await a.snapshot()).tasks).toEqual([])
    const b = new TaskFoldersAdapter({ roots: [root], orchestratorCwds: [], windowHours: 48 }, lateEnv)
    expect((await b.snapshot()).tasks).toHaveLength(7)
  })

  test('an unreadable LOG.md is an error naming the task and file; the other tasks stay', async () => {
    await chmod(join(root, 'beta-build', 'LOG.md'), 0)
    const snap = await adapter().snapshot()
    expect(snap.diagnostics.errors).toEqual(['cannot read beta-build/LOG.md: EACCES'])
    expect(snap.tasks).toHaveLength(7)
    expect(byId(snap.tasks)['alpha-plan']).toBeDefined()
    expect(JSON.stringify(snap.diagnostics)).not.toContain(root)
    await chmod(join(root, 'beta-build', 'LOG.md'), 0o644)
  })

  test('a task appears when its TASK.md is created; a removed task disappears', async () => {
    const a = adapter()
    await a.snapshot()
    await writeFile(join(root, 'not-a-task', 'TASK.md'), '# new\nGoal: a new one\n')
    expect(byId((await a.snapshot()).tasks)['not-a-task']?.title).toBe('a new one')
    await rm(join(root, 'alpha-plan'), { recursive: true })
    expect(byId((await a.snapshot()).tasks)['alpha-plan']).toBeUndefined()
  })
})

describe('detect and watch', () => {
  test('detect is true for a readable root and false for none', async () => {
    expect(await adapter().detect()).toBe(true)
    expect(await new TaskFoldersAdapter({ roots: [join(root, 'nowhere')], orchestratorCwds: [], windowHours: null }, env).detect()).toBe(false)
  })

  test('watch never throws, on a missing root too, and its unsubscribe is safe to call twice', async () => {
    // fs.watch is only a speed-up (the poll is the fallback) and is not deterministic in tests:
    // what is asserted is that it neither throws nor keeps the process alive after unsubscribing.
    const a = adapter()
    const stop = a.watch(() => undefined)
    await appendFile(join(root, 'alpha-plan', 'LOG.md'), `2026-01-15T11:00:00Z resumed ${TASK_SESSIONS.alpha}\n`)
    stop()
    expect(() => stop()).not.toThrow()
    const missing = new TaskFoldersAdapter({ roots: [join(root, 'nowhere')], orchestratorCwds: [], windowHours: null }, env)
    const stopMissing = missing.watch(() => undefined)
    expect(() => stopMissing()).not.toThrow()
  })
})

// S1-10 and S1-16: files are read in bounded pieces, and only regular files are read at all.
describe('limits on what a task folder can make the adapter read', () => {
  test('a 6 MB LOG.md is read from its tail and the snapshot stays fast and small', async () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const text = ids.map((id) => `2026-01-15T10:00:00Z resumed ${id}`).join('\n') + '\n'
    expect(text.length).toBeGreaterThan(5_000_000)
    await writeFile(join(root, 'alpha-plan', 'LOG.md'), text)
    const started = Date.now()
    const snap = await adapter().snapshot()
    expect(Date.now() - started).toBeLessThan(2000)
    const task = byId(snap.tasks)['alpha-plan'] as Task
    expect(task.sessionIds?.length).toBeLessThanOrEqual(50)
    expect(task.sessionIds).toContain(ids[ids.length - 1])
    expect(JSON.stringify(snap.links).length).toBeLessThan(20_000)
    // the cut first line of the tail is not counted as an unparsed line of its own
    expect(snap.diagnostics.unparsed).toBe(1) // zeta-noisy's one, unchanged
  })

  test('TASK.md and STATUS.md are read only up to 64 KiB', async () => {
    await writeFile(join(root, 'alpha-plan', 'TASK.md'), `# alpha-plan\nGoal: short\n${'x'.repeat(200_000)}\nModel: claude-late-model\n`)
    const task = byId((await adapter().snapshot()).tasks)['alpha-plan'] as Task
    expect(task.title).toBe('short')
    expect(task.model).not.toBe('claude-late-model')
  })

  test('a symlinked TASK.md or LOG.md is not followed (S1-16)', async () => {
    await writeFile(join(root, 'secret.md'), '# secret heading\nGoal: leaked goal\n')
    await rm(join(root, 'alpha-plan', 'TASK.md'))
    await symlink(join(root, 'secret.md'), join(root, 'alpha-plan', 'TASK.md'))
    const snap = await adapter().snapshot()
    expect(byId(snap.tasks)['alpha-plan']).toBeUndefined() // no TASK.md that is a file: not a task
    expect(JSON.stringify(snap)).not.toContain('leaked goal')

    await writeFile(join(root, 'secret-log.md'), `2026-01-15T10:00:00Z dispatched session ${TASK_SESSIONS.alpha} in demo\n`)
    await rm(join(root, 'beta-build', 'LOG.md'))
    await symlink(join(root, 'secret-log.md'), join(root, 'beta-build', 'LOG.md'))
    const again = byId((await adapter().snapshot()).tasks)['beta-build'] as Task
    expect(again.timeline.some((entry) => entry.text.includes('demo'))).toBe(false)
  })
})
