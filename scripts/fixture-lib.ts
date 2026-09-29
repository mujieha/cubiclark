// Synthetic Claude Code transcript builders, shaped from Claude Code 2.1.284 transcripts (key
// paths and `type` values only, no values — see ref/transcript-shape/ in the planning task
// folder, orchestrator-owned and not part of this repository) plus public docs
// (code.claude.com/docs/en/hooks) and third-party parsers (see PLAN.md §1.5 in the planning
// task folder for citations). Every id, path, timestamp and word of prose below is invented;
// nothing here is copied from a real session. Every synthetic tool-use id carries the marker
// 'fx' right after its prefix, every subagent id starts with 'fx', and every record uuid
// matches /^00000000-0000-4000-8000-[0-9a-f]{12}$/ — test/personal-data.test.ts checks all of
// this against every file this module can produce.
//
// This module has no side effects other than the exported resetFixtureSequence()/nextUuid()
// counter, so scripts/make-fixtures.ts can call it repeatedly (once per --check run) and get
// byte-identical output as long as it calls the scenario builders in the same order each time.

export const FIXTURE_VERSION = '2.1.284'
export const DEMO_CWD = '/home/user/projects/demo'
export const SHOP_CWD = '/home/user/projects/shop'

/** The only vocabulary any prompt, thinking or description string in a fixture may use.
 * test/personal-data.test.ts checks every such string against this list, so nothing that looks
 * like real prompt text can land in a fixture undetected. */
export const LOREM_WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'do',
  'eiusmod',
  'tempor',
  'incididunt',
  'ut',
  'labore',
  'et',
  'dolore',
  'magna',
  'aliqua',
  'enim',
  'ad',
  'minim',
  'veniam',
  'quis',
  'nostrud',
  'exercitation',
  'ullamco',
  'laboris',
  'nisi',
  'aliquip',
] as const

/** Deterministic filler text: cycles through a fixed word list, never random. */
export function lorem(n: number): string {
  const words: string[] = []
  for (let i = 0; i < n; i += 1) {
    words.push(LOREM_WORDS[i % LOREM_WORDS.length] as string)
  }
  return words.join(' ')
}

/** A session id in the invented UUID family, distinguished only by its last hex digit. */
export function sessionId(hex: string): string {
  return `00000000-0000-4000-8000-00000000000${hex}`
}

/** A subagent id: 'fx' followed by 15 hex characters, the shape a real agentId takes. */
export function subagentId(hex: string): string {
  return `fx${hex.padStart(15, '0')}`
}

/** A tool_use id carrying the 'fx' marker right after the real 'toolu_' prefix. */
export function toolUseId(n: number): string {
  return `toolu_fx${String(n).padStart(6, '0')}`
}

let uuidSeq = 0

/** Resets the uuid counter so a fresh generation run is byte-identical to the last one. */
export function resetFixtureSequence(): void {
  uuidSeq = 0
}

/** The next record uuid, in the invented family (starts with '1' right after the last dash, so
 * it can never collide with a sessionId() value, which always starts that group with zeros). */
export function nextUuid(): string {
  uuidSeq += 1
  return `00000000-0000-4000-8000-1${uuidSeq.toString(16).padStart(11, '0')}`
}

/** An ISO timestamp `step` ticks (2s each) after `startAt` (an epoch-ms base time). */
export function ts(startAt: number, step: number): string {
  return new Date(startAt + step * 2000).toISOString()
}

interface ChainCtx {
  sessionId: string
  cwd: string
  isSidechain?: boolean
  agentId?: string
  sessionKind?: 'bg'
}

/** Builds one transcript file's records, chaining each record's parentUuid to the previous
 * record's uuid, and stamping every record with the common fields every real record carries
 * (A4 in PLAN.md §1.5). */
export class RecordChain {
  private prev: string | null = null

  constructor(private readonly ctx: ChainCtx) {}

