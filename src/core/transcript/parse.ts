// The parser's entry points. parseLine never throws: a line that is not JSON, not an object, or
// has no string `type`/`timestamp` becomes `unparsed: true` instead, with a reason and the record's
// type name so diagnostics can say *why* (never any value from the line). parseTranscript is the
// whole-file convenience the tests use; the transcript source (step 6) calls parseLine directly,
// one appended line at a time, carrying the returned ParseState forward itself.

import { isIsoInstant } from '../iso.js'
import type { AgentEvent, AgentKind, UnparsedBreakdown, UnparsedReason } from '../types.js'
import { TRANSCRIPT_GUESSES } from './guesses.js'
import { fromAgentName, fromAssistant, fromPermissionMode, fromSystem, fromUser, IGNORED_TYPES } from './records.js'

export interface ParseCtx {
  agentId: string
  kind: AgentKind
  parentId?: string
}

/** Per-file parser state, threaded through repeated parseLine calls by the caller. No module-
 * level state: two files being tailed at once never interfere with each other. */
export interface ParseState {
  seenFirst: boolean
  lastCwd?: string
  lastVersion?: string
  /** The newest record timestamp seen in this file (ISO); bookkeeping records that carry none
   * borrow it. */
  lastTs?: string
  /** Events of records that came before the file's first timestamp (at most MAX_PENDING), with
   * an empty `ts`, waiting for it. */
  pending?: AgentEvent[]
}

/** Most records held for the first timestamp; a further one is `no_timestamp` as before. */
export const MAX_PENDING = 16

export function initialParseState(): ParseState {
  return { seenFirst: false }
}

export interface ParseLineResult {
  events: AgentEvent[]
  state: ParseState
  unparsed: boolean
  /** Set only when unparsed is true and the cause was a recognizable but unhandled `type` (or
   * `system:<subtype>`), so diagnostics can be grouped by name instead of one flat counter. */
  unknownType?: string
  /** Set whenever unparsed is true: which rule rejected the line. */
  reason?: UnparsedReason
  /** True when the record was held for the file's first timestamp: no events yet, not unparsed. */
  deferred?: true
  /** Set whenever unparsed is true: the record's type name, `type:subtype` for system records,
   * '(invalid)' for a type that is not a plain name, '(none)' when there is no string type. */
  recordType?: string
}

const TYPE_NAME = /^[A-Za-z0-9_.:()-]{1,40}$/

/** The record's type as something safe to print and count: a name, never a value. */
export function recordTypeName(type: unknown, subtype?: unknown): string {
  if (typeof type !== 'string') return '(none)'
  const name = typeof subtype === 'string' && type === 'system' ? `${type}:${subtype}` : type
  return TYPE_NAME.test(name) ? name : '(invalid)'
}

const VERSION_NAME = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,24}$/

/** A Claude Code version as something safe to print: a version number, else '(invalid)'. */
export function versionName(version: string): string {
  return VERSION_NAME.test(version) ? version : '(invalid)'
}

/** A record's own timestamp as ISO: a string that is already an ISO instant (R4-3: Date.parse alone would
 * let a parenthesised comment of any length through), or a number (epoch seconds below 1e12, else ms).
 * Anything else, including a date that does not exist or one outside the years 0000-9999, is "no timestamp". */
export function recordTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') return isIsoInstant(value) ? value : undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const ms = value >= 1e12 ? value : value * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return undefined
  const iso = date.toISOString()
  return isIsoInstant(iso) ? iso : undefined
}

function unparsedLine(
  events: AgentEvent[],
  state: ParseState,
  reason: UnparsedReason,
  recordType: string,
  unknownType?: string
): ParseLineResult {
  return { events, state, unparsed: true, reason, recordType, ...(unknownType !== undefined ? { unknownType } : {}) }
}

