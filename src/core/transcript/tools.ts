// Maps a tool_use block to the AgentState it implies and a reduced target: only ever a file
// basename, a command verb, a URL host or a subagent type — the same reduction rule design §5
// specifies for what the collector is allowed to keep, applied here to transcripts too. Pattern
// arguments (Grep/Glob), search queries (WebSearch) and full paths are never returned.

const READING_TOOLS = new Set(['Read', 'NotebookRead', 'LS'])
const EDITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const RUNNING_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'PowerShell'])
const SEARCHING_TOOLS = new Set(['Grep', 'Glob', 'ToolSearch'])
const DELEGATING_TOOLS = new Set(['Agent', 'Task'])

/** Tools that never prompt for permission on their own, so tick()'s inferred-permission-wait
 * rule (PLAN.md §1.6) must never fire while one of these is the newest open tool. */
export const PERMISSION_EXEMPT = new Set([
  'Read',
  'NotebookRead',
  'LS',
  'Grep',
  'Glob',
  'ToolSearch',
  'TodoWrite',
  'Agent',
  'Task',
  'BashOutput',
])

/** `acceptEdits` mode additionally exempts the editing tools. */
export function isPermissionExempt(name: string, permissionMode: string | undefined): boolean {
  if (PERMISSION_EXEMPT.has(name)) return true
  if (permissionMode === 'acceptEdits' && EDITING_TOOLS.has(name)) return true
  return false
}

export type ToolState = 'reading' | 'editing' | 'running' | 'searching' | 'browsing' | 'delegating'

export interface ToolActivity {
  state: ToolState
  target?: string
}

/** The most characters a target or a label keeps (R2-7). */
export const MAX_TARGET = 100

/** The control characters (R3-3): C0, DEL and C1 (`\p{Cc}`, U+0000-001F and U+007F-009F) and the format
 * characters (`\p{Cf}`: bidi controls, zero-width characters, the byte order mark). */
const CONTROL_CHAR = /[\p{Cc}\p{Cf}]/u

export function hasControlChar(text: string): boolean {
  return CONTROL_CHAR.test(text)
}

/** The one rule for a target or a label that came from outside (the collector's whitelist, a transcript,
 * a sidecar): at most 100 characters, no control character, no path separator; anything else is dropped,
 * not cut. One function, so what the collector keeps and what a transcript shows cannot drift apart. */
export function safeTarget(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_TARGET) return undefined
  if (value.includes('/') || value.includes('\\') || hasControlChar(value)) return undefined
  return value
}

/** What a tool_use block's name is called from here on (R3-3): the name itself under the same rule as a
 * target, and a fixed word for one that fails it. The tool call stays in the picture (its id, its state);
 * only the text that came from outside does not. */
export const UNKNOWN_TOOL_NAME = 'unknown-tool'

export function safeToolName(name: string): string {
  return safeTarget(name) ?? UNKNOWN_TOOL_NAME
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

const MAX_VERB_CHARS = 40
/** Prefixes of well-known credentials: sk- (API keys), ghp_/gho_/ghs_ (GitHub), xox (Slack), AKIA (AWS). */
const SECRET_PREFIX = /^(?:sk-|gh[pousr]_|xox|AKIA|ASIA|AIza|glpat-|npm_)/

/** A command's first word is kept only when it looks like a program name (S1-16): a word that
 * is long, holds `=`, `:` or `@`, or starts like a credential is more likely a secret typed where
 * a command goes, so nothing is kept. */
function looksLikeVerb(word: string): boolean {
  return word.length <= MAX_VERB_CHARS && !/[=:@]/.test(word) && !SECRET_PREFIX.test(word)
}

function bashTarget(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue // skip VAR=value assignments
    const verb = basename(token)
    return looksLikeVerb(verb) ? verb : undefined
  }
  return undefined
}

function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

function isBrowsingMcp(name: string): boolean {
  return /^mcp__.*(chrome|playwright|browser)/i.test(name)
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The state bucket a tool name alone implies, with no input needed. The reducer's tool_start
 * handler uses this directly (PLAN.md §1.6's "state from table"), so it never has to duplicate
 * this classification or import a whole tool_use block just to re-derive a state it can get from
 * the name it already has. */
export function toolStateForName(name: string): ToolState {
  if (READING_TOOLS.has(name)) return 'reading'
  if (EDITING_TOOLS.has(name)) return 'editing'
  if (RUNNING_TOOLS.has(name)) return 'running'
  if (SEARCHING_TOOLS.has(name)) return 'searching'
  if (name === 'WebFetch' || name === 'WebSearch' || isBrowsingMcp(name)) return 'browsing'
  if (DELEGATING_TOOLS.has(name)) return 'delegating'
  return 'running'
}

/** The state a tool call implies and its reduced target, which is dropped unless it passes safeTarget (R2-7). */
export function toolActivity(name: string, input: Record<string, unknown>): ToolActivity {
  const raw = rawToolActivity(name, input)
  return raw.target === undefined ? raw : { state: raw.state, target: safeTarget(raw.target) }
}

function rawToolActivity(name: string, input: Record<string, unknown>): ToolActivity {
  const state = toolStateForName(name)
  switch (state) {
    case 'reading': {
      const path = stringInput(input, 'file_path') ?? stringInput(input, 'notebook_path') ?? stringInput(input, 'path')
      return { state, target: path ? basename(path) : undefined }
    }
    case 'editing': {
      const path = stringInput(input, 'file_path') ?? stringInput(input, 'notebook_path')
      return { state, target: path ? basename(path) : undefined }
    }
    case 'running': {
      const command = stringInput(input, 'command')
      return { state, target: command ? bashTarget(command) : undefined }
    }
    case 'searching': {
      // Grep/Glob patterns are never returned; only an explicit `path` argument is.
      const path = stringInput(input, 'path')
      return { state, target: path ? basename(path) : undefined }
    }
    case 'browsing': {
      if (name !== 'WebFetch') return { state } // WebSearch's query and MCP browsing are content, never shown
      const url = stringInput(input, 'url')
      return { state, target: url ? urlHost(url) : undefined }
    }
    case 'delegating':
      return { state, target: stringInput(input, 'subagent_type') }
  }
}
