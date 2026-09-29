// The data model (design §5, binding for this phase) plus the additions this phase needs,
// each marked NEW. Nothing here does I/O: no fs, no http, no Date.now(). Time always arrives as
// an argument, so every function below stays pure and testable without a clock or a filesystem.

import type { AssetsStatus } from './assets/status.js'

export type AgentKind = 'session' | 'background' | 'subagent' | 'teammate'

// The 16 states from design §6. Not every state is reachable from transcripts alone in this
// phase; see PLAN.md §1.6 for which ones are and README's Known limits for which are not.
export const AGENT_STATES = [
  'starting',
  'thinking',
  'reading',
  'editing',
  'running',
  'searching',
  'browsing',
  'delegating',
  'waiting_permission',
  'waiting_user',
  'compacting',
  'stuck',
  'rate_limited',
  'failed',
  'finished',
  'ended',
] as const

export type AgentState = (typeof AGENT_STATES)[number]

export type AgentRole = 'orchestrator' | 'planner' | 'builder' | 'reviewer' | 'explorer' | 'other'

export interface CurrentTool {
  name: string
  target?: string
}

export interface OpenTool {
  id: string
  name: string
  target?: string
  since: string
}

export type ErrorKind = 'rate_limit' | 'overloaded' | 'other'

export interface AgentError {
  kind: ErrorKind
  status?: number
  /** API error text only, never prompt or tool content; capped at 200 characters by the parser. */
  message?: string
}

export interface AgentCounters {
  prompts: number
  tools: number
  compactions: number
  subagents: number
  tokensOut?: number
}

/** Set once any hook event has been seen for an agent (phase 2). `lastTs` is the newest hook
 * timestamp; `tools` says whether PreToolUse/PostToolUse events are being recorded for it. */
export interface AgentHooked {
  lastTs: string
  tools: boolean
}

export interface Agent {
  id: string
  kind: AgentKind
  parentId?: string
  project: string
  cwd: string
  model?: string
  effort?: string
  role?: AgentRole
  taskId?: string
  state: AgentState
  stateSince: string
  lastActivity: string
  currentTool?: CurrentTool
  counters: AgentCounters
  // NEW, all optional so design §5 still holds as a subset of this shape.
  /** Subagent agentType ("Explore") or background agent-name; never prompt text. */
  label?: string
  /** 'inferred' only for the transcript-side permission wait (PLAN.md §1.6). */
  stateEvidence?: 'observed' | 'inferred'
  /** Last permission mode seen on this agent's transcript, e.g. 'default' | 'bypassPermissions'. */
  permissionMode?: string
  /** Subagent only: the parent's Agent/Task tool_use id, from the sidecar meta file. */
  spawnToolUseId?: string
  /** Tool calls with no matching result yet, oldest first. */
  openTools: OpenTool[]
  error?: AgentError
  // NEW in phase 2.
  /** Present once a hook event was seen for this agent: hooks then own timing (PLAN.md §2.6). */
  hooked?: AgentHooked
  /** The newest 64 tool ids already closed, so a late duplicate tool_start cannot reopen one. */
  closedToolIds?: string[]
  // NEW in phase 4.
  /** What `claude agents --json` last said about this session (the claude-agents adapter). */
  cli?: CliSessionInfo
}

/** One session as `claude agents --json` reports it. Only whitelisted fields, capped at 40 characters. */
export interface CliSessionInfo {
  kind?: 'interactive' | 'background'
  /** working | blocked | done | failed | stopped, or 'other' for a value not in the docs. */
  state?: string
  /** busy | waiting | idle */
  status?: string
  waitingFor?: string
  name?: string
  /** ISO time of the fetch this came from. */
  fetchedAt: string
}

export type TaskPhase = 'planning' | 'building' | 'review' | 'done' | 'blocked'

export type TaskTimelineKind =
  | 'dispatched'
  | 'resumed'
  | 'forked'
  | 'paused'
  | 'planned'
  | 'pr'
  | 'merged'
  | 'done'
  | 'blocked'
  | 'note'

export interface TaskTimelineEntry {
  ts: string
  kind: TaskTimelineKind
  model?: string
  text: string
}

