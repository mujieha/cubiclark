// Parses a subagent's sidecar `agent-<id>.meta.json` file (A3 in PLAN.md §1.5). This is a
// single JSON object, not a JSONL stream, so it gets its own one-shot parser rather than a
// parseLine-style function; the caller (the transcript source, step 6) turns a successful parse
// into a subagent_link AgentEvent and a failed one into a diagnostic.

import { TRANSCRIPT_GUESSES } from './guesses.js'
import { safeTarget } from './tools.js'

export interface SubagentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  model?: string
  /** Present only for a named teammate (design §4); absent means a transient subagent. */
  name?: string
  spawnDepth?: number
}

export type ParseMetaResult = { ok: true; meta: SubagentMeta } | { ok: false; error: string }

export function parseSubagentMeta(text: string): ParseMetaResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'not a JSON object' }
  }

  const obj = value as Record<string, unknown>
  const str = (key: string): string | undefined => (typeof obj[key] === 'string' ? (obj[key] as string) : undefined)
  const num = (key: string): number | undefined => (typeof obj[key] === 'number' ? (obj[key] as number) : undefined)

  const keys = TRANSCRIPT_GUESSES.subagentMetaKeys
  // A label follows the collector's rule for a target (R2-7). `name` only decides teammate or subagent
  // and is never shown, so a name that fails the rule still marks a teammate.
  const rawName = str(keys.name)
  return {
    ok: true,
    meta: {
      agentType: safeTarget(str(keys.agentType)),
      description: str(keys.description),
      toolUseId: str(keys.toolUseId),
      model: str(keys.model),
      name: rawName === undefined || rawName === '' ? rawName : (safeTarget(rawName) ?? 'teammate'),
      spawnDepth: num(keys.spawnDepth),
    },
  }
}
