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
