// Classifies a transcript file by its path alone (A1/A2 in PLAN.md §1.5), and derives a
// project name from a record's cwd. Pure: no fs access, just string matching, so the transcript
// source (step 6) can call this on every path it discovers and the parser tests can call it on
// invented paths without touching disk.

const SESSION_RE = /^projects\/[^/]+\/([^/]+)\.jsonl$/
const SUBAGENT_RE = /^projects\/[^/]+\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/
const SUBAGENT_META_RE = /^projects\/[^/]+\/([^/]+)\/subagents\/agent-([^/]+)\.meta\.json$/

export type PathClassification =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; parentId: string; agentId: string }
  | { kind: 'subagent-meta'; parentId: string; agentId: string }
  | { kind: 'ignore' }

/** `relPath` is relative to the transcripts root (the `--fixture-home` dir, or the real Claude
 * config dir), using forward slashes. A1/A2: session transcripts sit at
 * `projects/<enc-cwd>/<sessionId>.jsonl`, subagent transcripts and their sidecar meta files sit
 * at `projects/<enc-cwd>/<sessionId>/subagents/agent-<agentId>.{jsonl,meta.json}`. Anything else
 * (`.DS_Store`, an unrelated file, a future layout) is ignored rather than guessed at. */
export function classifyPath(relPath: string): PathClassification {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')

  const subagentMeta = SUBAGENT_META_RE.exec(normalized)
  if (subagentMeta) {
    return { kind: 'subagent-meta', parentId: subagentMeta[1] as string, agentId: subagentMeta[2] as string }
  }

  const subagent = SUBAGENT_RE.exec(normalized)
  if (subagent) {
    return { kind: 'subagent', parentId: subagent[1] as string, agentId: subagent[2] as string }
  }

  const session = SESSION_RE.exec(normalized)
  if (session) {
    return { kind: 'session', sessionId: session[1] as string }
  }

  return { kind: 'ignore' }
}

/** A1: the project name is the cwd's basename, read from each record's own `cwd` field — never
 * decoded back out of the lossy encoded directory name. */
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}