// Filled in by the task-folders adapter (phase 4); design §5 plus the fields the HUD shows.
export interface Task {
  id: string
  phase?: TaskPhase
  timeline: TaskTimelineEntry[]
  // NEW in phase 4, all optional.
  /** The adapter id that produced it, e.g. 'task-folders'. */
  source?: string
  /** TASK.md `Goal:`, reduced to names (no absolute paths) and capped at 160 characters. */
  title?: string
  /** Basename of TASK.md `Project:`. */
  project?: string
  /** The newest model named in LOG.md, else TASK.md `Model:`. */
  model?: string
  /** TASK.md `PlanModel:`. */
  planModel?: string
  effort?: string
  /** Every session id named in LOG.md or the `session` file, oldest first. */
  sessionIds?: string[]
  currentSessionId?: string
  pr?: number
  /** The newest timeline timestamp. */
  lastActivity?: string
}

export interface LogLine {
  ts: string
  agentId: string
  kind: string
  /** Never holds prompt or tool content; capped at 500 lines total in the World. */
  text: string
}

/** Why a transcript line was not turned into events. Names only, never values. */
export const UNPARSED_REASONS = [
  'not_json',
  'not_object',
  'no_type',
  'no_timestamp',
  'unknown_type',
  'unknown_subtype',
  'handler_rejected',
  /** NEW in phase 5: a line longer than the tailer's cap, dropped without being parsed. */
  'too_long',
] as const

export type UnparsedReason = (typeof UNPARSED_REASONS)[number]

/** reason -> record type ('(none)' when there is no string type) -> count. */
export type UnparsedBreakdown = Partial<Record<UnparsedReason, Record<string, number>>>

export interface Diagnostics {
  unparsedLines: number
  unknownHookShapes: number
  /** Capped at 50 entries; oldest dropped first. */
  sourceErrors: string[]
  /** NEW: 'future-thing' or 'system:weird_subtype' -> count, so drift is visible by name. */
  unknownTypes: Record<string, number>
  /** NEW: distinct Claude Code versions seen in transcript records, a format-drift signal. */
  versions: string[]
  /** NEW in phase 4: the unparsed lines by reason, then by record type. */
  unparsedBy: UnparsedBreakdown
}

export interface TranscriptSourceStatus {
  status: 'starting' | 'live' | 'unreadable'
  root: string
  error?: string
  /** Transcript files found under root, ignoring the age window. */
  files: number
  /** Of those, files inside the window (the ones actually read). */
  inWindow: number
  /** null in fixture mode, where the window is disabled. */
  windowHours: number | null
}

export interface HooksSourceStatus {
  status: 'not_installed' | 'live' | 'failing'
  reason?: string
  eventsFile?: string
  /** Stored lines read so far this run. */
  events: number
  lastEventTs?: string
  /** Whether tool events are being recorded (`hooks on --no-tools` turns them off). */
  tools?: boolean
  paused?: boolean
}

/** What `hooks status` and `doctor` learn by looking at the settings file and the state dir. */
export interface HooksInspection {
  settingsPath: string
  settingsState: 'absent' | 'ok' | 'unparseable'
  parseError?: string
  events: string[]
  tools: boolean
  collectorPath?: string
  collectorExists: boolean
  paused: boolean
  eventsFile: string
  eventsBytes?: number
  lastEventTs?: string
}

/** One orchestration adapter's health, for the status bar and `doctor --adapters`. */
export interface AdapterStatus {
  /** 'task-folders' | 'quota-samples' | 'claude-agents' */
  id: string
  /** off: not configured. missing: configured, source absent. live: working. failing: last snapshot failed. */
  status: 'off' | 'missing' | 'live' | 'failing'
  detail: string
  lastSnapshotAt?: string
}

// NEW: drives the four empty screens (design §3.1, PLAN.md §1.9).
export interface SourcesStatus {
  transcripts: TranscriptSourceStatus
  hooks: HooksSourceStatus
  /** NEW in phase 4: one entry per known adapter, once the host has started. */
  adapters?: AdapterStatus[]
  /** NEW in phase 5: the custom-assets manifest, when there is one. */
  assets?: AssetsStatus
}

export interface Quota {
  p5h: number
  p7d: number
  resets5h?: string
  resets7d?: string
  /** NEW in phase 4: the time of the sample this came from. */
  sampledAt?: string
}

/** Set only by `cubiclark replay`. */
export interface ReplayInfo {
  sinceTs: string
  endTs: string
  speed: number
  done: boolean
}

