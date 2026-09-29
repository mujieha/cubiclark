// LOG.md lines of a task folder (docs/adapters.md, "The task-folder format"). Pure.
//
// Machine lines are `<ISO-UTC-timestamp> <verb> ...`, written by the orchestrator's scripts;
// note lines are `- <date> <time> ...` (local time), written by the orchestrator by hand. Every
// text that leaves this module has had its absolute paths reduced to their last segment and is
// capped, so no filesystem path reaches the page.

import type { TaskTimelineEntry, TaskTimelineKind } from '../types.js'

export const MAX_ENTRY_TEXT = 160

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MACHINE_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(\S+)\s*(.*)$/
const NOTE_LINE = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\s+(.*)$/

/** True for a full UUID, the only shape accepted as a session id. */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value)
}

/** Every path-looking token becomes its last segment (`/home/user/projects/demo` -> `demo`),
 * so a filesystem path never reaches the World. */
export function reducePaths(text: string): string {
  return text.replace(/(?<![A-Za-z0-9_.])(?:~|\.{1,2})?\/[^\s'"`,;)]+/g, (token) => {
    const last = token.split('/').filter((part) => part !== '' && part !== '~' && part !== '.' && part !== '..').pop()
    return last ?? token
  })
}

function cap(text: string): string {
  return text.length > MAX_ENTRY_TEXT ? `${text.slice(0, MAX_ENTRY_TEXT - 1)}…` : text
}

/** Path-reduced, whitespace-collapsed and capped: the form every entry text takes. */
export function cleanText(text: string): string {
  return cap(reducePaths(text).replace(/\s+/g, ' ').trim())
}

export type LogParse =
  | {
      kind: 'entry'
      entry: TaskTimelineEntry
      /** Valid session ids named on the line, in order. */
      sessions: string[]
      /** The session the line starts or continues (the dispatched, forked-to or resumed id). */
      currentSession?: string
      effort?: string
      /** The machine verb, or '' for a note line. */
      verb: string
      /** True for a machine verb this module has no rule for; the line still becomes a note. */
      unknownVerb: boolean
    }
  | { kind: 'skip' }
  | { kind: 'unparsed' }

interface KeyValues {
  model?: string
  effort?: string
  perms?: string
  compactions?: number
  /** The rest of the line without the key=value pairs and the (compactions=N) marker. */
  note: string
}

