// The orchestration adapter interface (design §4, binding) and the snapshot every adapter
// returns. Pure types plus mergeSnapshots: no fs, no processes, no clock (docs/adapters.md).

import type { AgentRole, CliSessionInfo, Task } from '../types.js'

export interface AdapterEnv {
  /** The clock the World runs on: the real one, a fixture's frozen one, or a replay's. */
  nowMs: () => number
  /** Real time (or the end of a fixture replay), when `nowMs` is not it. Only used to clamp a file's
   * modification time, so that a replay does not date every STATUS.md entry at the replay clock. */
  wallMs?: () => number
  /** Only for expanding `~` in configured paths. */
  home: string
}

/** One line of a quota samples file, once parsed. Times are ISO strings. */
export interface QuotaSample {
  ts: string
  p5h?: number
  p7d?: number
  resets5h?: string
  resets7d?: string
}

/** A session `claude agents --json` reported. `cwd` is kept for matching on the server only. */
export interface CliSession extends Omit<CliSessionInfo, 'fetchedAt'> {
  sessionId?: string
  cwd?: string
  startedAt?: string
}

/** A session (an agent id) that belongs to a task, with what the task says about it. */
export interface AgentLink {
  agentId: string
  taskId: string
  role?: AgentRole
  effort?: string
  model?: string
}

export interface AdapterSnapshot {
  tasks?: Task[]
  links?: AgentLink[]
  /** Top-level sessions whose cwd equals one of these are orchestrators. */
  orchestratorCwds?: string[]
  /** Sorted by ts, oldest first. */
  quotaSamples?: QuotaSample[]
  cliSessions?: CliSession[]
  cliFetchedAt?: string
  diagnostics: { unparsed: number; errors: string[] }
}

/** design §4. */
export interface OrchestrationAdapter {
  readonly id: string
  /** How often the host asks for a new snapshot when nothing was watched to change. */
  readonly pollMs: number
  /** Cheap; never throws; false when the source is absent. */
  detect(env: AdapterEnv): Promise<boolean>
  snapshot(): Promise<AdapterSnapshot>
  /** Optional file watching; returns the unsubscribe function. Never throws. */
  watch?(onChange: () => void): () => void
  /** Optional: one line for the status bar and `doctor --adapters`, from the last snapshot. */
  describe?(nowMs: number): AdapterDescription
}

export interface AdapterDescription {
  detail: string
  /** True when the last snapshot could not do its job (the adapter then shows as failing). */
  failing?: boolean
}

export function emptySnapshot(): AdapterSnapshot {
  return { diagnostics: { unparsed: 0, errors: [] } }
}

/** Combines the latest snapshot of each adapter into the one the World is built from. */
export function mergeSnapshots(parts: readonly AdapterSnapshot[]): AdapterSnapshot {
  const out: AdapterSnapshot = emptySnapshot()
  const tasks: Task[] = []
  const links: AgentLink[] = []
  const cwds = new Set<string>()
  const samples: QuotaSample[] = []
  const sessions: CliSession[] = []
  let anyTasks = false
  let anySamples = false
  let anySessions = false

  for (const part of parts) {
    if (part.tasks) {
      anyTasks = true
      tasks.push(...part.tasks)
    }
    if (part.links) links.push(...part.links)
    for (const cwd of part.orchestratorCwds ?? []) cwds.add(cwd)
    if (part.quotaSamples) {
      anySamples = true
      samples.push(...part.quotaSamples)
    }
    if (part.cliSessions) {
      anySessions = true
      sessions.push(...part.cliSessions)
    }
    if (part.cliFetchedAt !== undefined && out.cliFetchedAt === undefined) out.cliFetchedAt = part.cliFetchedAt
    out.diagnostics.unparsed += part.diagnostics.unparsed
    out.diagnostics.errors.push(...part.diagnostics.errors)
  }

  // An adapter that is live and has no tasks says so with [], which clears the World's tasks.
  if (anyTasks) out.tasks = tasks
  if (links.length > 0) out.links = links
  if (cwds.size > 0) out.orchestratorCwds = [...cwds]
  if (anySamples) out.quotaSamples = samples.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  if (anySessions) out.cliSessions = sessions
  return out
}
