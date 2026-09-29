// One test per scenario in scripts/fixture-lib.ts, each asserting the exact AgentEvent list the
// parser must produce. The scenario builders are called directly (not read back off disk) so
// this test is independent of whether `npm run fixtures` has been re-run; test/fixtures.test.ts
// separately proves the checked-in files still match what the builders produce.
//
// Every expected event below was worked out by hand from scripts/fixture-lib.ts's source (the
// exact record sequence each scenario writes) and src/core/transcript/{records,parse}.ts's
// rules, using the same ts()/toolUseId()/sessionId() helpers the fixtures themselves are built
// from — not copied from the parser's own output.

import { describe, expect, test } from 'vitest'
import {
  DEMO_CWD,
  FIXTURE_VERSION,
  SHOP_CWD,
  apiErrorLines,
  backgroundWorkerLines,
  compactionLines,
  exploreScenario,
  interruptedLines,
  type Line,
  mainSessionLines,
  malformedLines,
  permissionDeniedLines,
  permissionWaitLines,
  rateLimitLines,
  sessionId,
  subagentId,
  toolUseId,
  ts,
} from '../scripts/fixture-lib.js'
import { parseTranscript } from '../src/core/transcript/parse.js'

const START = Date.parse('2026-01-15T10:00:00.000Z')
const HOUR = 60 * 60 * 1000

function toText(lines: Line[]): string {
  return lines.map((line) => ('raw' in line ? line.raw : JSON.stringify(line))).join('\n') + '\n'
}