  rec(when: string, fields: Record<string, unknown>): Record<string, unknown> {
    const uuid = nextUuid()
    const out: Record<string, unknown> = {
      uuid,
      parentUuid: this.prev,
      timestamp: when,
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      version: FIXTURE_VERSION,
      ...(this.ctx.isSidechain ? { isSidechain: true, agentId: this.ctx.agentId } : {}),
      ...(this.ctx.sessionKind ? { sessionKind: this.ctx.sessionKind } : {}),
      ...fields,
    }
    this.prev = uuid
    return out
  }
}

export function toolUseBlock(id: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: 'tool_use', id, name, input }
}

export function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

export function thinkingBlock(text: string): Record<string, unknown> {
  return { type: 'thinking', thinking: text }
}

function toolResultBlock(toolUseIdValue: string, content: string, isError: boolean): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolUseIdValue,
    content,
    ...(isError ? { is_error: true } : {}),
  }
}

interface AssistantOpts {
  model?: string
  stopReason?: string | null
  outputTokens?: number
  isApiErrorMessage?: boolean
  error?: string
}

export function assistantRecord(
  chain: RecordChain,
  when: string,
  content: Record<string, unknown>[],
  opts: AssistantOpts = {}
): Record<string, unknown> {
  return chain.rec(when, {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-5',
      content,
      stop_reason: opts.stopReason ?? null,
      usage: { output_tokens: opts.outputTokens ?? 10 },
    },
    ...(opts.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  })
}

export function userPromptRecord(
  chain: RecordChain,
  when: string,
  text: string,
  opts: { permissionMode?: string } = {}
): Record<string, unknown> {
  return chain.rec(when, {
    type: 'user',
    message: { role: 'user', content: text },
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
  })
}

export function userToolResultRecord(
  chain: RecordChain,
  when: string,
  toolUseIdValue: string,
  content: string,
  opts: { isError?: boolean; toolDenialKind?: string } = {}
): Record<string, unknown> {
  return chain.rec(when, {
    type: 'user',
    message: {
      role: 'user',
      content: [toolResultBlock(toolUseIdValue, content, opts.isError ?? false)],
    },
    ...(opts.toolDenialKind ? { toolDenialKind: opts.toolDenialKind } : {}),
  })
}

export function userInterruptedRecord(chain: RecordChain, when: string): Record<string, unknown> {
  return chain.rec(when, {
    type: 'user',
    message: { role: 'user', content: '[Request interrupted by user]' },
  })
}

export function systemRecord(
  chain: RecordChain,
  when: string,
  subtype: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return chain.rec(when, { type: 'system', subtype, ...extra })
}

export type Line = Record<string, unknown> | { raw: string }

/** A main interactive session: permission-mode, an ignored attachment, a prompt, thinking, one
 * of each everyday tool (Read, Edit, Bash, Grep, WebFetch), a text end_turn, turn_duration, and
 * an ignored ai-title. Ends in `waiting_user`. */
