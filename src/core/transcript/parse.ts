// The parser's entry points. parseLine never throws: a line that is not JSON, not an object, or
// has no string `type`/`timestamp` becomes `unparsed: true` instead. parseTranscript is the
// whole-file convenience the tests use; the transcript source (step 6) calls parseLine directly,
// one appended line at a time, carrying the returned ParseState forward itself.

import type { AgentEvent, AgentKind } from '../types.js'
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
}

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
}

export function parseLine(line: string, ctx: ParseCtx, state: ParseState): ParseLineResult {
  const trimmed = line.trim()
  if (trimmed.length === 0) return { events: [], state, unparsed: false }

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { events: [], state, unparsed: true }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { events: [], state, unparsed: true }
  }

  const record = value as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string') return { events: [], state, unparsed: true }

  const ts = typeof record.timestamp === 'string' ? record.timestamp : undefined
  if (!ts) return { events: [], state, unparsed: true }

  const events: AgentEvent[] = []
  let nextState = state

  // A4: emit agent_meta on the first record of a file, and again whenever cwd or version
  // changes — cheap and idempotent for the reducer, and the only way project/version drift
  // becomes visible.
  const cwd = typeof record.cwd === 'string' ? record.cwd : undefined
  const version = typeof record.version === 'string' ? record.version : undefined
  const isBackground = record.sessionKind === TRANSCRIPT_GUESSES.backgroundSessionKind
  const cwdChanged = cwd !== undefined && cwd !== state.lastCwd
  const versionChanged = version !== undefined && version !== state.lastVersion
  if (!state.seenFirst || cwdChanged || versionChanged) {
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
      seenFirst: true,
      lastCwd: cwd ?? state.lastCwd,
      lastVersion: version ?? state.lastVersion,
    }
  }

  const handlerCtx = { agentId: ctx.agentId }

  switch (type) {
    case 'user':
      events.push(...fromUser(record, handlerCtx, ts).events)
      break
    case 'assistant':
      events.push(...fromAssistant(record, handlerCtx, ts).events)
      break
    case 'system': {
      const result = fromSystem(record, handlerCtx, ts)
      if (result.unknownSubtype !== undefined) {
        return { events, state: nextState, unparsed: true, unknownType: `system:${result.unknownSubtype}` }
      }
      events.push(...result.events)
      break
    }
    case 'permission-mode':
      events.push(...fromPermissionMode(record, handlerCtx, ts).events)
      break
    case 'agent-name':
      events.push(...fromAgentName(record, handlerCtx, ts).events)
      break
    default:
      if (!IGNORED_TYPES.has(type)) {
        return { events, state: nextState, unparsed: true, unknownType: type }
      }
  }

  return { events, state: nextState, unparsed: false }
}

export interface TranscriptParseResult {
  events: AgentEvent[]
  unparsed: number
  unknownTypes: Record<string, number>
  versions: string[]
}

/** Parses a whole transcript file's text in one call, for tests and the initial-scan path.
 * Blank lines are skipped without affecting the unparsed count. */
export function parseTranscript(text: string, ctx: ParseCtx): TranscriptParseResult {
  let state = initialParseState()
  const events: AgentEvent[] = []
  let unparsed = 0
  const unknownTypes: Record<string, number> = {}

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
    }
  }

  const versions = new Set<string>()
  for (const event of events) {
    if (event.t === 'agent_meta' && event.version) versions.add(event.version)
  }

  return { events, unparsed, unknownTypes, versions: [...versions] }
}
