// A small tree of task folders, written by hand from the documented task-folder format
// (docs/adapters.md), for test/fixtures/tasks/. Every id, path and word is invented: session ids
// come from the invented UUID family, projects live under /home/user/projects, and nothing here
// was copied from a real task folder. test/personal-data.test.ts scans the result.
//
// What each folder is for (test/task-folders-adapter.test.ts checks the expected phases):
//   alpha-plan        planning   no STATUS.md; dispatched with the PlanModel
//   beta-build        building   opus -> sonnet fork, a pause and a resume; `session` = the fork
//   gamma-review      review     STATUS done with a PR
//   delta-done        done       STATUS done, then a "verified by orchestrator" line
//   epsilon-blocked   blocked    STATUS blocked, no log
//   zeta-noisy        planning   a heading, a note line, an unknown verb, one garbage line
//   eta-redispatched  building   dispatched, verified, dispatched again
//   not-a-task/       ignored    no TASK.md
//   README.md         ignored    a file at the root

import { sessionId } from './fixture-lib.js'

export const TASK_FIXTURE_DAY = '2026-01-15'

const DEMO = '/home/user/projects/demo'
const SHOP = '/home/user/projects/shop'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

/** The ids the tree uses, by task, so tests can name them. */
export const TASK_SESSIONS = {
  alpha: sessionId('1'),
  betaFirst: sessionId('2'),
  betaFork: sessionId('3'),
  gamma: sessionId('4'),
  delta: sessionId('5'),
  zeta: sessionId('6'),
  etaFirst: sessionId('7'),
  etaSecond: sessionId('8'),
} as const

function taskMd(name: string, goal: string, project: string, model = SONNET): string {
  return [
    `# ${name}`,
    `Goal: ${goal}`,
    `Project: ${project}`,
    'Scope: the repository',
    `Model: ${model}`,
    `PlanModel: ${OPUS}`,
    'Effort: high',
    '',
    "## Operator's view",
    '- State: STATUS.md.',
    '',
  ].join('\n')
}

function log(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

const dispatched = (time: string, id: string, project: string, model: string): string =>
  `${TASK_FIXTURE_DAY}T${time}Z dispatched session ${id} in ${project} model=${model} effort=high perms=bypassPermissions`

/** Epoch seconds of a moment on 2026-01-16 (the quota fixtures' day), the way the real status
 * line writes them. */
export function epochSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000)
}

/** Two days of quota samples in the writer's real shape (invented values): `ts` and the resets in
 * epoch seconds, under `limit_5h_pct`, `limit_7d_pct`, `limit_5h_resets`, `limit_7d_resets`, plus
 * the kinds of line the reader must cope with: another metric (no percentages), a line with one
 * percentage, ISO and millisecond times, a `resets` object, no reset at all, an out-of-range
 * percentage, JSON that is not an object, and text that is not JSON.
 * Expected from samples-2026-01-16.jsonl: 6 samples, 2 skipped, 2 unparsed. */
export function quotaFixtureFiles(): Map<string, string> {
  const files = new Map<string, string>()
  const WEEK_RESET = epochSeconds('2026-01-19T04:00:00Z')
  const j = (value: unknown): string => JSON.stringify(value)

  files.set(
    'samples-2026-01-15.jsonl',
    `${j({ ts: epochSeconds('2026-01-15T23:00:00Z'), limit_5h_pct: 90, limit_7d_pct: 50, limit_5h_resets: epochSeconds('2026-01-16T01:00:00Z'), limit_7d_resets: WEEK_RESET })}\n`
  )
  files.set(
    'samples-2026-01-16.jsonl',
    [
      j({ ts: epochSeconds('2026-01-16T08:00:00Z'), limit_5h_pct: 10, limit_7d_pct: 30, limit_5h_resets: epochSeconds('2026-01-16T10:00:00Z'), limit_7d_resets: WEEK_RESET }),
      j({ ts: epochSeconds('2026-01-16T08:30:00Z'), tokens_in: 1200, tokens_out: 300 }),
      j({ ts: '2026-01-16T09:00:00Z', limit_5h_pct: '25', limit_7d_pct: 31, limit_5h_resets: epochSeconds('2026-01-16T10:00:00Z'), limit_7d_resets: WEEK_RESET }),
      'this line is not json',
      j({ ts: epochSeconds('2026-01-16T09:30:00Z') * 1000, limit_5h_pct: 40, limit_7d_pct: 32, resets: { '5h': '2026-01-16T10:00:00Z', '7d': '2026-01-19T04:00:00Z' } }),
      '[1, 2]',
      j({ ts: epochSeconds('2026-01-16T10:30:00Z'), limit_5h_pct: 5 }),
      j({ ts: epochSeconds('2026-01-16T11:00:00Z'), limit_5h_pct: 8, limit_7d_pct: 33 }),
      j({ ts: epochSeconds('2026-01-16T12:00:00Z'), limit_5h_pct: 150, limit_7d_pct: -5, limit_5h_resets: epochSeconds('2026-01-16T17:00:00Z'), limit_7d_resets: WEEK_RESET }),
      j({ ts: epochSeconds('2026-01-16T17:30:00Z'), limit_5h_pct: 62, limit_7d_pct: 40, limit_5h_resets: epochSeconds('2026-01-16T19:00:00Z'), limit_7d_resets: WEEK_RESET }),
    ].join('\n') + '\n'
  )
  return files
}