export function mainSessionLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(chain.rec(at(), { type: 'permission-mode', permissionMode: 'default' }))
  lines.push(chain.rec(at(), { type: 'attachment', attachment: { type: 'nested_memory', text: lorem(4) } }))
  lines.push(userPromptRecord(chain, at(), lorem(6), { permissionMode: 'default' }))

  const readId = toolUseId(1)
  lines.push(
    assistantRecord(
      chain,
      at(),
      [thinkingBlock(lorem(8)), toolUseBlock(readId, 'Read', { file_path: `${cwd}/README.md` })],
      { stopReason: 'tool_use' }
    )
  )
  lines.push(userToolResultRecord(chain, at(), readId, lorem(10)))

  const editId = toolUseId(2)
  lines.push(
    assistantRecord(
      chain,
      at(),
      [toolUseBlock(editId, 'Edit', { file_path: `${cwd}/README.md`, old_string: lorem(2), new_string: lorem(3) })],
      { stopReason: 'tool_use' }
    )
  )
  lines.push(userToolResultRecord(chain, at(), editId, lorem(2)))

  const bashId = toolUseId(3)
  lines.push(
    assistantRecord(chain, at(), [toolUseBlock(bashId, 'Bash', { command: 'npm test', description: lorem(3) })], {
      stopReason: 'tool_use',
    })
  )
  lines.push(userToolResultRecord(chain, at(), bashId, lorem(6)))

  const grepId = toolUseId(4)
  lines.push(
    assistantRecord(chain, at(), [toolUseBlock(grepId, 'Grep', { pattern: 'TODO', path: `${cwd}/src` })], {
      stopReason: 'tool_use',
    })
  )
  lines.push(userToolResultRecord(chain, at(), grepId, lorem(3)))

  const fetchId = toolUseId(5)
  lines.push(
    assistantRecord(
      chain,
      at(),
      [toolUseBlock(fetchId, 'WebFetch', { url: 'https://example.com/docs', prompt: lorem(4) })],
      { stopReason: 'tool_use' }
    )
  )
  lines.push(userToolResultRecord(chain, at(), fetchId, lorem(5)))

  lines.push(assistantRecord(chain, at(), [textBlock(lorem(12))], { stopReason: 'end_turn', outputTokens: 24 }))
  lines.push(systemRecord(chain, at(), 'turn_duration', { durationMs: 4200 }))
  lines.push(chain.rec(at(), { type: 'ai-title', aiTitle: lorem(3) }))

  return lines
}

/** A background worker: sessionKind 'bg', an agent-name label, a prompt, and an open Bash with
 * no result yet (the worker is still running when the transcript is tailed). Ends in `running`
 * with the tool target 'npm'. */
export function backgroundWorkerLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd, sessionKind: 'bg' })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(chain.rec(at(), { type: 'agent-name', agentName: 'demo-worker' }))
  lines.push(userPromptRecord(chain, at(), lorem(5)))
  const bashId = toolUseId(1)
  lines.push(
    assistantRecord(chain, at(), [toolUseBlock(bashId, 'Bash', { command: 'npm install', description: lorem(2) })], {
      stopReason: 'tool_use',
    })
  )
  return lines
}

/** A session that starts an Explore subagent through the Agent tool. With `full: true`, the
 * subagent runs Glob then Read and finishes, then the parent gets its result and finishes too
 * (used to step through every state in the delegation). With `full: false`, both stop right
 * after their first open tool call: the parent stays `delegating`, the subagent stays
 * `searching` (used for the CLI's live home world). */
export function exploreScenario(
  startAt: number,
  parentSid: string,
  cwd: string,
  aid: string,
  opts: { full: boolean }
): { parentLines: Line[]; subagentLines: Line[]; meta: Record<string, unknown> } {
  const parentChain = new RecordChain({ sessionId: parentSid, cwd })
  const subChain = new RecordChain({ sessionId: parentSid, cwd, isSidechain: true, agentId: aid })
  const parentLines: Line[] = []
  const subagentLines: Line[] = []
  let pi = 0
  const pat = (): string => ts(startAt, pi++)
  let si = 0
  // The subagent's own activity is interleaved a little after the parent's delegating call.
  const sat = (): string => ts(startAt, 20 + si++)

  const spawnId = toolUseId(1)
  parentLines.push(userPromptRecord(parentChain, pat(), lorem(6)))
  parentLines.push(
    assistantRecord(
      parentChain,
      pat(),
      [toolUseBlock(spawnId, 'Agent', { subagent_type: 'Explore', description: lorem(3), prompt: lorem(6) })],
      { stopReason: 'tool_use' }
    )
  )

  subagentLines.push(userPromptRecord(subChain, sat(), lorem(6)))
  // Offset from the parent's own tool ids (spawnId = toolUseId(1)): a subagent's transcript is
  // a separate file, but real tool_use ids are globally unique, and PLAN.md's reducer rule for
  // matching a parent's tool_end to a subagent by spawnToolUseId would be trivially (and
  // wrongly) satisfied by an accidental collision here.
  const globId = toolUseId(101)
  subagentLines.push(
    assistantRecord(subChain, sat(), [toolUseBlock(globId, 'Glob', { pattern: '**/*.ts' })], {
      stopReason: 'tool_use',
    })
  )

  if (opts.full) {
    subagentLines.push(userToolResultRecord(subChain, sat(), globId, lorem(8)))
    const readId = toolUseId(102)
    subagentLines.push(
      assistantRecord(subChain, sat(), [toolUseBlock(readId, 'Read', { file_path: `${cwd}/src/index.ts` })], {
        stopReason: 'tool_use',
      })
    )
    subagentLines.push(userToolResultRecord(subChain, sat(), readId, lorem(10)))
    subagentLines.push(
      assistantRecord(subChain, sat(), [textBlock(lorem(10))], { stopReason: 'end_turn', outputTokens: 18 })
    )
    subagentLines.push(systemRecord(subChain, sat(), 'turn_duration', { durationMs: 3000 }))

    parentLines.push(userToolResultRecord(parentChain, pat(), spawnId, lorem(8)))
    parentLines.push(
      assistantRecord(parentChain, pat(), [textBlock(lorem(10))], { stopReason: 'end_turn', outputTokens: 16 })
    )
    parentLines.push(systemRecord(parentChain, pat(), 'turn_duration', { durationMs: 5000 }))
  }

  const meta: Record<string, unknown> = {
    agentType: 'Explore',
    description: lorem(4),
    toolUseId: spawnId,
    model: 'claude-sonnet-5',
    spawnDepth: 1,
  }

  return { parentLines, subagentLines, meta }
}

