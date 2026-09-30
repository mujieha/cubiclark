import { describe, expect, test } from 'vitest'
import { fromAgentName, fromAssistant, fromPermissionMode, fromSystem, fromUser } from '../src/core/transcript/records.js'

const ctx = { agentId: 'a1' }
const ts = '2026-01-15T10:00:00.000Z'

describe('fromUser', () => {
  test('a plain string prompt', () => {
    expect(fromUser({ message: { role: 'user', content: 'lorem ipsum' } }, ctx, ts)).toEqual({
      events: [{ t: 'prompt', ts, agentId: 'a1' }],
    })
  })

  test('a prompt as a text content block', () => {
    expect(
      fromUser({ message: { role: 'user', content: [{ type: 'text', text: 'lorem ipsum' }] } }, ctx, ts)
    ).toEqual({ events: [{ t: 'prompt', ts, agentId: 'a1' }] })
  })

  test('isMeta records are skipped', () => {
    expect(fromUser({ isMeta: true, message: { role: 'user', content: 'lorem' } }, ctx, ts)).toEqual({ events: [] })
  })

  test('isCompactSummary records are skipped', () => {
    expect(fromUser({ isCompactSummary: true, message: { role: 'user', content: 'lorem' } }, ctx, ts)).toEqual({
      events: [],
    })
  })

  test('local-command echoes are skipped', () => {
    expect(
      fromUser({ message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } }, ctx, ts)
    ).toEqual({ events: [] })
  })

  test('the exact interrupt text produces an interrupted event, not a prompt', () => {
    expect(fromUser({ message: { role: 'user', content: '[Request interrupted by user]' } }, ctx, ts)).toEqual({
      events: [{ t: 'interrupted', ts, agentId: 'a1' }],
    })
  })

  test('a tool_result produces a tool_end event', () => {
    expect(
      fromUser(
        { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx1', content: 'ok' }] } },
        ctx,
        ts
      )
    ).toEqual({ events: [{ t: 'tool_end', ts, agentId: 'a1', toolUseId: 'toolu_fx1', isError: false, denied: false }] })
  })

  test('a denied tool_result sets denied true', () => {
    expect(
      fromUser(
        {
          toolDenialKind: 'user_rejected',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_fx1', content: 'no', is_error: true }],
          },
        },
        ctx,
        ts
      )
    ).toEqual({ events: [{ t: 'tool_end', ts, agentId: 'a1', toolUseId: 'toolu_fx1', isError: true, denied: true }] })
  })

  test('permissionMode on a user record produces a permission_mode event alongside the prompt', () => {
    expect(fromUser({ permissionMode: 'default', message: { role: 'user', content: 'lorem' } }, ctx, ts)).toEqual({
      events: [
        { t: 'permission_mode', ts, agentId: 'a1', mode: 'default' },
        { t: 'prompt', ts, agentId: 'a1' },
      ],
    })
  })
})

