// One invented working day for the HUD, the adapters and `replay` (test/fixtures/day/): seven
// transcripts and one subagent, two hook lines, quota samples, a config file and five task folders,
// all on 2026-01-16 and all invented (ids from the invented families, projects under
// /home/user/projects, prose from the lorem list). test/day-fixtures.test.ts builds the World from
// it with the real parsers and adapters, and test/e2e/hud.spec.ts and replay.spec.ts serve it.
//
//   root of the day:   home/     the Claude config directory (transcripts)
//                      state/    events.jsonl, config.json, quota.jsonl
//                      tasks/    the task folders the config points at
//
// The newest record, and so the frozen clock of a fixture-mode server, is END = 17:59:50Z.
//
//   session  cwd    task           what it is, at END
//   S0 (1)   hq     -              the orchestrator (found by its cwd): running, manager's office
//   S1 (3)   demo   demo-login     planned demo-login on opus; ended at 12:41 -> the lobby board
//   S2 (2)   demo   demo-login     builds it (sonnet, forked at 13:00): editing, with an Explore helper
//   S3 (5)   shop   shop-cart      just dispatched on the plan model: planning room; `claude agents`
//                                  says it waits on a permission prompt
//   S4 (4)   demo   demo-search    turn ended 16:09, PR #7 open: the review corner, waiting for you
//   S5 (8)   shop   shop-export    blocked (paused at the weekly limit); ended at 11:01 -> the board
//   S6 (7)   demo   -              first record at 15:00:00 = END - 3 h + 10 s: replay's arrival probe
//   (demo-docs is a task with no live session: verified and merged at 12:00.)
//
// Three tasks are mid-flight (demo-login building, shop-cart planning, demo-search in review),
// one is blocked and one is done.

import { serialiseStoredLine, toStoredLine } from '../src/core/hooks/whitelist.js'
import {
  RecordChain,
  assistantRecord,
  lorem,
  sessionId,
  subagentId,
  systemRecord,
  textBlock,
  thinkingBlock,
  toolUseBlock,
  toolUseId,
  userPromptRecord,
  userToolResultRecord,
  type Line,
} from './fixture-lib.js'
import { epochSeconds } from './task-fixture-lib.js'

export const DAY = '2026-01-16'
/** The newest record in the day: a fixture-mode server freezes its clock here. */
export const DAY_END = `${DAY}T17:59:50Z`
export const HQ_CWD = '/home/user/projects/hq'
const DEMO = '/home/user/projects/demo'
const SHOP = '/home/user/projects/shop'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-4-5'

/** The ids of the day, by the letter used above. */
export const DAY_SESSIONS = {
  s0: sessionId('1'),
  s1: sessionId('3'),
  s2: sessionId('2'),
  s3: sessionId('5'),
  s4: sessionId('4'),
  s5: sessionId('8'),
  s6: sessionId('7'),
  docs: sessionId('9'),
} as const
export const DAY_HELPER = subagentId('d1')

type FileMap = Map<string, string>

const t = (hms: string): string => `${DAY}T${hms}Z`

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function jsonl(lines: Line[]): string {
  return lines.map((line) => ('raw' in line ? line.raw : JSON.stringify(line))).join('\n') + '\n'
}

/** A tool call and its result, three seconds apart. */
function toolPair(chain: RecordChain, lines: Line[], when: string, id: number, name: string, input: Record<string, unknown>, model: string): void {
  const call = toolUseId(id)
  lines.push(assistantRecord(chain, when, [toolUseBlock(call, name, input)], { stopReason: 'tool_use', model }))
  lines.push(userToolResultRecord(chain, new Date(Date.parse(when) + 3000).toISOString(), call, lorem(5)))
}

/** The end of a turn: a closing message and its duration record. */
function endTurn(chain: RecordChain, lines: Line[], when: string, model: string): void {
  lines.push(assistantRecord(chain, when, [textBlock(lorem(8))], { stopReason: 'end_turn', outputTokens: 40, model }))
  lines.push(systemRecord(chain, new Date(Date.parse(when) + 1000).toISOString(), 'turn_duration', { durationMs: 4000 }))
}

