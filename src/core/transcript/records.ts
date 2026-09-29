// One pure function per record `type` this parser understands (A5–A11 in PLAN.md §1.5), each
// taking the already-JSON-parsed record and returning the AgentEvent(s) it implies. parse.ts
// dispatches to these; nothing here touches the agent_meta bookkeeping, which parse.ts owns.

import type { AgentEvent, ErrorKind } from '../types.js'
import { toolActivity } from './tools.js'

export interface ParseCtx {
  agentId: string
}

export interface HandlerResult {
  events: AgentEvent[]
}

/** Record `type` values this parser knows about and deliberately does nothing with (A11):
 * cosmetic or bookkeeping records with no bearing on agent state. Anything not in this set and
 * not one of the handled types below (user, assistant, system, permission-mode, agent-name)
 * counts as an unknown type — a diagnostic, never a throw. */
export const IGNORED_TYPES = new Set([
  'attachment',
  'last-prompt',
  'mode',
  'atis-latch',
  'ai-title',
  'file-history-snapshot',
  'file-history-delta',
  'cost-state',
  'suggestion',
  'summary',
  'custom-title',
  'queue-operation',
  'progress',
])

/** system.subtype values that are known and deliberately ignored, alongside the three that
 * carry state (turn_duration, compact_boundary, api_error). */
const IGNORED_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'away_summary', 'local_command', 'informational'])

const INTERRUPT_TEXTS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])

const LOCAL_COMMAND_PREFIXES = ['<command-name>', '<local-command-stdout>', '<local-command-caveat>']

const API_ERROR_KIND_BY_FIELD: Record<string, ErrorKind> = {
  rate_limit: 'rate_limit',
  overloaded: 'overloaded',
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function messageContentText(message: unknown): string | undefined {
  const msg = asRecord(message)
  if (!msg) return undefined
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRecord(block)
      if (b?.type === 'text' && typeof b.text === 'string') return b.text
    }
  }
  return undefined
}

function toolResultBlocks(message: unknown): Record<string, unknown>[] {
  const msg = asRecord(message)
  const content = msg?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => asRecord(block)?.type === 'tool_result') as Record<string, unknown>[]
}

function classifyTerminalApiErrorKind(errorField: string | undefined, text: string | undefined): ErrorKind {
  if (errorField) return API_ERROR_KIND_BY_FIELD[errorField] ?? 'other'
  if (text) {
    if (/rate.?limit|usage limit|\b429\b/i.test(text)) return 'rate_limit'
    if (/overloaded|\b529\b/i.test(text)) return 'overloaded'
  }
  return 'other'
}

/** A6/A7/A10: a prompt, a tool result (possibly denied), an interruption, a skipped meta or
 * compaction-summary record, a skipped local-command echo, and/or a permissionMode carried
 * directly on a user record — a record can carry a permission_mode event alongside any of the
 * others, so this returns every event that applies rather than picking just one. */
export function fromUser(record: Record<string, unknown>, ctx: ParseCtx, ts: string): HandlerResult {
  const events: AgentEvent[] = []

  const permissionMode = typeof record.permissionMode === 'string' ? record.permissionMode : undefined
  if (permissionMode) events.push({ t: 'permission_mode', ts, agentId: ctx.agentId, mode: permissionMode })

  if (record.isMeta === true || record.isCompactSummary === true) return { events }

  const results = toolResultBlocks(record.message)
  if (results.length > 0) {
    const denied = typeof record.toolDenialKind === 'string' && record.toolDenialKind.length > 0
    for (const block of results) {
      events.push({
        t: 'tool_end',
        ts,
        agentId: ctx.agentId,
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
        isError: block.is_error === true,
        denied,
      })
    }
    return { events }
  }

  const text = messageContentText(record.message)
  if (text === undefined) return { events }
  if (INTERRUPT_TEXTS.has(text)) {
    events.push({ t: 'interrupted', ts, agentId: ctx.agentId })
    return { events }
  }
  if (LOCAL_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) return { events }

  events.push({ t: 'prompt', ts, agentId: ctx.agentId })
  return { events }
}

/** A5/A9: thinking/text/tool_use content blocks, end-of-turn detection from stop_reason, and
 * the terminal (isApiErrorMessage) shape of an API failure. The `<synthetic>` model is treated
 * as absent, never propagated. */
