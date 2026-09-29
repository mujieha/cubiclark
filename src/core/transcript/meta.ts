// Parses a subagent's sidecar `agent-<id>.meta.json` file (A3 in PLAN.md §1.5). This is a
// single JSON object, not a JSONL stream, so it gets its own one-shot parser rather than a
// parseLine-style function; the caller (the transcript source, step 6) turns a successful parse
// into a subagent_link AgentEvent and a failed one into a diagnostic.

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

  return {
    ok: true,
    meta: {
      agentType: str('agentType'),
      description: str('description'),
      toolUseId: str('toolUseId'),
      model: str('model'),
      name: str('name'),
      spawnDepth: num('spawnDepth'),
    },
  }
}