describe('parseTranscript over the standalone scenario fixtures', () => {
  test('main-session: every everyday tool, ending after a text end_turn', () => {
    const start = START
    const sid = sessionId('1')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(mainSessionLines(start, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })

    expect(result.unparsed).toBe(0)
    expect(result.versions).toEqual([FIXTURE_VERSION])
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'permission_mode', ts: at(0), agentId: sid, mode: 'default' },
      // attachment (step 1) is ignored
      { t: 'permission_mode', ts: at(2), agentId: sid, mode: 'default' },
      { t: 'prompt', ts: at(2), agentId: sid },
      { t: 'tool_start', ts: at(3), agentId: sid, toolUseId: toolUseId(1), name: 'Read', target: 'README.md' },
      { t: 'assistant', ts: at(3), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: true, text: false },
      { t: 'tool_end', ts: at(4), agentId: sid, toolUseId: toolUseId(1), isError: false, denied: false },
      { t: 'tool_start', ts: at(5), agentId: sid, toolUseId: toolUseId(2), name: 'Edit', target: 'README.md' },
      { t: 'assistant', ts: at(5), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(6), agentId: sid, toolUseId: toolUseId(2), isError: false, denied: false },
      { t: 'tool_start', ts: at(7), agentId: sid, toolUseId: toolUseId(3), name: 'Bash', target: 'npm' },
      { t: 'assistant', ts: at(7), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(8), agentId: sid, toolUseId: toolUseId(3), isError: false, denied: false },
      { t: 'tool_start', ts: at(9), agentId: sid, toolUseId: toolUseId(4), name: 'Grep', target: 'src' },
      { t: 'assistant', ts: at(9), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(10), agentId: sid, toolUseId: toolUseId(4), isError: false, denied: false },
      { t: 'tool_start', ts: at(11), agentId: sid, toolUseId: toolUseId(5), name: 'WebFetch', target: 'example.com' },
      { t: 'assistant', ts: at(11), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(12), agentId: sid, toolUseId: toolUseId(5), isError: false, denied: false },
      { t: 'assistant', ts: at(13), agentId: sid, model: 'claude-sonnet-5', tokensOut: 24, thinking: false, text: true },
      { t: 'turn_end', ts: at(13), agentId: sid },
      { t: 'turn_end', ts: at(14), agentId: sid },
      // ai-title (step 15) is ignored
    ])
  })

  test('background-worker: sessionKind bg, a label, and an open Bash', () => {
    const start = START + HOUR
    const sid = sessionId('2')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(backgroundWorkerLines(start, sid, DEMO_CWD)), {
      agentId: sid,
      kind: 'session',
    })

    expect(result.unparsed).toBe(0)
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'background', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'agent_meta', ts: at(0), agentId: sid, label: 'demo-worker' },
      { t: 'prompt', ts: at(1), agentId: sid },
      { t: 'tool_start', ts: at(2), agentId: sid, toolUseId: toolUseId(1), name: 'Bash', target: 'npm' },
      { t: 'assistant', ts: at(2), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
    ])
  })

  test('explore (full): parent delegates, subagent runs Glob then Read and finishes, parent finishes', () => {
    const start = START + 2 * HOUR
    const parentSid = sessionId('3')
    const aid = subagentId('e1')
    const explore = exploreScenario(start, parentSid, DEMO_CWD, aid, { full: true })

    const pat = (step: number) => ts(start, step)
    const parentResult = parseTranscript(toText(explore.parentLines), { agentId: parentSid, kind: 'session' })
    expect(parentResult.unparsed).toBe(0)
    expect(parentResult.events).toEqual([
      { t: 'agent_meta', ts: pat(0), agentId: parentSid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: pat(0), agentId: parentSid },
      {
        t: 'tool_start',
        ts: pat(1),
        agentId: parentSid,
        toolUseId: toolUseId(1),
        name: 'Agent',
        target: 'Explore',
        subagentType: 'Explore',
      },
      { t: 'assistant', ts: pat(1), agentId: parentSid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: pat(2), agentId: parentSid, toolUseId: toolUseId(1), isError: false, denied: false },
      { t: 'assistant', ts: pat(3), agentId: parentSid, model: 'claude-sonnet-5', tokensOut: 16, thinking: false, text: true },
      { t: 'turn_end', ts: pat(3), agentId: parentSid },
      { t: 'turn_end', ts: pat(4), agentId: parentSid },
    ])

    const sat = (step: number) => ts(start, 20 + step)
    const subResult = parseTranscript(toText(explore.subagentLines), {
      agentId: aid,
      kind: 'subagent',
      parentId: parentSid,
    })
    expect(subResult.unparsed).toBe(0)
    expect(subResult.events).toEqual([
      { t: 'agent_meta', ts: sat(0), agentId: aid, kind: 'subagent', parentId: parentSid, cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: sat(0), agentId: aid },
      { t: 'tool_start', ts: sat(1), agentId: aid, toolUseId: toolUseId(101), name: 'Glob' },
      { t: 'assistant', ts: sat(1), agentId: aid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: sat(2), agentId: aid, toolUseId: toolUseId(101), isError: false, denied: false },
      { t: 'tool_start', ts: sat(3), agentId: aid, toolUseId: toolUseId(102), name: 'Read', target: 'index.ts' },
      { t: 'assistant', ts: sat(3), agentId: aid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: sat(4), agentId: aid, toolUseId: toolUseId(102), isError: false, denied: false },
      { t: 'assistant', ts: sat(5), agentId: aid, model: 'claude-sonnet-5', tokensOut: 18, thinking: false, text: true },
      { t: 'turn_end', ts: sat(5), agentId: aid },
      { t: 'turn_end', ts: sat(6), agentId: aid },
    ])

    // A3: the sidecar's toolUseId is the parent's spawn id, so the two files can be linked.
    expect(explore.meta.toolUseId).toBe(toolUseId(1))
  })

  test('compaction: a finished compact_boundary, a skipped summary, then normal work continues', () => {
    const start = START + 3 * HOUR
    const sid = sessionId('4')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(compactionLines(start, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })

    expect(result.unparsed).toBe(0)
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: at(0), agentId: sid },
      { t: 'tool_start', ts: at(1), agentId: sid, toolUseId: toolUseId(1), name: 'Bash', target: 'git' },
      { t: 'assistant', ts: at(1), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(2), agentId: sid, toolUseId: toolUseId(1), isError: false, denied: false },
      { t: 'compaction', ts: at(3), agentId: sid, trigger: 'auto' },
      // the isCompactSummary user record (step 4) is skipped
      { t: 'tool_start', ts: at(5), agentId: sid, toolUseId: toolUseId(2), name: 'Edit', target: 'NOTES.md' },
      { t: 'assistant', ts: at(5), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(6), agentId: sid, toolUseId: toolUseId(2), isError: false, denied: false },
      { t: 'assistant', ts: at(7), agentId: sid, model: 'claude-sonnet-5', tokensOut: 12, thinking: false, text: true },
      { t: 'turn_end', ts: at(7), agentId: sid },
      { t: 'turn_end', ts: at(8), agentId: sid },
    ])
  })

  test('rate-limit: a retrying system api_error, then a terminal rate_limit api_error', () => {
    const start = START + 4 * HOUR
    const sid = sessionId('5')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(rateLimitLines(start, sid, SHOP_CWD)), { agentId: sid, kind: 'session' })

    expect(result.unparsed).toBe(0)
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: SHOP_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: at(0), agentId: sid },
      { t: 'tool_start', ts: at(1), agentId: sid, toolUseId: toolUseId(1), name: 'Bash', target: 'npm' },
      { t: 'assistant', ts: at(1), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'api_error', ts: at(2), agentId: sid, kind: 'rate_limit', status: 429, retrying: true },
      {
        t: 'api_error',
        ts: at(3),
        agentId: sid,
        kind: 'rate_limit',
        retrying: false,
        message: 'API Error: rate limit exceeded, please retry later',
      },
    ])
  })

  test('api-error: a non-retrying, non-rate-limit terminal failure', () => {
    const start = START + 5 * HOUR
    const sid = sessionId('6')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(apiErrorLines(start, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })

    expect(result.unparsed).toBe(0)
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: at(0), agentId: sid },
      { t: 'tool_start', ts: at(1), agentId: sid, toolUseId: toolUseId(1), name: 'Write', target: 'OUT.md' },
      { t: 'assistant', ts: at(1), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(2), agentId: sid, toolUseId: toolUseId(1), isError: false, denied: false },
      {
        t: 'api_error',
        ts: at(3),
        agentId: sid,
        kind: 'other',
        retrying: false,
        message: 'API Error: invalid request: missing required field',
      },
    ])
  })

  test('permission-wait: an explicit permission-mode record, then an open, non-exempt tool', () => {
    const start = START + 6 * HOUR
    const sid = sessionId('7')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(permissionWaitLines(start, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })

    expect(result.unparsed).toBe(0)
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'permission_mode', ts: at(0), agentId: sid, mode: 'default' },
      { t: 'permission_mode', ts: at(1), agentId: sid, mode: 'default' },
      { t: 'prompt', ts: at(1), agentId: sid },
      { t: 'tool_start', ts: at(2), agentId: sid, toolUseId: toolUseId(1), name: 'Bash', target: 'rm' },
      { t: 'assistant', ts: at(2), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
    ])
  })

  test('permission-denied: a denied tool_result carries isError and denied', () => {
    const start = START + 7 * HOUR
    const sid = sessionId('8')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(permissionDeniedLines(start, sid, DEMO_CWD)), {
      agentId: sid,
      kind: 'session',
    })

    expect(result.unparsed).toBe(0)
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: at(0), agentId: sid },
      { t: 'tool_start', ts: at(1), agentId: sid, toolUseId: toolUseId(1), name: 'Bash', target: 'rm' },
      { t: 'assistant', ts: at(1), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'tool_end', ts: at(2), agentId: sid, toolUseId: toolUseId(1), isError: true, denied: true },
      { t: 'assistant', ts: at(3), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: true },
      { t: 'turn_end', ts: at(3), agentId: sid },
      { t: 'turn_end', ts: at(4), agentId: sid },
    ])
  })

  test('interrupted: the exact marker text clears the open tool with no matching result', () => {
    const start = START + 8 * HOUR
    const sid = sessionId('9')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(interruptedLines(start, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })

    expect(result.unparsed).toBe(0)
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: at(0), agentId: sid },
      { t: 'tool_start', ts: at(1), agentId: sid, toolUseId: toolUseId(1), name: 'Bash', target: 'npm' },
      { t: 'assistant', ts: at(1), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: false },
      { t: 'interrupted', ts: at(2), agentId: sid },
    ])
  })

  test('malformed: three unparseable lines each count as a diagnostic instead of throwing', () => {
    const start = START + 9 * HOUR
    const sid = sessionId('a')
    const at = (step: number) => ts(start, step)
    const result = parseTranscript(toText(malformedLines(start, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })

    expect(result.unparsed).toBe(3)
    expect(result.unknownTypes).toEqual({
      'future-thing': 1,
      'system:unknown_future_subtype': 1,
    })
    expect(result.events).toEqual([
      { t: 'agent_meta', ts: at(0), agentId: sid, kind: 'session', cwd: DEMO_CWD, version: FIXTURE_VERSION },
      { t: 'prompt', ts: at(0), agentId: sid },
      // step 1's line ("raw") is truncated JSON: no ts is advanced for it, unparsed +1
      { t: 'assistant', ts: at(1), agentId: sid, model: 'claude-sonnet-5', tokensOut: 10, thinking: false, text: true },
      { t: 'turn_end', ts: at(1), agentId: sid },
      // step 2 ("future-thing") and step 3 (unknown system subtype) are unparsed, no events
      { t: 'turn_end', ts: at(4), agentId: sid },
    ])
  })

  test('parseTranscript never throws on any fixture, even the malformed one', () => {
    const start = START + 9 * HOUR
    const sid = sessionId('a')
    expect(() => parseTranscript(toText(malformedLines(start, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })).not.toThrow()
  })
})