function s0Lines(): Line[] {
  const chain = new RecordChain({ sessionId: DAY_SESSIONS.s0, cwd: HQ_CWD })
  const lines: Line[] = []
  lines.push(chain.rec(t('08:00:00'), { type: 'permission-mode', permissionMode: 'bypassPermissions' }))
  lines.push(userPromptRecord(chain, t('08:00:05'), lorem(6)))
  toolPair(chain, lines, t('08:05:00'), 1, 'Bash', { command: 'git status', description: lorem(2) }, OPUS)
  toolPair(chain, lines, t('09:00:00'), 2, 'Bash', { command: 'ls tasks', description: lorem(2) }, OPUS)
  toolPair(chain, lines, t('12:00:00'), 3, 'Read', { file_path: `${HQ_CWD}/tasks/demo-docs/LOG.md` }, OPUS)
  toolPair(chain, lines, t('13:00:00'), 4, 'Bash', { command: 'agent-fork', description: lorem(2) }, OPUS)
  toolPair(chain, lines, t('15:00:00'), 5, 'Bash', { command: 'gh pr list', description: lorem(2) }, OPUS)
  toolPair(chain, lines, t('17:20:00'), 6, 'Bash', { command: 'agent-dispatch', description: lorem(2) }, OPUS)
  // still running a command at the end of the day
  lines.push(assistantRecord(chain, DAY_END, [toolUseBlock(toolUseId(7), 'Bash', { command: 'agent-quota', description: lorem(2) })], { stopReason: 'tool_use', model: OPUS }))
  return lines
}

function s1Lines(): Line[] {
  const chain = new RecordChain({ sessionId: DAY_SESSIONS.s1, cwd: DEMO })
  const lines: Line[] = []
  lines.push(userPromptRecord(chain, t('09:00:00'), lorem(6)))
  toolPair(chain, lines, t('09:00:30'), 1, 'Read', { file_path: `${DEMO}/README.md` }, OPUS)
  toolPair(chain, lines, t('10:15:00'), 2, 'Grep', { pattern: 'login', path: DEMO }, OPUS)
  toolPair(chain, lines, t('11:30:00'), 3, 'Write', { file_path: `${DEMO}/PLAN.md`, content: lorem(4) }, OPUS)
  endTurn(chain, lines, t('12:40:00'), OPUS)
  return lines
}

function s2Lines(): { lines: Line[]; helper: Line[]; meta: Record<string, unknown> } {
  const chain = new RecordChain({ sessionId: DAY_SESSIONS.s2, cwd: DEMO, sessionKind: 'bg' })
  const lines: Line[] = []
  lines.push(chain.rec(t('13:00:00'), { type: 'agent-name', agentName: 'demo-worker' }))
  lines.push(chain.rec(t('13:00:01'), { type: 'permission-mode', permissionMode: 'bypassPermissions' }))
  lines.push(userPromptRecord(chain, t('13:00:05'), lorem(6)))
  toolPair(chain, lines, t('13:10:00'), 1, 'Read', { file_path: `${DEMO}/src/login.ts` }, SONNET)
  toolPair(chain, lines, t('14:00:00'), 2, 'Edit', { file_path: `${DEMO}/src/login.ts`, old_string: lorem(1), new_string: lorem(2) }, SONNET)
  toolPair(chain, lines, t('15:30:00'), 3, 'Bash', { command: 'npm test', description: lorem(2) }, SONNET)
  toolPair(chain, lines, t('16:45:00'), 4, 'Edit', { file_path: `${DEMO}/src/form.ts`, old_string: lorem(1), new_string: lorem(2) }, SONNET)
  // a helper is searching, and an edit is under way, when the day ends
  const spawn = toolUseId(5)
  lines.push(assistantRecord(chain, t('17:55:00'), [toolUseBlock(spawn, 'Agent', { subagent_type: 'Explore', description: lorem(3), prompt: lorem(6) })], { stopReason: 'tool_use', model: SONNET }))
  lines.push(assistantRecord(chain, t('17:59:30'), [toolUseBlock(toolUseId(6), 'Edit', { file_path: `${DEMO}/src/login.ts`, old_string: lorem(1), new_string: lorem(2) })], { stopReason: 'tool_use', model: SONNET }))

  const sub = new RecordChain({ sessionId: DAY_SESSIONS.s2, cwd: DEMO, isSidechain: true, agentId: DAY_HELPER })
  const helper: Line[] = []
  helper.push(userPromptRecord(sub, t('17:55:10'), lorem(6)))
  helper.push(assistantRecord(sub, t('17:59:00'), [toolUseBlock(toolUseId(101), 'Glob', { pattern: '**/*.ts' })], { stopReason: 'tool_use', model: HAIKU }))
  return { lines, helper, meta: { agentType: 'Explore', description: lorem(4), toolUseId: spawn, model: HAIKU, spawnDepth: 1 } }
}

function s3Lines(): Line[] {
  const chain = new RecordChain({ sessionId: DAY_SESSIONS.s3, cwd: SHOP, sessionKind: 'bg' })
  const lines: Line[] = []
  lines.push(chain.rec(t('17:20:00'), { type: 'agent-name', agentName: 'shop-planner' }))
  lines.push(chain.rec(t('17:20:01'), { type: 'permission-mode', permissionMode: 'default' }))
  lines.push(userPromptRecord(chain, t('17:20:05'), lorem(6)))
  toolPair(chain, lines, t('17:21:00'), 1, 'Read', { file_path: `${SHOP}/README.md` }, OPUS)
  // thinking when the day ends; the CLI says it is waiting on a permission prompt
  lines.push(assistantRecord(chain, t('17:58:00'), [thinkingBlock(lorem(8))], { stopReason: null, model: OPUS }))
  return lines
}

