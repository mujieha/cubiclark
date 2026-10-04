// Folds an adapter snapshot into the World (docs/adapters.md, "How a snapshot reaches the World").
// Pure and idempotent: applying the same snapshot twice equals applying it once, so the store can
// re-apply it on every tick. Every time comes from an argument: `nowMs`, the snapshot's own fetch
// time and the agents' own timestamps.

import { ownEntry } from '../keys.js'
import type { Agent, AgentRole, Task, TaskTimelineEntry, World } from '../types.js'
import { quotaAt } from './quota.js'
import type { AdapterSnapshot, AgentLink, CliSession } from './types.js'

export interface ApplyOptions {
  /** In replay, tasks are cut to the replay clock (tasksAt). */
  replay: boolean
}

const TERMINAL: ReadonlySet<Agent['state']> = new Set(['finished', 'failed', 'ended'])
/** Roles an adapter may replace: never an orchestrator or explorer the transcripts or an earlier rule set. */
const REPLACEABLE_ROLES: ReadonlySet<AgentRole | undefined> = new Set([undefined, 'builder', 'planner', 'reviewer'])

function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

// --- Replay: a task as it was at a moment -------------------------------------------------------

const START_KINDS: ReadonlySet<TaskTimelineEntry['kind']> = new Set(['dispatched', 'resumed', 'forked'])

/** The phase the newest of `kept` implies (used by replay's cut, and by the HUD to place a block). */
export function phaseAfterCut(kept: readonly TaskTimelineEntry[], planModel: string | undefined): Task['phase'] {
  const last = kept[kept.length - 1]
  if (!last) return undefined
  switch (last.kind) {
    case 'planned':
      return 'planning'
    case 'pr':
      return 'review'
    case 'done':
    case 'merged':
      return 'done'
    case 'blocked':
      return 'blocked'
    default: {
      // dispatched, resumed, forked, paused, note: the newest start says what is running
      const start = [...kept].reverse().find((entry) => START_KINDS.has(entry.kind))
      if (!start) return undefined
      return planModel !== undefined && start.model === planModel ? 'planning' : 'building'
    }
  }
}

/** The tasks as they stood at `nowMs`: entries after it are removed, a task with none left is
 * dropped, and a cut task's phase, model, PR and last activity follow what remains. */
export function tasksAt(tasks: readonly Task[], nowMs: number): Task[] {
  const out: Task[] = []
  for (const task of tasks) {
    const kept = task.timeline.filter((entry) => Date.parse(entry.ts) <= nowMs)
    if (kept.length === 0) continue
    if (kept.length === task.timeline.length) {
      out.push(task)
      continue
    }
    const cut: Task = { ...task, timeline: kept }
    const phase = phaseAfterCut(kept, task.planModel)
    if (phase) cut.phase = phase
    else delete cut.phase
    const model = [...kept].reverse().find((entry) => entry.model !== undefined)?.model
    if (model) cut.model = model
    else delete cut.model
    if (!kept.some((entry) => entry.kind === 'pr')) delete cut.pr
    cut.lastActivity = kept[kept.length - 1]?.ts
    out.push(cut)
  }
  return out
}

// --- The World ----------------------------------------------------------------------------------

/** One link per agent: the task whose last activity is newest wins. */
function linkByAgent(links: readonly AgentLink[], tasks: Record<string, Task>): Map<string, AgentLink> {
  const best = new Map<string, AgentLink>()
  const activity = (link: AgentLink): number => {
    const ts = ownEntry(tasks, link.taskId)?.lastActivity
    return ts ? Date.parse(ts) : Number.NEGATIVE_INFINITY
  }
  for (const link of links) {
    const current = best.get(link.agentId)
    if (!current || activity(link) > activity(current)) best.set(link.agentId, link)
  }
  return best
}

function cliInfo(session: CliSession, fetchedAt: string): NonNullable<Agent['cli']> {
  return {
    ...(session.kind ? { kind: session.kind } : {}),
    ...(session.state ? { state: session.state } : {}),
    ...(session.status ? { status: session.status } : {}),
    ...(session.waitingFor ? { waitingFor: session.waitingFor } : {}),
    ...(session.name ? { name: session.name } : {}),
    fetchedAt,
  }
}

