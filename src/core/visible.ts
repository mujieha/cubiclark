// Who is in view (cubiclark-quiet-office): the one rule the office, the list, the panel and every
// agent count share. Pure, like the rest of core/: the clock comes in as `nowMs`. The World itself is
// never changed by it (the server still knows every agent, and `doctor` still counts them); hiding is
// a property of the view. An agent that is hidden simply is not in the next layout, so it leaves
// without a walk-out and, when it is shown again, walks in through the door like a newcomer.

import type { Agent, AgentState, World } from './types.js'

export const DEFAULT_IDLE_DESKS = 5
export const MAX_IDLE_DESKS = 1000
/** How long a finished or ended agent stays in view after it stopped (inclusive). */
export const FINISHED_GRACE_MS = 10 * 60 * 1000
/** A failed agent needs attention: it stays longer. */
export const FAILED_GRACE_MS = 30 * 60 * 1000
/** A stuck agent (quiet far longer than it should be) stays this long in that state, then leaves the
 * view: a killed session's subagent would otherwise sit in the office all day. */
export const STUCK_GRACE_MS = 30 * 60 * 1000

/** Same limit as roles.ts's MAX_ANCESTOR_STEPS: past it a helper counts as unanchored anyway. */
const MAX_ANCESTOR_STEPS = 8

const TERMINAL: ReadonlySet<AgentState> = new Set(['finished', 'failed', 'ended'])

export interface VisibleOptions {
  /** How many `waiting_user` agents keep a desk: the most recently active ones. Default 5; 0 hides every idle agent. */
  idleDesks?: number
  finishedGraceMs?: number
  failedGraceMs?: number
  stuckGraceMs?: number
}

export interface HiddenCounts {
  /** `waiting_user` agents not shown. */
  idle: number
  /** `finished`, `ended` and `failed` agents past their grace time. */
  finished: number
  /** `stuck` agents that have been stuck past their grace time. */
  stuck: number
}

export interface VisibleSet {
  ids: ReadonlySet<string>
  hidden: HiddenCounts
}

/** An `--idle-desks` value or a page-options field: a whole number from 0 to MAX_IDLE_DESKS, else undefined. */
export function parseIdleDesks(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_IDLE_DESKS ? value : undefined
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** When the agent last did something, in ms; an unreadable time sorts as the oldest. */
function activityMs(agent: Agent): number {
  const ms = Date.parse(agent.lastActivity)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/** Who is shown at `nowMs`:
 * 1. finished, ended and failed agents for a grace time after they stopped, and stuck agents for a
 *    grace time after they got stuck (an unreadable time fails open: the agent is shown);
 * 2. of the agents waiting for you, the `idleDesks` most recently active (ties by id);
 * 3. everyone else, always;
 * 4. an idle parent of a shown agent that is not finished, so a helper stays on its stool by that desk
 *    instead of jumping to a desk of its own. It does not use up one of the `idleDesks`. */
export function visibleAgents(world: World, nowMs: number, options: VisibleOptions = {}): VisibleSet {
  const idleDesks = parseIdleDesks(options.idleDesks) ?? DEFAULT_IDLE_DESKS
  const finishedGraceMs = options.finishedGraceMs ?? FINISHED_GRACE_MS
  const failedGraceMs = options.failedGraceMs ?? FAILED_GRACE_MS
  const stuckGraceMs = options.stuckGraceMs ?? STUCK_GRACE_MS

  const ids = new Set<string>()
  const idle: Agent[] = []
  let hiddenFinished = 0
  let hiddenStuck = 0
  for (const agent of Object.values(world.agents)) {
    if (TERMINAL.has(agent.state)) {
      const grace = agent.state === 'failed' ? failedGraceMs : finishedGraceMs
      if (nowMs - Date.parse(agent.stateSince) > grace) hiddenFinished += 1
      else ids.add(agent.id)
    } else if (agent.state === 'stuck') {
      if (nowMs - Date.parse(agent.stateSince) > stuckGraceMs) hiddenStuck += 1
      else ids.add(agent.id)
    } else if (agent.state === 'waiting_user') {
      idle.push(agent)
    } else {
      ids.add(agent.id)
    }
  }

  idle.sort((a, b) => activityMs(b) - activityMs(a) || byId(a.id, b.id))
  const idleHidden = new Set<string>()
  idle.forEach((agent, rank) => {
    if (rank < idleDesks) ids.add(agent.id)
    else idleHidden.add(agent.id)
  })

  // Parents of the shown, top down from each shown agent. Only agents hidden as idle come back; a
  // finished parent stays hidden (its helper goes to the floor), and the climb stops at one.
  if (idleHidden.size > 0) {
    for (const id of [...ids]) {
      const start = world.agents[id]
      if (!start || TERMINAL.has(start.state)) continue
      let current: Agent = start
      const seen = new Set<string>([current.id])
      for (let steps = 0; steps < MAX_ANCESTOR_STEPS; steps++) {
        const parent: Agent | undefined = current.parentId === undefined ? undefined : world.agents[current.parentId]
        if (!parent || seen.has(parent.id) || TERMINAL.has(parent.state)) break
        seen.add(parent.id)
        if (idleHidden.delete(parent.id)) ids.add(parent.id)
        current = parent
      }
    }
  }

  return { ids, hidden: { idle: idleHidden.size, finished: hiddenFinished, stuck: hiddenStuck } }
}

/** The same World with only the visible agents; the same reference when nothing is hidden. Nothing
 * else changes (the log, the tasks, the sources and the clock are the very same values). */
export function withVisibleAgents(world: World, visible: VisibleSet): World {
  const all = Object.keys(world.agents)
  if (all.every((id) => visible.ids.has(id))) return world
  const agents: Record<string, Agent> = {}
  for (const id of all) if (visible.ids.has(id)) agents[id] = world.agents[id] as Agent
  return { ...world, agents }
}

/** "195 idle not shown · 6 finished not shown · 1 stuck not shown": only the non-zero parts; undefined
 * when nothing is hidden. */
export function hiddenText(hidden: HiddenCounts | undefined): string | undefined {
  if (!hidden) return undefined
  const parts: string[] = []
  if (hidden.idle > 0) parts.push(`${hidden.idle} idle not shown`)
  if (hidden.finished > 0) parts.push(`${hidden.finished} finished not shown`)
  if (hidden.stuck > 0) parts.push(`${hidden.stuck} stuck not shown`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