function s4Lines(): Line[] {
  const chain = new RecordChain({ sessionId: DAY_SESSIONS.s4, cwd: DEMO })
  const lines: Line[] = []
  lines.push(userPromptRecord(chain, t('14:00:00'), lorem(6)))
  toolPair(chain, lines, t('14:10:00'), 1, 'Read', { file_path: `${DEMO}/src/search.ts` }, SONNET)
  toolPair(chain, lines, t('14:40:00'), 2, 'Edit', { file_path: `${DEMO}/src/search.ts`, old_string: lorem(1), new_string: lorem(2) }, SONNET)
  toolPair(chain, lines, t('15:50:00'), 3, 'Bash', { command: 'npm test', description: lorem(2) }, SONNET)
  endTurn(chain, lines, t('16:09:00'), SONNET)
  return lines
}

function s5Lines(): Line[] {
  const chain = new RecordChain({ sessionId: DAY_SESSIONS.s5, cwd: SHOP })
  const lines: Line[] = []
  lines.push(userPromptRecord(chain, t('10:00:00'), lorem(6)))
  toolPair(chain, lines, t('10:30:00'), 1, 'Bash', { command: 'npm run export', description: lorem(2) }, OPUS)
  endTurn(chain, lines, t('11:00:00'), OPUS)
  return lines
}

function s6Lines(): Line[] {
  const chain = new RecordChain({ sessionId: DAY_SESSIONS.s6, cwd: DEMO })
  const lines: Line[] = []
  // the first record is 10 s after the start of a 3 h replay window
  lines.push(userPromptRecord(chain, t('15:00:00'), lorem(6)))
  toolPair(chain, lines, t('15:20:00'), 1, 'Read', { file_path: `${DEMO}/docs/notes.md` }, HAIKU)
  toolPair(chain, lines, t('16:40:00'), 2, 'Bash', { command: 'git log', description: lorem(2) }, HAIKU)
  endTurn(chain, lines, t('17:30:00'), HAIKU)
  return lines
}

// --- The state directory ---------------------------------------------------------------------

/** Two hook lines, through the real whitelist: the sessions that were closed for good. Every other
 * agent has no hook line, so the transcripts and `claude agents` alone decide its state. */
function hookText(): string {
  const end = (sid: string, cwd: string, when: string): string =>
    serialiseStoredLine(toStoredLine({ hook_event_name: 'SessionEnd', session_id: sid, cwd, reason: 'other' }, when))
  return end(DAY_SESSIONS.s1, DEMO, t('12:41:00')) + end(DAY_SESSIONS.s5, SHOP, t('11:01:00'))
}

/** Quota samples in the status line's shape, every half hour: a 5 h window that resets at 13:00
 * (so at 13:30, with no newer sample, it reads 0), then one that resets at 19:00. */
function quotaText(): string {
  const week = epochSeconds('2026-01-19T04:00:00Z')
  const lines: string[] = []
  const first = [4, 10, 18, 26, 35, 43, 52, 60, 68, 75]
  first.forEach((pct, i) => {
    const at = Date.parse(t('08:00:00')) + i * 30 * 60_000
    lines.push(JSON.stringify({ ts: Math.floor(at / 1000), limit_5h_pct: pct, limit_7d_pct: 30 + Math.floor(i / 3), limit_5h_resets: epochSeconds(t('13:00:00')), limit_7d_resets: week }))
    if (i === 3) lines.push(JSON.stringify({ ts: Math.floor(at / 1000) + 60, tokens_in: 900, tokens_out: 120 })) // another metric
  })
  const second = [3, 10, 17, 25, 33, 42, 52, 62]
  const secondWeek = [34, 35, 36, 37, 38, 39, 39, 40]
  second.forEach((pct, i) => {
    const at = Date.parse(t('14:00:00')) + i * 30 * 60_000
    lines.push(JSON.stringify({ ts: Math.floor(at / 1000), limit_5h_pct: pct, limit_7d_pct: secondWeek[i], limit_5h_resets: epochSeconds(t('19:00:00')), limit_7d_resets: week }))
  })
  return `${lines.join('\n')}\n`
}

const CONFIG = {
  adapters: {
    'task-folders': { roots: ['../tasks'], orchestratorCwd: HQ_CWD },
    'quota-samples': { file: 'quota.jsonl' },
    'claude-agents': { enabled: true, bin: '../../bin/claude' },
  },
}