export interface World {
  agents: Record<string, Agent>
  tasks: Record<string, Task>
  log: LogLine[]
  quota?: Quota
  diagnostics: Diagnostics
  // NEW
  sources: SourcesStatus
  /** NEW: ISO time of the last tick; the page computes "since" against this, not wall time. */
  clock: string
  /** NEW in phase 4: present only while replaying. */
  replay?: ReplayInfo
}

// AgentEvent: the one normalised shape produced by the transcript parser (and, in phase 2, by
// the hook source). ts is the ISO timestamp of the originating record.

export interface AgentMetaEvent {
  t: 'agent_meta'
  ts: string
  agentId: string
  kind?: AgentKind
  parentId?: string
  cwd?: string
  label?: string
  version?: string
}

export interface SubagentLinkEvent {
  t: 'subagent_link'
  ts: string
  agentId: string
  parentId: string
  spawnToolUseId?: string
  agentType?: string
  name?: string
}

export interface PromptEvent {
  t: 'prompt'
  ts: string
  agentId: string
}

export interface AssistantEvent {
  t: 'assistant'
  ts: string
  agentId: string
  model?: string
  tokensOut?: number
  thinking: boolean
  text: boolean
  /** Model and token counts only, never a state change: set by the merge gate for a hooked agent. */
  fillOnly?: boolean
}

export interface ToolStartEvent {
  t: 'tool_start'
  ts: string
  agentId: string
  toolUseId: string
  name: string
  target?: string
  subagentType?: string
}

export interface ToolEndEvent {
  t: 'tool_end'
  ts: string
  agentId: string
  toolUseId: string
  isError: boolean
  denied: boolean
}

export interface TurnEndEvent {
  t: 'turn_end'
  ts: string
  agentId: string
}

export interface InterruptedEvent {
  t: 'interrupted'
  ts: string
  agentId: string
}

export interface CompactionEvent {
  t: 'compaction'
  ts: string
  agentId: string
  trigger?: 'auto' | 'manual'
}

export interface ApiErrorEvent {
  t: 'api_error'
  ts: string
  agentId: string
  kind: ErrorKind
  status?: number
  retrying: boolean
  message?: string
}

export interface PermissionModeEvent {
  t: 'permission_mode'
  ts: string
  agentId: string
  mode: string
}

export interface DiagnosticsEvent {
  t: 'diagnostics'
  ts: string
  unparsed: number
  unknownTypes: Record<string, number>
  versions: string[]
  sourceError?: string
  unknownHookShapes?: number
  unparsedBy?: UnparsedBreakdown
}

// Hook-sourced events (phase 2), produced by core/hooks/normalise.ts.

export interface HookSeenEvent {
  t: 'hook_seen'
  ts: string
  agentId: string
  /** True for the tool events, meaning this agent's tool activity is recorded by hooks. */
  tools: boolean
  kind?: 'subagent'
  parentId?: string
  cwd?: string
  effort?: string
  permissionMode?: string
}

export interface SessionStartEvent {
  t: 'session_start'
  ts: string
  agentId: string
  source: string
  model?: string
}

export interface SessionEndEvent {
  t: 'session_end'
  ts: string
  agentId: string
  reason?: string
}

export interface PermissionWaitEvent {
  t: 'permission_wait'
  ts: string
  agentId: string
  toolName?: string
}

export interface CompactingEvent {
  t: 'compacting'
  ts: string
  agentId: string
  trigger?: 'auto' | 'manual'
}

export interface CompactedEvent {
  t: 'compacted'
  ts: string
  agentId: string
  trigger?: 'auto' | 'manual'
}

/** NEW in phase 5: the model of a running session changed (the PostModelSwitch hook). */
export interface ModelChangedEvent {
  t: 'model_changed'
  ts: string
  agentId: string
  model: string
}

export type AgentEvent =
  | AgentMetaEvent
  | SubagentLinkEvent
  | PromptEvent
  | AssistantEvent
  | ToolStartEvent
  | ToolEndEvent
  | TurnEndEvent
  | InterruptedEvent
  | CompactionEvent
  | ApiErrorEvent
  | PermissionModeEvent
  | DiagnosticsEvent
  | HookSeenEvent
  | SessionStartEvent
  | SessionEndEvent
  | PermissionWaitEvent
  | CompactingEvent
  | CompactedEvent
  | ModelChangedEvent