export function parseLine(line: string, ctx: ParseCtx, state: ParseState): ParseLineResult {
  const trimmed = line.trim()
  if (trimmed.length === 0) return { events: [], state, unparsed: false }

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return unparsedLine([], state, 'not_json', '(none)')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return unparsedLine([], state, 'not_object', '(none)')
  }

  const record = value as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string') return unparsedLine([], state, 'no_type', '(none)')

  // Bookkeeping records (mode, last-prompt, permission-mode, ...) often carry no `timestamp`.
  // They borrow the newest one seen in this file; only a file that has shown none yet has
  // nothing to lend, and then only a record that needs a time (not an ignored type) is unparsed.
  const own = recordTimestamp(record.timestamp)
  const base: ParseState = own ? { ...state, lastTs: own } : state
  const ts = own ?? state.lastTs
  if (!ts) {
    if (IGNORED_TYPES.has(type)) return { events: [], state, unparsed: false }
    // A permission mode or an agent name that comes before the file has shown any time is kept
    // until the first timestamp arrives (the file's mtime would be the last write, later than the
    // events that follow), then emitted with it, in file order.
    const held = state.pending ?? []
    if ((type === 'permission-mode' || type === 'agent-name') && held.length < MAX_PENDING) {
      const early = type === 'permission-mode' ? fromPermissionMode(record, { agentId: ctx.agentId }, '') : fromAgentName(record, { agentId: ctx.agentId }, '')
      if (early.rejected) return unparsedLine([], state, 'handler_rejected', recordTypeName(type))
      return { events: [], state: { ...state, pending: [...held, ...early.events] }, unparsed: false, deferred: true }
    }
    return unparsedLine([], state, 'no_timestamp', recordTypeName(type, record.subtype))
  }

  const events: AgentEvent[] = []
  let nextState = base

  // A4: emit agent_meta on the first record of a file, and again whenever cwd or version
  // changes — cheap and idempotent for the reducer, and the only way project/version drift
  // becomes visible.
  const cwd = typeof record.cwd === 'string' ? record.cwd : undefined
  const version = typeof record.version === 'string' ? versionName(record.version) : undefined
  const isBackground = record.sessionKind === TRANSCRIPT_GUESSES.backgroundSessionKind
  const cwdChanged = cwd !== undefined && cwd !== state.lastCwd
  const versionChanged = version !== undefined && version !== state.lastVersion
  // A borrowed timestamp never starts a file: agent_meta waits for a record with its own time.
  if ((!state.seenFirst && own !== undefined) || (state.seenFirst && (cwdChanged || versionChanged))) {
    events.push({
      t: 'agent_meta',
      ts,
      agentId: ctx.agentId,
      kind: isBackground ? 'background' : ctx.kind,
      parentId: ctx.parentId,
      cwd,
      version,
    })
    nextState = {
      ...nextState,
      seenFirst: true,
      lastCwd: cwd ?? state.lastCwd,
      lastVersion: version ?? state.lastVersion,
    }
  }

  // The records that waited for a time come out now, right after the agent_meta of the record
  // that gave it, and before that record's own events.
  if (own !== undefined && state.pending !== undefined && state.pending.length > 0) {
    for (const held of state.pending) events.push({ ...held, ts })
    nextState = { ...nextState, pending: [] }
  }

  const handlerCtx = { agentId: ctx.agentId }
  const rejected =(): ParseLineResult => unparsedLine(events, nextState, 'handler_rejected', recordTypeName(type))

  switch (type) {
    case 'user': {
      const result = fromUser(record, handlerCtx, ts)
      events.push(...result.events)
      if (result.rejected) return rejected()
      break
    }
    case 'assistant': {
      const result = fromAssistant(record, handlerCtx, ts)
      events.push(...result.events)
      if (result.rejected) return rejected()
      break
    }
    case 'system': {
      const result = fromSystem(record, handlerCtx, ts)
      if (result.unknownSubtype !== undefined) {
        // The printable name, never the raw subtype: it is printed by doctor and kept in the World.
        const name = recordTypeName('system', result.unknownSubtype)
        return unparsedLine(events, nextState, 'unknown_subtype', name, name)
      }
      events.push(...result.events)
      break
    }
    case 'permission-mode': {
      const result = fromPermissionMode(record, handlerCtx, ts)
      events.push(...result.events)
      if (result.rejected) return rejected()
      break
    }
    case 'agent-name':
      events.push(...fromAgentName(record, handlerCtx, ts).events)
      break
    default:
      if (!IGNORED_TYPES.has(type)) {
        return unparsedLine(events, nextState, 'unknown_type', recordTypeName(type), recordTypeName(type))
      }
  }

  return { events, state: nextState, unparsed: false }
}

export interface TranscriptParseResult {
  events: AgentEvent[]
  unparsed: number
  unknownTypes: Record<string, number>
  unparsedBy: UnparsedBreakdown
  versions: string[]
  /** Held records that never got a timestamp (a file with none shows no agent anyway); not unparsed. */
  deferred: number
}

/** Parses a whole transcript file's text in one call, for tests and the initial-scan path.
 * Blank lines are skipped without affecting the unparsed count. */
export function parseTranscript(text: string, ctx: ParseCtx): TranscriptParseResult {
  let state = initialParseState()
  const events: AgentEvent[] = []
  let unparsed = 0
  const unknownTypes: Record<string, number> = {}
  const unparsedBy: UnparsedBreakdown = {}

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const result = parseLine(line, ctx, state)
    state = result.state
    events.push(...result.events)
    if (result.unparsed) {
      unparsed += 1
      if (result.unknownType !== undefined) {
        unknownTypes[result.unknownType] = (unknownTypes[result.unknownType] ?? 0) + 1
      }
      if (result.reason !== undefined && result.recordType !== undefined) {
        const byType = (unparsedBy[result.reason] ??= {})
        byType[result.recordType] = (byType[result.recordType] ?? 0) + 1
      }
    }
  }

  const versions = new Set<string>()
  for (const event of events) {
    if (event.t === 'agent_meta' && event.version) versions.add(event.version)
  }

  return { events, unparsed, unknownTypes, unparsedBy, versions: [...versions], deferred: state.pending?.length ?? 0 }
}
