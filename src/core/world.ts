// Pure helpers over World, shared by the reducer (step 5) and its tests. No I/O: every
// timestamp is passed in by the caller.

import { MAX_COUNTED_NAMES, bump, countKey, isSafeKey } from './keys.js'
import { UNPARSED_REASONS, type Agent, type AgentState, type LogLine, type UnparsedBreakdown, type World } from './types.js'

export const MAX_LOG_LINES = 500
const MAX_SOURCE_ERRORS = 50

export function emptyWorld(nowIso: string, transcriptsRoot: string): World {
  return {
    agents: {},
    tasks: {},
    log: [],
    diagnostics: {
      unparsedLines: 0,
      unknownHookShapes: 0,
      sourceErrors: [],
      unknownTypes: {},
      versions: [],
      unparsedBy: {},
    },
    sources: {
      transcripts: {
        status: 'starting',
        root: transcriptsRoot,
        files: 0,
        inWindow: 0,
        windowHours: null,
      },
      hooks: { status: 'not_installed', events: 0 },
    },
    clock: nowIso,
  }
}

function newAgent(id: string, ts: string): Agent {
  return {
    id,
    kind: 'session',
    project: '',
    cwd: '',
    state: 'starting',
    stateSince: ts,
    lastActivity: ts,
    counters: { prompts: 0, tools: 0, compactions: 0, subagents: 0 },
    openTools: [],
  }
}

/** Inserts a default agent in 'starting' state if `id` is not present yet. Returns the same
 * World reference (not a copy) when the agent already exists, so callers can cheaply skip work
 * with `world === next`. */
export function ensureAgent(world: World, id: string, ts: string): World {
  if (!isSafeKey(id) || Object.hasOwn(world.agents, id)) return world
  return { ...world, agents: { ...world.agents, [id]: newAgent(id, ts) } }
}

/** Replaces one agent with the result of `update(agent)`. No-op (same World reference) if the
 * agent does not exist: callers that need one call ensureAgent first. */
export function updateAgent(world: World, id: string, update: (agent: Agent) => Agent): World {
  const agent = Object.hasOwn(world.agents, id) ? world.agents[id] : undefined
  if (!agent) return world
  return { ...world, agents: { ...world.agents, [id]: update(agent) } }
}

/** Sets an agent's state. `stateSince` only changes when the state actually changes, so
 * durations stay accurate across repeated events in the same state. Explicit calls always mark
 * the state 'observed'; only tick() marks a state 'inferred'. */
export function setState(
  world: World,
  id: string,
  state: AgentState,
  ts: string,
  evidence: 'observed' | 'inferred' = 'observed'
): World {
  return updateAgent(world, id, (agent) => ({
    ...agent,
    state,
    stateSince: agent.state === state ? agent.stateSince : ts,
    stateEvidence: evidence,
  }))
}

/** Appends one log line, dropping the oldest once the log exceeds MAX_LOG_LINES. */
export function pushLog(world: World, line: LogLine): World {
  const log = world.log.length >= MAX_LOG_LINES ? [...world.log.slice(1), line] : [...world.log, line]
  return { ...world, log }
}

/** Appends one diagnostics source error, dropping the oldest once the list exceeds the cap. */
export function pushSourceError(world: World, error: string): World {
  const sourceErrors =
    world.diagnostics.sourceErrors.length >= MAX_SOURCE_ERRORS
      ? [...world.diagnostics.sourceErrors.slice(1), error]
      : [...world.diagnostics.sourceErrors, error]
  return { ...world, diagnostics: { ...world.diagnostics, sourceErrors } }
}

/** Most distinct record-type names kept per reason; the rest are counted under '(other)'. */
export const MAX_UNPARSED_TYPE_NAMES = MAX_COUNTED_NAMES

/** Adds `add` into `into` (both reason -> type -> count) without mutating either. */
export function mergeUnparsedBy(into: UnparsedBreakdown, add: UnparsedBreakdown | undefined): UnparsedBreakdown {
  if (!add) return into
  const out: UnparsedBreakdown = { ...into }
  for (const reason of UNPARSED_REASONS) {
    const incoming = add[reason]
    if (!incoming) continue
    const types: Record<string, number> = { ...(out[reason] ?? {}) }
    for (const [type, count] of Object.entries(incoming)) {
      const name = countKey(type)
      const key = Object.hasOwn(types, name) || Object.keys(types).length < MAX_UNPARSED_TYPE_NAMES ? name : '(other)'
      bump(types, key, count)
    }
    out[reason] = types
  }
  return out
}

/** Adds a Claude Code version to the diagnostics' deduplicated version list, if new. */
export function noteVersion(world: World, version: string): World {
  const { versions } = world.diagnostics
  // At most MAX_COUNTED_NAMES distinct versions; the rest are one '(other)'.
  const name = versions.includes(version) || versions.length < MAX_COUNTED_NAMES ? version : '(other)'
  if (versions.includes(name)) return world
  return { ...world, diagnostics: { ...world.diagnostics, versions: [...versions, name] } }
}
