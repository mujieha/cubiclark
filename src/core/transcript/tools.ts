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

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

function bashTarget(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue // skip VAR=value assignments
    return basename(token)
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

export function toolActivity(name: string, input: Record<string, unknown>): ToolActivity {
  if (READING_TOOLS.has(name)) {
    const path = stringInput(input, 'file_path') ?? stringInput(input, 'notebook_path') ?? stringInput(input, 'path')
    return { state: 'reading', target: path ? basename(path) : undefined }
  }
  if (EDITING_TOOLS.has(name)) {
    const path = stringInput(input, 'file_path') ?? stringInput(input, 'notebook_path')
    return { state: 'editing', target: path ? basename(path) : undefined }
  }
  if (RUNNING_TOOLS.has(name)) {
    const command = stringInput(input, 'command')
    return { state: 'running', target: command ? bashTarget(command) : undefined }
  }
  if (SEARCHING_TOOLS.has(name)) {
    // Grep/Glob patterns are never returned; only an explicit `path` argument is.
    const path = stringInput(input, 'path')
    return { state: 'searching', target: path ? basename(path) : undefined }
  }
  if (name === 'WebFetch') {
    const url = stringInput(input, 'url')
    return { state: 'browsing', target: url ? urlHost(url) : undefined }
  }
  if (name === 'WebSearch' || isBrowsingMcp(name)) {
    // The search query is content, never shown.
    return { state: 'browsing' }
  }
  if (DELEGATING_TOOLS.has(name)) {
    return { state: 'delegating', target: stringInput(input, 'subagent_type') }
  }
  return { state: 'running' }
}