describe('fromAssistant', () => {
  test('a tool_use block produces tool_start, target from the tool table', () => {
    const result = fromAssistant(
      {
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'tool_use', id: 'toolu_fx1', name: 'Read', input: { file_path: '/a/b/c.md' } }],
          stop_reason: 'tool_use',
        },
      },
      ctx,
      ts
    )
    expect(result.events).toContainEqual({
      t: 'tool_start',
      ts,
      agentId: 'a1',
      toolUseId: 'toolu_fx1',
      name: 'Read',
      target: 'c.md',
    })
  })

  test('a text block with stop_reason end_turn and no tool_use produces turn_end', () => {
    const result = fromAssistant(
      {
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: { output_tokens: 5 },
        },
      },
      ctx,
      ts
    )
    expect(result.events).toEqual([
      { t: 'assistant', ts, agentId: 'a1', model: 'claude-sonnet-5', tokensOut: 5, thinking: false, text: true },
      { t: 'turn_end', ts, agentId: 'a1' },
    ])
  })

  test('the <synthetic> model is treated as absent', () => {
    const result = fromAssistant(
      { message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } },
      ctx,
      ts
    )
    const assistantEvent = result.events.find((e) => e.t === 'assistant')
    expect(assistantEvent).toMatchObject({ model: undefined })
  })

  test('isApiErrorMessage: false, even with the key present, is not an error', () => {
    const result = fromAssistant(
      {
        isApiErrorMessage: false,
        message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' },
      },
      ctx,
      ts
    )
    expect(result.events.some((e) => e.t === 'api_error')).toBe(false)
  })

  test('isApiErrorMessage: true with a known error field produces api_error, not assistant', () => {
    const result = fromAssistant(
      {
        isApiErrorMessage: true,
        error: 'rate_limit',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: rate limit' }], stop_reason: 'end_turn' },
      },
      ctx,
      ts
    )
    expect(result.events).toEqual([
      { t: 'api_error', ts, agentId: 'a1', kind: 'rate_limit', retrying: false, message: 'API Error: rate limit' },
    ])
  })

  // S1-16: free text from a transcript reaches the card and the tooltip, so it is cleaned first.
  test('an API error message has no control characters or absolute paths, and is capped', () => {
    const text = `API Error\u001b]0;TITLE\u0007 at /Users/someone/work/x.ts:1\n${'y'.repeat(400)}`
    const result = fromAssistant(
      { isApiErrorMessage: true, error: 'x', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } },
      ctx,
      ts
    )
    const message = result.events[0]?.t === 'api_error' ? result.events[0].message : undefined
    expect(message).toBeDefined()
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(message).not.toContain('/Users/')
    expect(message?.length).toBeLessThanOrEqual(200)
    expect(message?.startsWith('API Error')).toBe(true)
  })

  test('isApiErrorMessage: true with an unrecognized error field falls back to "other"', () => {
    const result = fromAssistant(
      {
        isApiErrorMessage: true,
        error: 'billing_error',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: billing' }], stop_reason: 'end_turn' },
      },
      ctx,
      ts
    )
    expect(result.events[0]).toMatchObject({ kind: 'other' })
  })
})

describe('fromSystem', () => {
  test('turn_duration produces turn_end', () => {
    expect(fromSystem({ subtype: 'turn_duration', durationMs: 100 }, ctx, ts)).toEqual({
      events: [{ t: 'turn_end', ts, agentId: 'a1' }],
    })
  })

  test('compact_boundary produces compaction with its trigger', () => {
    expect(fromSystem({ subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }, ctx, ts)).toEqual({
      events: [{ t: 'compaction', ts, agentId: 'a1', trigger: 'auto' }],
    })
  })

  test('a retrying api_error (status 429) maps to rate_limit', () => {
    expect(
      fromSystem({ subtype: 'api_error', error: { status: 429 }, retryAttempt: 1, maxRetries: 5, retryInMs: 2000 }, ctx, ts)
    ).toEqual({ events: [{ t: 'api_error', ts, agentId: 'a1', kind: 'rate_limit', status: 429, retrying: true }] })
  })

  test('a retrying api_error (status 529) maps to overloaded', () => {
    expect(fromSystem({ subtype: 'api_error', error: { status: 529 } }, ctx, ts)).toEqual({
      events: [{ t: 'api_error', ts, agentId: 'a1', kind: 'overloaded', status: 529, retrying: true }],
    })
  })

  test('a known, ignored subtype produces no events and no unknownSubtype', () => {
    expect(fromSystem({ subtype: 'away_summary' }, ctx, ts)).toEqual({ events: [] })
  })

  test('an unrecognized subtype is reported as unknown', () => {
    expect(fromSystem({ subtype: 'something_new' }, ctx, ts)).toEqual({ events: [], unknownSubtype: 'something_new' })
  })

  test('a missing subtype is reported as unknown', () => {
    expect(fromSystem({}, ctx, ts)).toEqual({ events: [], unknownSubtype: '(missing)' })
  })
})

describe('fromPermissionMode', () => {
  test('produces a permission_mode event', () => {
    expect(fromPermissionMode({ permissionMode: 'bypassPermissions' }, ctx, ts)).toEqual({
      events: [{ t: 'permission_mode', ts, agentId: 'a1', mode: 'bypassPermissions' }],
    })
  })
})

describe('fromAgentName', () => {
  test('produces an agent_meta event carrying the label', () => {
    expect(fromAgentName({ agentName: 'demo-worker' }, ctx, ts)).toEqual({
      events: [{ t: 'agent_meta', ts, agentId: 'a1', label: 'demo-worker' }],
    })
  })
})