// --- The task folders ------------------------------------------------------------------------

function taskMd(name: string, goal: string, project: string): string {
  return [`# ${name}`, `Goal: ${goal}`, `Project: ${project}`, 'Scope: the repository', `Model: ${SONNET}`, `PlanModel: ${OPUS}`, 'Effort: high', ''].join('\n')
}

const dispatched = (when: string, sid: string, project: string, model: string): string =>
  `${t(when)} dispatched session ${sid} in ${project} model=${model} effort=high perms=bypassPermissions`

function taskFiles(): FileMap {
  const files: FileMap = new Map()
  const S = DAY_SESSIONS
  const lines = (...rows: string[]): string => `${rows.join('\n')}\n`

  files.set('demo-login/TASK.md', taskMd('demo-login', 'build the login form for the demo project', DEMO))
  files.set('demo-login/STATUS.md', 'state: in_progress\n\nBuilding it.\n')
  files.set(
    'demo-login/LOG.md',
    lines(dispatched('09:00:00', S.s1, DEMO, OPUS), `${t('13:00:00')} forked ${S.s1} -> ${S.s2} model=${SONNET} effort=high (compactions=1) plan reviewed`)
  )
  files.set('demo-login/session', `${S.s2}\n`)

  files.set('shop-cart/TASK.md', taskMd('shop-cart', 'plan the cart for the shop project', SHOP))
  files.set('shop-cart/LOG.md', lines(dispatched('17:20:00', S.s3, SHOP, OPUS)))
  files.set('shop-cart/session', `${S.s3}\n`)

  files.set('demo-search/TASK.md', taskMd('demo-search', 'add search to the demo project', DEMO))
  files.set('demo-search/STATUS.md', 'state: done\n\nPR #7 is open and CI is green.\n')
  files.set('demo-search/LOG.md', lines(dispatched('14:00:00', S.s4, DEMO, SONNET)))
  files.set('demo-search/session', `${S.s4}\n`)

  files.set('shop-export/TASK.md', taskMd('shop-export', 'export the shop orders', SHOP))
  files.set('shop-export/STATUS.md', 'state: blocked\n\nWaiting for the weekly limit to reset.\n')
  files.set('shop-export/LOG.md', lines(dispatched('10:00:00', S.s5, SHOP, OPUS), `${t('11:00:30')} paused at weekly 95%; resume after Mon 19 Jan 04:00`))
  files.set('shop-export/session', `${S.s5}\n`)

  files.set('demo-docs/TASK.md', taskMd('demo-docs', 'write the docs for the demo project', DEMO))
  files.set('demo-docs/STATUS.md', 'state: done\n\nPR #3 is merged.\n')
  files.set('demo-docs/LOG.md', lines(dispatched('08:30:00', S.docs, DEMO, SONNET), `${t('12:00:00')} verified by orchestrator: merged PR 3`))
  return files
}

// --- The whole day ---------------------------------------------------------------------------

export interface DayFixture {
  home: FileMap
  state: FileMap
  tasks: FileMap
}

/** Built after the other fixtures: it draws record uuids from the shared counter. */
export function dayFixture(): DayFixture {
  const home: FileMap = new Map()
  const project = (cwd: string, sid: string): string => `projects/${encodeProjectDir(cwd)}/${sid}`
  const S = DAY_SESSIONS

  home.set(`${project(HQ_CWD, S.s0)}.jsonl`, jsonl(s0Lines()))
  home.set(`${project(DEMO, S.s1)}.jsonl`, jsonl(s1Lines()))
  const s2 = s2Lines()
  home.set(`${project(DEMO, S.s2)}.jsonl`, jsonl(s2.lines))
  home.set(`${project(DEMO, S.s2)}/subagents/agent-${DAY_HELPER}.jsonl`, jsonl(s2.helper))
  home.set(`${project(DEMO, S.s2)}/subagents/agent-${DAY_HELPER}.meta.json`, `${JSON.stringify(s2.meta, null, 2)}\n`)
  home.set(`${project(SHOP, S.s3)}.jsonl`, jsonl(s3Lines()))
  home.set(`${project(DEMO, S.s4)}.jsonl`, jsonl(s4Lines()))
  home.set(`${project(SHOP, S.s5)}.jsonl`, jsonl(s5Lines()))
  home.set(`${project(DEMO, S.s6)}.jsonl`, jsonl(s6Lines()))

  const state: FileMap = new Map([
    ['events.jsonl', hookText()],
    ['config.json', `${JSON.stringify(CONFIG, null, 2)}\n`],
    ['quota.jsonl', quotaText()],
  ])
  return { home, state, tasks: taskFiles() }
}
