// Pure edits to Claude Code's settings.json for `hooks on` / `hooks off` (PLAN.md phase 2 §2.4).
// No I/O here: text in, text or objects out, so every guarantee (only our entries are touched,
// adding twice adds once, remove undoes add) is tested without a filesystem.

import { HOOK_EVENT_NAMES, SYNC_HOOK_EVENTS, TOOL_HOOK_EVENTS, type HookEventName } from './whitelist.js'

/** File name of the installed collector copy. "Ours" is decided by this basename alone. */
export const COLLECTOR_BASENAME = 'cubiclark-collector.js'

export interface CollectorHandler {
  type: 'command'
  command: 'node'
  args: string[]
  async?: true
  timeout: number
}

export class SettingsParseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A JSON object whose `hooks` (if present) is an object of arrays of objects; anything else
 * throws SettingsParseError, and the caller refuses to touch the file. */
export function parseSettings(text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new SettingsParseError(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(value)) throw new SettingsParseError('the top level is not a JSON object')

  const hooks = value.hooks
  if (hooks !== undefined) {
    if (!isRecord(hooks)) throw new SettingsParseError('"hooks" is not an object')
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) throw new SettingsParseError(`hooks.${event} is not an array`)
      for (const group of groups) {
        if (!isRecord(group)) throw new SettingsParseError(`hooks.${event} holds something that is not an object`)
        if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
          throw new SettingsParseError(`a hooks.${event} group has a "hooks" that is not an array`)
        }
      }
    }
  }
  return value
}

export interface SettingsFormat {
  indent: string
  eol: '\n' | '\r\n'
  trailingNewline: boolean
}

const DEFAULT_FORMAT: SettingsFormat = { indent: '  ', eol: '\n', trailingNewline: true }

/** Reads the layout of an existing file so a rewrite changes as little as possible. */
export function detectFormat(text: string | undefined): SettingsFormat {
  if (text === undefined) return { ...DEFAULT_FORMAT }
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? DEFAULT_FORMAT.indent
  return { indent, eol: text.includes('\r\n') ? '\r\n' : '\n', trailingNewline: text.endsWith('\n') }
}

export function serialiseSettings(value: unknown, format: SettingsFormat): string {
  let text = JSON.stringify(value, null, format.indent)
  if (format.eol === '\r\n') text = text.replace(/\n/g, '\r\n')
  return format.trailingNewline ? text + format.eol : text
}

export function collectorHandler(
  event: HookEventName,
  collectorPath: string,
  stateDirArg: string | undefined
): CollectorHandler {
  const args = stateDirArg ? [collectorPath, '--state-dir', stateDirArg] : [collectorPath]
  return SYNC_HOOK_EVENTS.has(event)
    ? { type: 'command', command: 'node', args, timeout: 5 }
    : { type: 'command', command: 'node', args, async: true, timeout: 5 }
}

export interface DesiredEntry {
  event: HookEventName
  handler: CollectorHandler
}

/** All 14 events, or the 11 lifecycle ones when tool events are switched off. */
export function desiredEntries(collectorPath: string, stateDirArg: string | undefined, tools: boolean): DesiredEntry[] {
  return HOOK_EVENT_NAMES.filter((event) => tools || !TOOL_HOOK_EVENTS.includes(event)).map((event) => ({
    event,
    handler: collectorHandler(event, collectorPath, stateDirArg),
  }))
}

function basenameOf(token: string): string {
  const unquoted = token.replace(/^['"]+|['"]+$/g, '')
  return unquoted.split(/[\\/]/).pop() ?? ''
}

/** Ours means: a command handler that runs a file named cubiclark-collector.js, in exec form
 * (an `args` element) or in shell form (a token of `command`). Nothing else is ever touched. */
export function isCollectorHandler(handler: unknown): boolean {
  if (!isRecord(handler) || handler.type !== 'command') return false
  const candidates: string[] = []
  if (typeof handler.command === 'string') candidates.push(...handler.command.split(/\s+/))
  if (Array.isArray(handler.args)) {
    for (const arg of handler.args) if (typeof arg === 'string') candidates.push(arg)
  }
  return candidates.some((candidate) => basenameOf(candidate) === COLLECTOR_BASENAME)
}

export interface CollectorEntry {
  event: string
  handler: Record<string, unknown>
}

export function collectorEntries(settings: Record<string, unknown>): CollectorEntry[] {
  const entries: CollectorEntry[] = []
  const hooks = settings.hooks
  if (!isRecord(hooks)) return entries
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue
      for (const handler of group.hooks) {
        if (isCollectorHandler(handler)) entries.push({ event, handler: handler as Record<string, unknown> })
      }
    }
  }
  return entries
}

/** Removes only our handlers. A matcher group that became empty because of that is dropped, and
 * so is an event key, and `hooks` itself; nothing else changes and key order is preserved.
 * Returns the same object when there was nothing of ours. */
export function withoutCollector(settings: Record<string, unknown>): { settings: Record<string, unknown>; removed: number } {
  const hooks = settings.hooks
  if (!isRecord(hooks)) return { settings, removed: 0 }

  let removed = 0
  const keptHooks: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      keptHooks[event] = groups
      continue
    }
    const keptGroups: unknown[] = []
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group)
        continue
      }
      const kept = group.hooks.filter((handler) => !isCollectorHandler(handler))
      const dropped = group.hooks.length - kept.length
      if (dropped === 0) {
        keptGroups.push(group)
        continue
      }
      removed += dropped
      if (kept.length > 0) keptGroups.push({ ...group, hooks: kept })
    }
    if (keptGroups.length > 0 || groups.length === 0) keptHooks[event] = keptGroups
  }
  if (removed === 0) return { settings, removed: 0 }

  const next: Record<string, unknown> = {}
  for (const key of Object.keys(settings)) {
    if (key !== 'hooks') next[key] = settings[key]
    else if (Object.keys(keptHooks).length > 0) next[key] = keptHooks
  }
  return { settings: next, removed }
}

/** Idempotent: when our entries already equal `desired`, returns the same object with
 * changed false. Otherwise removes ours and appends a fresh matcher group per event, at the end
 * of that event's array. */
export function withCollector(
  settings: Record<string, unknown>,
  desired: readonly DesiredEntry[]
): { settings: Record<string, unknown>; changed: boolean } {
  const signature = (entries: readonly { event: string; handler: unknown }[]): string[] =>
    entries.map((entry) => JSON.stringify([entry.event, entry.handler])).sort()
  const current = signature(collectorEntries(settings))
  const wanted = signature(desired)
  if (current.length === wanted.length && current.every((line, i) => line === wanted[i])) {
    return { settings, changed: false }
  }

  const stripped = withoutCollector(settings).settings
  const hooks: Record<string, unknown> = isRecord(stripped.hooks) ? { ...stripped.hooks } : {}
  for (const { event, handler } of desired) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    hooks[event] = [...existing, { hooks: [handler] }]
  }
  return { settings: { ...stripped, hooks }, changed: true }
}
