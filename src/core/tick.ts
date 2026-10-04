// World -> World, driven by a clock the caller passes in (never Date.now() — fixture mode
// freezes this at the newest record seen; live mode passes the real time). Two rules, both from
// PLAN.md §1.6: an inferred `waiting_permission` when a non-exempt tool has gone quiet, and
// `stuck` when an agent that should be working has gone quiet for much longer. Returns the same
// World reference when nothing changes, so callers can cheaply skip re-rendering.

import { isPermissionExempt } from './transcript/tools.js'
import type { Agent, AgentState, World } from './types.js'
import { setState } from './world.js'

export interface TickOptions {
  /** Default 10 minutes. */
  stuckAfterMs?: number
  /** Default 7 seconds. */
  permissionAfterMs?: number
}

const DEFAULT_STUCK_AFTER_MS = 10 * 60 * 1000
const DEFAULT_PERMISSION_AFTER_MS = 7 * 1000

const STUCK_ELIGIBLE: ReadonlySet<AgentState> = new Set([
  'thinking',
  'reading',
  'editing',
  'running',
  'searching',
  'browsing',
  'starting',
  'delegating',
])

const TERMINAL: ReadonlySet<AgentState> = new Set(['finished', 'failed', 'ended'])

function hasLiveChild(world: World, agentId: string): boolean {
  return Object.values(world.agents).some((a) => a.parentId === agentId && !TERMINAL.has(a.state))
}

function inferredPermissionWait(agent: Agent, nowMs: number, permissionAfterMs: number): boolean {
  // Hooks report a real PermissionRequest, so the transcript-side guess is never made for them.
  if (agent.hooked) return false
  const lastOpen = agent.openTools[agent.openTools.length - 1]
  if (!lastOpen) return false
  if (agent.permissionMode === 'bypassPermissions' || agent.permissionMode === 'dontAsk') return false
  if (isPermissionExempt(lastOpen.name, agent.permissionMode)) return false
  // No later activity since the tool opened: a second event on this agent would have moved
  // lastActivity past the tool's own `since`.
  if (agent.lastActivity !== lastOpen.since) return false
  return nowMs - Date.parse(lastOpen.since) >= permissionAfterMs
}

export function tick(world: World, nowMs: number, options: TickOptions = {}): World {
  const stuckAfterMs = options.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS
  const permissionAfterMs = options.permissionAfterMs ?? DEFAULT_PERMISSION_AFTER_MS
  const nowIso = new Date(nowMs).toISOString()

  let next = world
  let changed = false

  for (const agent of Object.values(world.agents)) {
    if (agent.state === 'waiting_permission' && agent.stateEvidence === 'inferred') {
      // The inference clears itself once its own trigger stops holding (e.g. the tool closed
      // without any other event reaching this agent). A real event clears it via the reducer's
      // ordinary, 'observed' setState calls; this only cleans up the case tick() itself created.
      if (!inferredPermissionWait(agent, nowMs, permissionAfterMs)) {
        next = setState(next, agent.id, 'thinking', nowIso)
        changed = true
      }
      continue
    }

    if (inferredPermissionWait(agent, nowMs, permissionAfterMs)) {
      next = setState(next, agent.id, 'waiting_permission', nowIso, 'inferred')
      changed = true
      continue
    }

    const eligible = STUCK_ELIGIBLE.has(agent.state) && (agent.state !== 'delegating' || !hasLiveChild(world, agent.id))
    if (eligible && nowMs - Date.parse(agent.lastActivity) > stuckAfterMs) {
      next = setState(next, agent.id, 'stuck', nowIso)
      changed = true
    }
  }

  return changed ? next : world
}