export function applyAdapters(world: World, snap: AdapterSnapshot | undefined, nowMs: number, options: ApplyOptions): World {
  if (!snap) return world
  let next = world

  // 1. Tasks.
  if (snap.tasks) {
    const list = options.replay ? tasksAt(snap.tasks, nowMs) : snap.tasks
    next = { ...next, tasks: Object.fromEntries(list.map((task) => [task.id, task])) }
  }

  // 2-4. Per-agent fields, changing only agents that need it.
  const links = snap.links ? linkByAgent(snap.links, next.tasks) : new Map<string, AgentLink>()
  const orchestratorCwds = new Set((snap.orchestratorCwds ?? []).map(trimSlashes))
  const sessions = new Map<string, CliSession>()
  for (const session of snap.cliSessions ?? []) if (session.sessionId) sessions.set(session.sessionId, session)
  const fetchedAt = snap.cliFetchedAt

  let agents = next.agents
  const put = (id: string, agent: Agent): void => {
    if (agents === next.agents) agents = { ...next.agents }
    agents[id] = agent
  }

  for (const [id, original] of Object.entries(next.agents)) {
    let agent = original

    const link = links.get(id)
    if (link && ownEntry(next.tasks, link.taskId)) {
      agent = {
        ...agent,
        taskId: link.taskId,
        effort: agent.effort ?? link.effort,
        model: agent.model ?? link.model,
        role: link.role && REPLACEABLE_ROLES.has(agent.role) ? link.role : agent.role,
      }
    } else if (agent.taskId !== undefined && (snap.tasks !== undefined || !ownEntry(next.tasks, agent.taskId))) {
      // The task adapter spoke and no link names the task any more (the folder was removed, or aged out
      // of the window), or the task is not there: the agent forgets it instead of pointing at nothing (R2-5).
      agent = { ...agent }
      delete agent.taskId
    }

    if (
      orchestratorCwds.size > 0 &&
      (agent.kind === 'session' || agent.kind === 'background') &&
      agent.parentId === undefined &&
      orchestratorCwds.has(trimSlashes(agent.cwd))
    ) {
      agent = { ...agent, role: 'orchestrator' }
    }

    if (fetchedAt !== undefined) {
      const session = sessions.get(id)
      if (session) {
        const alreadySeen = agent.cli?.fetchedAt === fetchedAt
        agent = {
          ...agent,
          cli: cliInfo(session, fetchedAt),
          kind: session.kind === 'background' && agent.kind === 'session' ? 'background' : agent.kind,
          label: agent.label ?? session.name,
        }
        // 5. A permission prompt the CLI reports that no hook or transcript has said: once per fetch,
        // only when the fetch is newer than the agent's last activity, never for a hooked agent.
        if (
          !alreadySeen &&
          session.status === 'waiting' &&
          session.waitingFor === 'permission prompt' &&
          agent.hooked === undefined &&
          !TERMINAL.has(agent.state) &&
          Date.parse(fetchedAt) > Date.parse(agent.lastActivity)
        ) {
          agent = {
            ...agent,
            state: 'waiting_permission',
            stateSince: agent.state === 'waiting_permission' ? agent.stateSince : fetchedAt,
            stateEvidence: 'observed',
          }
        }
      } else if (agent.cli) {
        // The session is no longer in the CLI's list (finished, stopped): forget what it said.
        agent = { ...agent }
        delete agent.cli
      }
    }

    if (agent !== original) put(id, agent)
  }
  if (agents !== next.agents) next = { ...next, agents }

  // 6. Quota.
  if (snap.quotaSamples !== undefined) {
    const quota = quotaAt(snap.quotaSamples, nowMs)
    if (quota) next = { ...next, quota }
    else if (next.quota) {
      next = { ...next }
      delete next.quota
    }
  }
  return next
}