/** A session that compacts mid-way: a compact_boundary system record, a skipped
 * isCompactSummary user record, then a normal tool call continuing after it. Ends in
 * `waiting_user` with `compactions: 1`. */
export function compactionLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(userPromptRecord(chain, at(), lorem(8)))
  const bashId = toolUseId(1)
  lines.push(
    assistantRecord(chain, at(), [toolUseBlock(bashId, 'Bash', { command: 'git log', description: lorem(2) })], {
      stopReason: 'tool_use',
    })
  )
  lines.push(userToolResultRecord(chain, at(), bashId, lorem(6)))
  lines.push(systemRecord(chain, at(), 'compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 50000 } }))
  lines.push(chain.rec(at(), { type: 'user', isCompactSummary: true, message: { role: 'user', content: lorem(20) } }))

  const editId = toolUseId(2)
  lines.push(
    assistantRecord(
      chain,
      at(),
      [toolUseBlock(editId, 'Edit', { file_path: `${cwd}/NOTES.md`, old_string: lorem(1), new_string: lorem(2) })],
      { stopReason: 'tool_use' }
    )
  )
  lines.push(userToolResultRecord(chain, at(), editId, lorem(3)))
  lines.push(assistantRecord(chain, at(), [textBlock(lorem(6))], { stopReason: 'end_turn', outputTokens: 12 }))
  lines.push(systemRecord(chain, at(), 'turn_duration', { durationMs: 2500 }))

  return lines
}

/** A retrying rate-limit error (system api_error, status 429) followed by a terminal
 * isApiErrorMessage assistant record. Ends in `rate_limited`. */
export function rateLimitLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(userPromptRecord(chain, at(), lorem(6)))
  const bashId = toolUseId(1)
  lines.push(
    assistantRecord(chain, at(), [toolUseBlock(bashId, 'Bash', { command: 'npm run deploy', description: lorem(2) })], {
      stopReason: 'tool_use',
    })
  )
  lines.push(
    systemRecord(chain, at(), 'api_error', { error: { status: 429 }, retryAttempt: 1, maxRetries: 5, retryInMs: 2000 })
  )
  lines.push(
    assistantRecord(chain, at(), [textBlock('API Error: rate limit exceeded, please retry later')], {
      model: '<synthetic>',
      stopReason: 'end_turn',
      isApiErrorMessage: true,
      error: 'rate_limit',
    })
  )

  return lines
}

/** A non-retrying, non-rate-limit terminal API failure (an 'invalid_request'). Ends in
 * `failed`. */