export function fromAssistant(record: Record<string, unknown>, ctx: ParseCtx, ts: string): HandlerResult {
  const message = asRecord(record.message)
  if (!message) return { events: [] }

  const rawModel = typeof message.model === 'string' ? message.model : undefined
  const model = rawModel && rawModel !== '<synthetic>' ? rawModel : undefined
  const content = Array.isArray(message.content) ? message.content : []
  const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : undefined
  const usage = asRecord(message.usage)
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined

  if (record.isApiErrorMessage === true) {
    const errorField = typeof record.error === 'string' ? record.error : undefined
    const text = messageContentText(record.message)
    return {
      events: [
        {
          t: 'api_error',
          ts,
          agentId: ctx.agentId,
          kind: classifyTerminalApiErrorKind(errorField, text),
          retrying: false,
          message: text ? text.slice(0, 200) : undefined,
        },
      ],
    }
  }

  const events: AgentEvent[] = []
  let hasThinking = false
  let hasText = false
  let hasToolUse = false

  for (const block of content) {
    const b = asRecord(block)
    if (!b) continue
    if (b.type === 'thinking') {
      hasThinking = true
    } else if (b.type === 'text') {
      hasText = true
    } else if (b.type === 'tool_use') {
      hasToolUse = true
      const name = typeof b.name === 'string' ? b.name : undefined
      const id = typeof b.id === 'string' ? b.id : undefined
      const input = asRecord(b.input) ?? {}
      if (name && id) {
        const activity = toolActivity(name, input)
        events.push({
          t: 'tool_start',
          ts,
          agentId: ctx.agentId,
          toolUseId: id,
          name,
          target: activity.target,
          ...(activity.state === 'delegating' ? { subagentType: activity.target } : {}),
        })
      }
    }
  }

  events.push({ t: 'assistant', ts, agentId: ctx.agentId, model, tokensOut: outputTokens, thinking: hasThinking, text: hasText })
  if (!hasToolUse && (stopReason === 'end_turn' || stopReason === 'stop_sequence')) {
    events.push({ t: 'turn_end', ts, agentId: ctx.agentId })
  }

  return { events }
}

export interface SystemHandlerResult {
  events: AgentEvent[]
  /** Set when `subtype` is missing or not one of the known values; parse.ts turns this into an
   * unparsed line, named `system:<subtype>`, rather than silently dropping it. */
  unknownSubtype?: string
}

/** A8: turn_duration (a turn-end signal), compact_boundary (a finished compaction) and the
 * retrying, system-level shape of an api_error (status/retryAttempt/maxRetries/retryInMs,
 * distinct from the terminal assistant-level shape in fromAssistant). */
export function fromSystem(record: Record<string, unknown>, ctx: ParseCtx, ts: string): SystemHandlerResult {
  const subtype = typeof record.subtype === 'string' ? record.subtype : undefined
  if (!subtype) return { events: [], unknownSubtype: '(missing)' }

  if (subtype === 'turn_duration') {
    return { events: [{ t: 'turn_end', ts, agentId: ctx.agentId }] }
  }
  if (subtype === 'compact_boundary') {
    const meta = asRecord(record.compactMetadata)
    const trigger = meta?.trigger === 'manual' ? 'manual' : meta?.trigger === 'auto' ? 'auto' : undefined
    return { events: [{ t: 'compaction', ts, agentId: ctx.agentId, trigger }] }
  }
  if (subtype === 'api_error') {
    const error = asRecord(record.error)
    const status = typeof error?.status === 'number' ? error.status : undefined
    const kind: ErrorKind = status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : 'other'
    return { events: [{ t: 'api_error', ts, agentId: ctx.agentId, kind, status, retrying: true }] }
  }
  if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) return { events: [] }

  return { events: [], unknownSubtype: subtype }
}

/** A10: a dedicated permission-mode record. */
export function fromPermissionMode(record: Record<string, unknown>, ctx: ParseCtx, ts: string): HandlerResult {
  const mode = typeof record.permissionMode === 'string' ? record.permissionMode : undefined
  return { events: mode ? [{ t: 'permission_mode', ts, agentId: ctx.agentId, mode }] : [] }
}

/** A11: a background worker's display label. */
export function fromAgentName(record: Record<string, unknown>, ctx: ParseCtx, ts: string): HandlerResult {
  const name = typeof record.agentName === 'string' ? record.agentName : undefined
  return { events: name ? [{ t: 'agent_meta', ts, agentId: ctx.agentId, label: name }] : [] }
}