function keyValues(rest: string): KeyValues {
  const out: KeyValues = { note: rest }
  const model = /(?:^|\s)model=(\S+)/.exec(rest)
  const effort = /(?:^|\s)effort=(\S+)/.exec(rest)
  const perms = /(?:^|\s)perms=(\S+)/.exec(rest)
  const compactions = /\(compactions=(\d+)\)/.exec(rest)
  if (model) out.model = model[1]
  if (effort) out.effort = effort[1]
  if (perms) out.perms = perms[1]
  if (compactions) out.compactions = Number(compactions[1])
  out.note = rest
    .replace(/(?:^|\s)(?:model|effort|perms)=\S+/g, ' ')
    .replace(/\(compactions=\d+\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return out
}

function validSessions(...ids: (string | undefined)[]): string[] {
  return ids.filter((id): id is string => id !== undefined && isSessionId(id))
}

function machineEntry(ts: string, verb: string, rest: string): Extract<LogParse, { kind: 'entry' }> {
  const kv = keyValues(rest)
  const model = kv.model
  const base = { effort: kv.effort, verb }

  const entry = (kind: TaskTimelineKind, text: string, sessions: string[], currentSession: string | undefined, unknownVerb = false) => ({
    kind: 'entry' as const,
    entry: { ts, kind, ...(model ? { model } : {}), text: cleanText(text) },
    sessions,
    ...(currentSession ? { currentSession } : {}),
    ...(base.effort ? { effort: base.effort } : {}),
    verb: base.verb,
    unknownVerb,
  })

  switch (verb) {
    case 'dispatched': {
      const match = /^session\s+(\S+)\s+in\s+(\S+)/.exec(kv.note)
      const sessions = validSessions(match?.[1])
      const where = match?.[2] ? ` in ${match[2]}` : ''
      const perms = kv.perms ? ` (${kv.perms})` : ''
      return entry('dispatched', `dispatched${where}${perms}`, sessions, sessions[0])
    }
    case 'forked': {
      const match = /^(\S+)\s+->\s+(\S+)\s*(.*)$/.exec(kv.note)
      const sessions = validSessions(match?.[1], match?.[2])
      const after = kv.compactions && kv.compactions > 0 ? ` after ${kv.compactions} compaction${kv.compactions === 1 ? '' : 's'}` : ''
      const note = match?.[3] ? ` ${match[3]}` : ''
      const to = validSessions(match?.[2])[0]
      return entry('forked', `forked${after}${note}`, sessions, to)
    }
    case 'resumed': {
      const match = /^(\S+)\s*(.*)$/.exec(kv.note)
      const sessions = validSessions(match?.[1])
      const note = match?.[2] ? ` ${match[2]}` : ''
      return entry('resumed', `resumed${note}`, sessions, sessions[0])
    }
    case 'paused':
      return entry('paused', `paused ${rest}`, [], undefined)
    case 'verified': {
      const note = rest.replace(/^by orchestrator:?\s*/i, '').trim()
      return entry('done', note ? `verified: ${note}` : 'verified', [], undefined)
    }
    default:
      return entry('note', `${verb} ${rest}`, [], undefined, true)
  }
}

export function parseLogLine(line: string): LogParse {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#') || /^-{3,}$/.test(trimmed)) return { kind: 'skip' }

  const machine = MACHINE_LINE.exec(trimmed)
  if (machine) {
    const ts = machine[1] as string
    if (Number.isNaN(Date.parse(ts))) return { kind: 'unparsed' }
    return machineEntry(ts, machine[2] as string, machine[3] ?? '')
  }

  const note = NOTE_LINE.exec(trimmed)
  if (note) {
    const [year, month, day, hour, minute] = [note[1], note[2], note[3], note[4], note[5]].map(Number) as [number, number, number, number, number]
    // Local time: the orchestrator writes these by hand with its own clock.
    const date = new Date(year, month - 1, day, hour, minute)
    if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) return { kind: 'unparsed' }
    return {
      kind: 'entry',
      entry: { ts: date.toISOString(), kind: 'note', text: cleanText(note[6] ?? '') },
      sessions: [],
      verb: '',
      unknownVerb: false,
    }
  }
  return { kind: 'unparsed' }
}

export interface ParsedLog {
  entries: TaskTimelineEntry[]
  /** Unique, in the order first named. */
  sessions: string[]
  /** The session named by the latest line (by log order) that starts or continues one. */
  currentSession?: string
  effortBySession: Record<string, string>
  modelBySession: Record<string, string>
  /** The effort on the newest line that has one. */
  newestEffort?: string
  unparsed: number
  /** Machine verbs with no rule here, counted; at most 20 names. */
  unknownVerbs: Record<string, number>
}

export function parseLog(text: string): ParsedLog {
  const out: ParsedLog = { entries: [], sessions: [], effortBySession: {}, modelBySession: {}, unparsed: 0, unknownVerbs: {} }
  let newestEffortMs = Number.NEGATIVE_INFINITY

  for (const line of text.split('\n')) {
    const parsed = parseLogLine(line)
    if (parsed.kind === 'skip') continue
    if (parsed.kind === 'unparsed') {
      out.unparsed += 1
      continue
    }
    out.entries.push(parsed.entry)
    for (const id of parsed.sessions) if (!out.sessions.includes(id)) out.sessions.push(id)
    if (parsed.currentSession) {
      out.currentSession = parsed.currentSession
      if (parsed.effort) out.effortBySession[parsed.currentSession] = parsed.effort
      if (parsed.entry.model) out.modelBySession[parsed.currentSession] = parsed.entry.model
    }
    if (parsed.effort) {
      const ms = Date.parse(parsed.entry.ts)
      if (ms >= newestEffortMs) {
        newestEffortMs = ms
        out.newestEffort = parsed.effort
      }
    }
    if (parsed.unknownVerb && (parsed.verb in out.unknownVerbs || Object.keys(out.unknownVerbs).length < 20)) {
      out.unknownVerbs[parsed.verb] = (out.unknownVerbs[parsed.verb] ?? 0) + 1
    }
  }
  return out
}