/** What the stand-in `claude agents --json` prints (test/fixtures/bin/agents.json), from the
 * documented fields. Four sessions and one element that is not an object:
 *  - a background session, working and busy (the home fixture's background worker);
 *  - a background session, blocked and waiting on a permission prompt;
 *  - an interactive session, idle, with no session id and no `state`;
 *  - a background session whose `state` is not one of the documented five. */
export function agentsFixtureText(): string {
  const started = Date.parse('2026-01-16T08:00:00Z')
  const sessions: unknown[] = [
    { cwd: '/home/user/projects/demo', kind: 'background', startedAt: started, id: 'a1b2c3d4', state: 'working', pid: 4101, status: 'busy', sessionId: sessionId('2'), name: 'demo-worker' },
    { cwd: '/home/user/projects/shop', kind: 'background', startedAt: started + 60_000, id: 'e5f6a7b8', state: 'blocked', pid: 4102, status: 'waiting', waitingFor: 'permission prompt', sessionId: sessionId('5'), name: 'shop-worker' },
    { cwd: '/home/user/projects/demo', kind: 'interactive', startedAt: started + 120_000, pid: 4103, status: 'idle', name: 'interactive session' },
    { cwd: '/home/user/projects/shop', kind: 'background', startedAt: started + 180_000, id: 'c9d0e1f2', state: 'paused-ish', sessionId: sessionId('6') },
    42,
  ]
  return `${JSON.stringify(sessions, null, 2)}\n`
}

/** The tree as relative path -> file text. */
export function taskTreeFiles(): Map<string, string> {
  const files = new Map<string, string>()
  const S = TASK_SESSIONS

  files.set('README.md', '# Tasks\n\nOne folder per task.\n')
  files.set('not-a-task/notes.md', 'Some notes, and no TASK.md.\n')

  files.set('alpha-plan/TASK.md', taskMd('alpha-plan', 'draft the plan for the demo project', DEMO))
  files.set('alpha-plan/LOG.md', log(dispatched('10:00:00', S.alpha, DEMO, OPUS)))
  files.set('alpha-plan/session', `${S.alpha}\n`)

  files.set('beta-build/TASK.md', taskMd('beta-build', 'build the login form in the demo project', DEMO))
  files.set('beta-build/STATUS.md', 'state: in_progress\n\nWorking through the plan.\n')
  files.set(
    'beta-build/LOG.md',
    log(
      dispatched('09:00:00', S.betaFirst, DEMO, OPUS),
      `${TASK_FIXTURE_DAY}T09:30:00Z forked ${S.betaFirst} -> ${S.betaFork} model=${SONNET} effort=high (compactions=1) plan reviewed`,
      `${TASK_FIXTURE_DAY}T10:15:00Z paused at weekly 95%; resume after Sat 17 Jan 04:00`,
      `${TASK_FIXTURE_DAY}T11:00:00Z resumed ${S.betaFork} model=${SONNET} effort=high`
    )
  )
  files.set('beta-build/session', `${S.betaFork}\n`)

  files.set('gamma-review/TASK.md', taskMd('gamma-review', 'add search to the demo project', DEMO))
  files.set('gamma-review/STATUS.md', 'state: done\n\nPR #12 is open and CI is green.\n')
  files.set('gamma-review/LOG.md', log(dispatched('08:00:00', S.gamma, DEMO, SONNET)))
  files.set('gamma-review/session', `${S.gamma}\n`)

  files.set('delta-done/TASK.md', taskMd('delta-done', 'write the docs for the demo project', DEMO))
  files.set('delta-done/STATUS.md', 'state: done\n\nPR #3 is merged.\n')
  files.set(
    'delta-done/LOG.md',
    log(dispatched('08:30:00', S.delta, DEMO, SONNET), `${TASK_FIXTURE_DAY}T14:00:00Z verified by orchestrator: merged PR 3`)
  )

  files.set('epsilon-blocked/TASK.md', taskMd('epsilon-blocked', 'export the shop orders', SHOP))
  files.set('epsilon-blocked/STATUS.md', 'state: blocked\n\nWaiting on a decision.\n')

  files.set('zeta-noisy/TASK.md', taskMd('zeta-noisy', 'plan the shop cart', SHOP, OPUS))
  files.set('zeta-noisy/STATUS.md', 'state: planned\n\nThe plan is written.\n')
  files.set(
    'zeta-noisy/LOG.md',
    log(
      '# Log',
      '',
      dispatched('10:00:00', S.zeta, SHOP, OPUS),
      `- ${TASK_FIXTURE_DAY} 13:00 DECISION: split the work in two`,
      `${TASK_FIXTURE_DAY}T12:30:00Z rerouted the plan`,
      'this line is not in any format'
    )
  )

  files.set('eta-redispatched/TASK.md', taskMd('eta-redispatched', 'fix the demo footer', DEMO))
  files.set('eta-redispatched/STATUS.md', 'state: in_progress\n\nBack at it.\n')
  files.set(
    'eta-redispatched/LOG.md',
    log(
      dispatched('08:00:00', S.etaFirst, DEMO, SONNET),
      `${TASK_FIXTURE_DAY}T09:00:00Z verified by orchestrator: first pass merged`,
      dispatched('13:00:00', S.etaSecond, DEMO, SONNET)
    )
  )
  files.set('eta-redispatched/session', `${S.etaSecond}\n`)

  return files
}
