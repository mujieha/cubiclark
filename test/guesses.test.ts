import { describe, expect, test } from 'vitest'
import { TRANSCRIPT_GUESSES } from '../src/core/transcript/guesses.js'
import { parseLine, initialParseState } from '../src/core/transcript/parse.js'
import { parseSubagentMeta } from '../src/core/transcript/meta.js'
import { fromUser } from '../src/core/transcript/records.js'

describe('TRANSCRIPT_GUESSES', () => {
  test('is pinned to the Claude Code version the key shapes were seen on', () => {
    expect(TRANSCRIPT_GUESSES.verifiedOn).toBe('2.1.284')
    expect(TRANSCRIPT_GUESSES.backgroundSessionKind).toBe('bg')
  })

  test('a record carrying the background session kind parses as a background agent', () => {
    const line = JSON.stringify({
      type: 'permission-mode',
      permissionMode: 'default',
      timestamp: '2026-01-15T10:00:00.000Z',
      sessionKind: TRANSCRIPT_GUESSES.backgroundSessionKind,
    })
    const result = parseLine(line, { agentId: 'a1', kind: 'session' }, initialParseState())
    const meta = result.events.find((e) => e.t === 'agent_meta')
    expect(meta).toMatchObject({ t: 'agent_meta', kind: 'background' })
  })

  test('a record with any other session kind stays a plain session', () => {
    const line = JSON.stringify({
      type: 'permission-mode',
      permissionMode: 'default',
      timestamp: '2026-01-15T10:00:00.000Z',
      sessionKind: 'something-else',
    })
    const result = parseLine(line, { agentId: 'a1', kind: 'session' }, initialParseState())
    const meta = result.events.find((e) => e.t === 'agent_meta')
    expect(meta).toMatchObject({ kind: 'session' })
  })

  test('the sidecar meta keys come from the constant', () => {
    const keys = TRANSCRIPT_GUESSES.subagentMetaKeys
    const text = JSON.stringify({
      [keys.agentType]: 'Explore',
      [keys.toolUseId]: 'toolu_1',
      [keys.name]: 'scout',
      [keys.spawnDepth]: 2,
    })
    const result = parseSubagentMeta(text)
    expect(result).toEqual({
      ok: true,
      meta: {
        agentType: 'Explore',
        description: undefined,
        toolUseId: 'toolu_1',
        model: undefined,
        name: 'scout',
        spawnDepth: 2,
      },
    })
  })

  test('the denial key comes from the constant, and only a non-empty string counts', () => {
    const base = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
    }
    const ts = '2026-01-15T10:00:00.000Z'
    const denied = fromUser({ ...base, [TRANSCRIPT_GUESSES.toolDenialKey]: 'user_reject' }, { agentId: 'a1' }, ts)
    expect(denied.events[0]).toMatchObject({ t: 'tool_end', denied: true })
    const empty = fromUser({ ...base, [TRANSCRIPT_GUESSES.toolDenialKey]: '' }, { agentId: 'a1' }, ts)
    expect(empty.events[0]).toMatchObject({ t: 'tool_end', denied: false })
    const absent = fromUser(base, { agentId: 'a1' }, ts)
    expect(absent.events[0]).toMatchObject({ t: 'tool_end', denied: false })
  })

  test('the api error field vocabulary comes from the constant', () => {
    expect(TRANSCRIPT_GUESSES.apiErrorKindByField).toEqual({ rate_limit: 'rate_limit', overloaded: 'overloaded' })
  })
})
