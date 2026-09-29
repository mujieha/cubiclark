// `claude agents --json` -> sessions (docs: code.claude.com/docs/en/agent-view). Pure.
//
// It prints the active sessions as a JSON array. Per entry, as documented: `cwd`, `kind`
// (interactive | background), `startedAt` (Unix ms), and for background sessions `id` and `state`
// (working | blocked | done | failed | stopped); while the process is alive `pid` and `status`
// (busy | waiting | idle), and `waitingFor` while waiting; `sessionId` and `name` when set.
// Only the whitelisted fields below are kept, each capped at 40 characters. Unknown fields are
// ignored and an unknown `state` becomes 'other': a new value must never break the page.

import { isSessionId } from './task-log.js'
import type { CliSession } from './types.js'

export const CLI_FIELD_CAP = 40
const STATES = new Set(['working', 'blocked', 'done', 'failed', 'stopped'])

export interface ParsedAgents {
  sessions: CliSession[]
  /** Array elements that were not objects. */
  unparsed: number
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, CLI_FIELD_CAP) : undefined
}

export function parseAgentsJson(stdout: string): ParsedAgents {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return { sessions: [], unparsed: 0, error: 'claude agents --json did not print a JSON array' }
  }
  if (!Array.isArray(value)) return { sessions: [], unparsed: 0, error: 'claude agents --json did not print a JSON array' }

  const sessions: CliSession[] = []
  let unparsed = 0
  for (const item of value) {
    if (!isRecord(item)) {
      unparsed += 1
      continue
    }
    const session: CliSession = {}
    if (typeof item.sessionId === 'string' && isSessionId(item.sessionId)) session.sessionId = item.sessionId
    // The working directory is kept for matching on the server; it never reaches the page.
    if (typeof item.cwd === 'string') session.cwd = item.cwd
    if (item.kind === 'interactive' || item.kind === 'background') session.kind = item.kind
    const state = text(item.state)
    if (state) session.state = STATES.has(state) ? state : 'other'
    const status = text(item.status)
    if (status) session.status = status
    const waitingFor = text(item.waitingFor)
    if (waitingFor) session.waitingFor = waitingFor
    const name = text(item.name)
    if (name) session.name = name
    if (typeof item.startedAt === 'number' && Number.isFinite(item.startedAt)) {
      const date = new Date(item.startedAt)
      if (!Number.isNaN(date.getTime())) session.startedAt = date.toISOString()
    }
    sessions.push(session)
  }
  return { sessions, unparsed }
}