export function apiErrorLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(userPromptRecord(chain, at(), lorem(6)))
  const writeId = toolUseId(1)
  lines.push(
    assistantRecord(chain, at(), [toolUseBlock(writeId, 'Write', { file_path: `${cwd}/OUT.md`, content: lorem(4) })], {
      stopReason: 'tool_use',
    })
  )
  lines.push(userToolResultRecord(chain, at(), writeId, lorem(2)))
  lines.push(
    assistantRecord(chain, at(), [textBlock('API Error: invalid request: missing required field')], {
      model: '<synthetic>',
      stopReason: 'end_turn',
      isApiErrorMessage: true,
      error: 'invalid_request',
    })
  )

  return lines
}

/** A permission-mode record, a prompt, and an open Bash with no result: the shape tick()'s
 * inferred-permission-wait rule looks for. Ends in `running` (the inference itself needs a
 * clock, tested in tick.test.ts). */
export function permissionWaitLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(chain.rec(at(), { type: 'permission-mode', permissionMode: 'default' }))
  lines.push(userPromptRecord(chain, at(), lorem(5), { permissionMode: 'default' }))
  const bashId = toolUseId(1)
  lines.push(
    assistantRecord(
      chain,
      at(),
      [toolUseBlock(bashId, 'Bash', { command: 'rm demo-temp-file.log', description: lorem(2) })],
      { stopReason: 'tool_use' }
    )
  )
  return lines
}

/** A tool call denied by the user: a tool_result with is_error and toolDenialKind. Ends in
 * `waiting_user`, with a "permission denied" log line along the way. */
export function permissionDeniedLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(userPromptRecord(chain, at(), lorem(5)))
  const bashId = toolUseId(1)
  lines.push(
    assistantRecord(
      chain,
      at(),
      [toolUseBlock(bashId, 'Bash', { command: 'rm demo-temp-file.log', description: lorem(2) })],
      { stopReason: 'tool_use' }
    )
  )
  lines.push(
    userToolResultRecord(chain, at(), bashId, 'Permission denied by user', {
      isError: true,
      toolDenialKind: 'user_rejected',
    })
  )
  lines.push(assistantRecord(chain, at(), [textBlock(lorem(6))], { stopReason: 'end_turn', outputTokens: 10 }))
  lines.push(systemRecord(chain, at(), 'turn_duration', { durationMs: 1800 }))

  return lines
}

/** A tool call the user interrupts mid-flight: the exact '[Request interrupted by user]' text,
 * with no tool_result ever arriving for the open tool. Ends in `waiting_user`. */
export function interruptedLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(userPromptRecord(chain, at(), lorem(5)))
  const bashId = toolUseId(1)
  lines.push(
    assistantRecord(chain, at(), [toolUseBlock(bashId, 'Bash', { command: 'npm run watch', description: lorem(2) })], {
      stopReason: 'tool_use',
    })
  )
  lines.push(userInterruptedRecord(chain, at()))

  return lines
}

/** Valid lines interleaved with three unparseable ones: a truncated JSON line, a line with an
 * unknown top-level `type`, and a `system` record with an unknown `subtype`. Each of the three
 * must increment the diagnostics counter instead of throwing. */
export function malformedLines(startAt: number, sid: string, cwd: string): Line[] {
  const chain = new RecordChain({ sessionId: sid, cwd })
  const lines: Line[] = []
  let i = 0
  const at = (): string => ts(startAt, i++)

  lines.push(userPromptRecord(chain, at(), lorem(5)))
  lines.push({ raw: '{"type": "user", "message": {' })
  lines.push(assistantRecord(chain, at(), [textBlock(lorem(6))], { stopReason: 'end_turn', outputTokens: 10 }))
  lines.push(chain.rec(at(), { type: 'future-thing', payload: lorem(3) }))
  lines.push(systemRecord(chain, at(), 'unknown_future_subtype', { note: lorem(2) }))
  lines.push(systemRecord(chain, at(), 'turn_duration', { durationMs: 2000 }))

  return lines
}
