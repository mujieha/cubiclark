// A task folder's TASK.md, STATUS.md, LOG.md and `session` file -> a Task (docs/adapters.md, "The
// task-folder format"). Pure: the server adapter reads the files and passes their text, and the
// clock arrives as an argument.

import type { AgentRole, Task, TaskPhase, TaskTimelineEntry, TaskTimelineKind } from '../types.js'
import type { AgentLink } from './types.js'
import { cleanText, isSessionId, parseLog, reducePaths } from './task-log.js'

export const MAX_TIMELINE_ENTRIES = 200

// --- TASK.md ------------------------------------------------------------------------------------

export interface TaskMd {
  heading?: string
  goal?: string
  /** Basename of `Project:`. */
  project?: string
  model?: string
  planModel?: string
  effort?: string
}

function fieldValue(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

export function parseTaskMd(text: string): TaskMd {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
  const out: TaskMd = {}
  const heading = lines.find((line) => line.startsWith('# '))
  if (heading) out.heading = cleanText(heading.slice(2))
  const goal = fieldValue(lines, 'Goal')
  if (goal) out.goal = cleanText(goal)
  const project = fieldValue(lines, 'Project') ?? fieldValue(lines, 'Project dir')
  if (project) out.project = reducePaths(project.split(/\s+/)[0] ?? project)
  const model = fieldValue(lines, 'Model')
  if (model) out.model = model.split(/\s+/)[0]
  const planModel = fieldValue(lines, 'PlanModel')
  if (planModel) out.planModel = planModel.split(/\s+/)[0]
  const effort = fieldValue(lines, 'Effort')
  if (effort) out.effort = effort.split(/\s+/)[0]
  return out
}

// --- STATUS.md ----------------------------------------------------------------------------------

export type StatusState = 'planned' | 'in_progress' | 'done' | 'blocked' | 'other'

export interface StatusMd {
  state?: StatusState
  pr?: number
}

const STATUS_STATES: readonly StatusState[] = ['planned', 'in_progress', 'done', 'blocked']

export function parseStatusMd(text: string): StatusMd {
  const out: StatusMd = {}
  const firstLine = text.split('\n').find((line) => line.trim() !== '')
  const state = firstLine ? /^state:\s*(\S+)/i.exec(firstLine.trim()) : null
  if (state) {
    const value = (state[1] as string).toLowerCase().replace(/[.,;]$/, '')
    out.state = (STATUS_STATES as readonly string[]).includes(value) ? (value as StatusState) : 'other'
  }
  const pr = /\bPR\s*#(\d+)|\/pull\/(\d+)|pull request\s*#(\d+)/i.exec(text)
  const number = pr?.[1] ?? pr?.[2] ?? pr?.[3]
  if (number) out.pr = Number(number)
  return out
}

// --- Phase rules --------------------------------------------------------------------------------

export interface PhaseInput {
  status?: StatusMd
  entries: readonly TaskTimelineEntry[]
  planModel?: string
}

const START_KINDS: ReadonlySet<TaskTimelineKind> = new Set(['dispatched', 'resumed', 'forked'])

function newest(entries: readonly TaskTimelineEntry[], kinds: ReadonlySet<TaskTimelineKind>): TaskTimelineEntry | undefined {
  let best: TaskTimelineEntry | undefined
  for (const entry of entries) {
    if (!kinds.has(entry.kind)) continue
    if (!best || Date.parse(entry.ts) >= Date.parse(best.ts)) best = entry
  }
  return best
}

/** First match wins (docs/adapters.md):
 * 1. a verified line newer than every dispatch, resume and fork: done;
 * 2. STATUS `blocked`: blocked;  3. `planned`: planning;  4. `in_progress`: building;
 * 5. `done` (with or without a PR, not yet verified): review;
 * 6. no STATUS.md (or an unknown state): the newest dispatch, resume or fork decides, planning
 *    when it ran the task's PlanModel and building otherwise;
 * 7. otherwise nothing. */
export function taskPhase(input: PhaseInput): TaskPhase | undefined {
  const lastDone = newest(input.entries, new Set<TaskTimelineKind>(['done']))
  const lastStart = newest(input.entries, START_KINDS)
  if (lastDone && (!lastStart || Date.parse(lastDone.ts) > Date.parse(lastStart.ts))) return 'done'

  switch (input.status?.state) {
    case 'blocked':
      return 'blocked'
    case 'planned':
      return 'planning'
    case 'in_progress':
      return 'building'
    case 'done':
      return 'review'
    default:
      break
  }
  if (lastStart) return input.planModel !== undefined && lastStart.model === input.planModel ? 'planning' : 'building'
  return undefined
}

// --- The task -----------------------------------------------------------------------------------

export interface TaskParts {
  id: string
  taskMd: string
  statusMd?: string
  /** STATUS.md's mtime; the time of the entry STATUS.md contributes. */
  statusMtimeMs?: number
  logText?: string
  /** The contents of the `session` file. */
  sessionFile?: string
  nowMs: number
}

export interface BuiltTask {
  task: Task
  effortBySession: Record<string, string>
  modelBySession: Record<string, string>
  unparsedLogLines: number
  unknownVerbs: Record<string, number>
}

function statusEntry(status: StatusMd, tsMs: number): TaskTimelineEntry | undefined {
  const ts = new Date(tsMs).toISOString()
  switch (status.state) {
    case 'planned':
      return { ts, kind: 'planned', text: 'plan written' }
    case 'blocked':
      return { ts, kind: 'blocked', text: 'blocked' }
    case 'done':
      return status.pr !== undefined ? { ts, kind: 'pr', text: `PR #${status.pr}` } : { ts, kind: 'note', text: 'worker reports done' }
    default:
      return undefined
  }
}

export function buildTask(parts: TaskParts): BuiltTask {
  const taskMd = parseTaskMd(parts.taskMd)
  const status = parts.statusMd === undefined ? undefined : parseStatusMd(parts.statusMd)
  const log = parseLog(parts.logText ?? '')

  const entries: TaskTimelineEntry[] = [...log.entries]
  if (status) {
    const at = Math.min(parts.statusMtimeMs ?? parts.nowMs, parts.nowMs)
    const derived = statusEntry(status, at)
    if (derived) entries.push(derived)
  }
  // Stable by time: equal times keep their file order (Array.prototype.sort is stable).
  entries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  const timeline = entries.length > MAX_TIMELINE_ENTRIES ? entries.slice(-MAX_TIMELINE_ENTRIES) : entries

  const sessionFileId = parts.sessionFile?.split('\n')[0]?.trim()
  const fileId = sessionFileId && isSessionId(sessionFileId) ? sessionFileId : undefined
  const sessionIds = [...log.sessions]
  if (fileId && !sessionIds.includes(fileId)) sessionIds.push(fileId)

  const newestModel = [...timeline].reverse().find((entry) => entry.model !== undefined)?.model

  const task: Task = { id: parts.id, timeline, source: 'task-folders' }
  const phase = taskPhase({ status, entries: timeline, planModel: taskMd.planModel })
  if (phase) task.phase = phase
  const title = taskMd.goal ?? taskMd.heading
  if (title) task.title = title
  if (taskMd.project) task.project = taskMd.project
  const model = newestModel ?? taskMd.model
  if (model) task.model = model
  if (taskMd.planModel) task.planModel = taskMd.planModel
  const effort = log.newestEffort ?? taskMd.effort
  if (effort) task.effort = effort
  if (sessionIds.length > 0) task.sessionIds = sessionIds
  const current = fileId ?? log.currentSession
  if (current) task.currentSessionId = current
  if (status?.pr !== undefined) task.pr = status.pr
  const last = timeline[timeline.length - 1]
  if (last) task.lastActivity = last.ts

  return {
    task,
    effortBySession: log.effortBySession,
    modelBySession: log.modelBySession,
    unparsedLogLines: log.unparsed,
    unknownVerbs: log.unknownVerbs,
  }
}

const ROLE_BY_PHASE: Partial<Record<TaskPhase, AgentRole>> = { planning: 'planner', building: 'builder', review: 'reviewer' }

/** One link per session the task names: what role its phase gives it, and the effort and model
 * the log recorded for that session. */
export function taskLinks(built: BuiltTask): AgentLink[] {
  const { task } = built
  const role = task.phase ? ROLE_BY_PHASE[task.phase] : undefined
  return (task.sessionIds ?? []).map((agentId) => {
    const effort = built.effortBySession[agentId] ?? task.effort
    const model = built.modelBySession[agentId]
    return {
      agentId,
      taskId: task.id,
      ...(role ? { role } : {}),
      ...(effort ? { effort } : {}),
      ...(model ? { model } : {}),
    }
  })
}
