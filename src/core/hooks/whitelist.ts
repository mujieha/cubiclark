// The collector's whitelist (design §5, PLAN.md phase 2 §2.2): what may reach disk from a hook
// payload. Every stored field is an id or name matched by a strict pattern, a value from a fixed
// enum, or a reduced target (file basename, command verb, URL host, subagent type). Prompt text,
// tool inputs and outputs, error text, assistant text and every unknown field are dropped, and a
// value that fails its rule is dropped rather than stored.
//
// This file is copied next to the collector by `hooks on`, so its only import is the pure
// tool-target reducer (test/collector-imports.test.ts enforces that).

import { hasControlChar, toolActivity } from '../transcript/tools.js'

/** The Claude Code version whose hooks reference was last checked against these 15 events and the fields
 * read below (checked 2026-10-03 on 2.1.288; `doctor` says so, and says when the installed one differs). */
export const HOOK_EVENTS_VERIFIED_ON = '2.1.288'

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  // Live model changes (hooks reference, checked 2026-09-30): fires after the model changed,
  // with `from_model` and `to_model`; it cannot block. Only `to_model` is stored.
  // `PreModelSwitch` is deliberately NOT installed: a hook on it can block a model switch, and a
  // hook that times out there blocks it (design §3.3: it never interferes with Claude Code).
  'PostModelSwitch',
  'SessionEnd',
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

export const TOOL_HOOK_EVENTS: readonly HookEventName[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']

export const LIFECYCLE_HOOK_EVENTS: readonly HookEventName[] = HOOK_EVENT_NAMES.filter(
  (name) => !TOOL_HOOK_EVENTS.includes(name)
)

/** Installed without `async`: they fire near teardown, where an async hook may be killed. */
export const SYNC_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  'Stop',
  'StopFailure',
  'SubagentStop',
  'SessionEnd',
])

export const SESSION_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const
export const SESSION_END_REASONS = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] as const
export const STOP_FAILURE_ERRORS = [
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'cloud_credential_error',
  'unknown',
] as const
export const NOTIFICATION_TYPES = [
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'elicitation_complete',
  'elicitation_response',
  'agent_needs_input',
  'agent_completed',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
] as const
export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const COMPACT_TRIGGERS = ['manual', 'auto'] as const

export type SessionSource = (typeof SESSION_SOURCES)[number]
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]
export type StopFailureError = (typeof STOP_FAILURE_ERRORS)[number]
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** One line of events.jsonl. Keys are written in this order and only these keys exist. */
export interface StoredLine {
  v: 1
  /** ISO time, taken when the collector started (no payload carries a timestamp). */
  ts: string
  /** One of HOOK_EVENT_NAMES, or '_malformed' | '_unknown'. */
  e: string
  /** Only on '_unknown': the event name, when it looks like one. */
  name?: string
  sid?: string
  aid?: string
  at?: string
  cwd?: string
  tool?: string
  tuid?: string
  target?: string
  src?: SessionSource
  model?: string
  reason?: SessionEndReason
  trig?: 'manual' | 'auto'
  err?: StopFailureError
  nt?: NotificationType
  pm?: PermissionMode
  eff?: EffortLevel
  intr?: true
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const MODEL_RE = /^[A-Za-z0-9_.:[\]-]{1,100}$/
const EVENT_NAME_RE = /^[A-Za-z]{1,40}$/
const MAX_CWD = 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

function oneOf<T extends string>(value: unknown, list: readonly T[]): T | undefined {
  return typeof value === 'string' ? list.find((item) => item === value) : undefined
}

function isHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(name)
}

/** Strips one leading `agent-`: the hook payload and the transcript file name use both spellings. */
export function normaliseAgentId(raw: string): string {
  return raw.startsWith('agent-') ? raw.slice('agent-'.length) : raw
}

function safeCwd(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CWD) return undefined
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
  return absolute && !hasControlChar(value) ? value : undefined
}

/** Never throws. `payload` is whatever JSON.parse returned, or undefined when stdin did not parse. */
export function toStoredLine(payload: unknown, tsIso: string): StoredLine {
  if (!isRecord(payload)) return { v: 1, ts: tsIso, e: '_malformed' }

  const rawEvent = payload.hook_event_name
  if (typeof rawEvent !== 'string' || !isHookEvent(rawEvent)) {
    const name = typeof rawEvent === 'string' && EVENT_NAME_RE.test(rawEvent) ? rawEvent : undefined
    return name ? { v: 1, ts: tsIso, e: '_unknown', name } : { v: 1, ts: tsIso, e: '_unknown' }
  }
  const event: HookEventName = rawEvent
  const line: StoredLine = { v: 1, ts: tsIso, e: event }

  const sid = matching(payload.session_id, ID_RE)
  if (sid) line.sid = sid

  const aid = typeof payload.agent_id === 'string' ? matching(normaliseAgentId(payload.agent_id), ID_RE) : undefined
  if (aid) line.aid = aid

  const at = matching(payload.agent_type, NAME_RE)
  if (at) line.at = at

  const cwd = safeCwd(payload.cwd)
  if (cwd) line.cwd = cwd

  const isToolEvent = TOOL_HOOK_EVENTS.includes(event) || event === 'PermissionRequest'
  if (isToolEvent) {
    const tool = matching(payload.tool_name, NAME_RE)
    if (tool) {
      line.tool = tool
      const input = isRecord(payload.tool_input) ? payload.tool_input : {}
      const target = toolActivity(tool, input).target // already through safeTarget (src/core/transcript/tools.ts)
      const tuid = matching(payload.tool_use_id, ID_RE)
      if (tuid) line.tuid = tuid
      if (target) line.target = target
    } else {
      const tuid = matching(payload.tool_use_id, ID_RE)
      if (tuid) line.tuid = tuid
    }
  }

  if (event === 'SessionStart') {
    const src = oneOf(payload.source, SESSION_SOURCES)
    if (src) line.src = src
    const model = matching(payload.model, MODEL_RE)
    if (model) line.model = model
  }

  if (event === 'PostModelSwitch') {
    const model = matching(payload.to_model, MODEL_RE)
    if (model) line.model = model
  }

  if (event === 'SessionEnd' && typeof payload.reason === 'string') {
    line.reason = oneOf(payload.reason, SESSION_END_REASONS) ?? 'other'
  }

  if (event === 'PreCompact' || event === 'PostCompact') {
    const trig = oneOf(payload.trigger, COMPACT_TRIGGERS)
    if (trig) line.trig = trig
  }

  // The hooks reference now shows the StopFailure payload: the error is `error` (checked on 2.1.288, with
  // `error_details` and `last_assistant_message` beside it, neither stored). `error_type`, the spelling an
  // older reference gave for the matcher, is still read as a fallback; only a value from the fixed enum is kept.
  const stopError = typeof payload.error === 'string' ? payload.error : payload.error_type
  if (event === 'StopFailure' && typeof stopError === 'string') {
    line.err = oneOf(stopError, STOP_FAILURE_ERRORS) ?? 'unknown'
  }

  if (event === 'Notification') {
    const nt = oneOf(payload.notification_type, NOTIFICATION_TYPES)
    if (nt) line.nt = nt
  }

  const pm = oneOf(payload.permission_mode, PERMISSION_MODES)
  if (pm) line.pm = pm

  const eff = isRecord(payload.effort) ? oneOf(payload.effort.level, EFFORT_LEVELS) : undefined
  if (eff) line.eff = eff

  if (event === 'PostToolUseFailure' && payload.is_interrupt === true) line.intr = true

  return line
}

export function serialiseStoredLine(line: StoredLine): string {
  return JSON.stringify(line) + '\n'
}
