import { describe, expect, test } from 'vitest'
import {
  HOOK_EVENT_NAMES,
  LIFECYCLE_HOOK_EVENTS,
  TOOL_HOOK_EVENTS,
  normaliseAgentId,
  serialiseStoredLine,
  toStoredLine,
} from '../src/core/hooks/whitelist.js'
import { SECRETS, SECRET_PAYLOADS } from './hook-secrets.js'

const TS = '2026-01-15T10:00:00.000Z'

const ALLOWED_KEYS = new Set([
  'v', 'ts', 'e', 'name', 'sid', 'aid', 'at', 'cwd', 'tool', 'tuid', 'target', 'src', 'model',
  'reason', 'trig', 'err', 'nt', 'pm', 'eff', 'intr',
])

describe('the event lists', () => {
  test('fifteen events in total, three of them tool events', () => {
    expect(HOOK_EVENT_NAMES).toHaveLength(15)
    expect(TOOL_HOOK_EVENTS).toEqual(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])
    expect(LIFECYCLE_HOOK_EVENTS).toHaveLength(12)
  })

  test('PostModelSwitch is installed and PreModelSwitch never is (it can block a model switch)', () => {
    expect(HOOK_EVENT_NAMES).toContain('PostModelSwitch')
    expect(HOOK_EVENT_NAMES as readonly string[]).not.toContain('PreModelSwitch')
  })
})

describe('PostModelSwitch', () => {
  const base = { hook_event_name: 'PostModelSwitch', session_id: 's1' }

  test('only to_model is stored, as the model', () => {
    const line = toStoredLine({ ...base, from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5' }, TS)
    expect(line).toEqual({ v: 1, ts: TS, e: 'PostModelSwitch', sid: 's1', model: 'claude-sonnet-5-5' })
    expect(JSON.stringify(line)).not.toContain('opus')
  })

  test('a to_model that is not a plain name is dropped', () => {
    for (const bad of ['has a space', 'x'.repeat(101), '', 5, null, { a: 1 }, 'a/b', 'sk-ant\nline']) {
      expect(toStoredLine({ ...base, to_model: bad }, TS).model, String(bad)).toBeUndefined()
    }
    expect(toStoredLine({ ...base, model: 'claude-sonnet-5-5' }, TS).model).toBeUndefined() // only to_model is read
  })

  test('nothing else of the payload is stored, whatever it holds', () => {
    const line = toStoredLine({ ...base, to_model: 'claude-sonnet-5-5', from_model: 'SECRET-FROM', prompt: 'SECRET-PROMPT', extra: { deep: 'SECRET-DEEP' } }, TS)
    expect(Object.keys(line).sort()).toEqual(['e', 'model', 'sid', 'ts', 'v'])
    expect(JSON.stringify(line)).not.toContain('SECRET')
  })
})

describe('the secrets test', () => {
  test('a payload full of fake secrets stores none of them', () => {
    const text = SECRET_PAYLOADS.map((p) => serialiseStoredLine(toStoredLine(p, TS))).join('')
    // Not vacuous: the safe parts of those payloads really were stored.
    expect(text).toContain('"e":"PreToolUse"')
    expect(text).toContain('"target":"curl"')
    expect(text).toContain('"target":".env"')
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    for (const piece of ['FAKE', 'fake', 'Bearer', 'token=', 'KEY=']) expect(text).not.toContain(piece)
  })

  test('every stored line stays inside the whitelisted key set and under 2 KiB', () => {
    for (const payload of SECRET_PAYLOADS) {
      const line = toStoredLine(payload, TS)
      for (const key of Object.keys(line)) expect(ALLOWED_KEYS.has(key)).toBe(true)
      expect(serialiseStoredLine(line).length).toBeLessThan(2048)
    }
  })
})

describe('what each event keeps', () => {
  test('SessionStart keeps source and model', () => {
    expect(
      toStoredLine(
        { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/home/user/projects/demo', source: 'resume', model: 'claude-opus-5-5', permission_mode: 'default' },
        TS
      )
    ).toEqual({ v: 1, ts: TS, e: 'SessionStart', sid: 's1', cwd: '/home/user/projects/demo', src: 'resume', model: 'claude-opus-5-5', pm: 'default' })
  })

  test('UserPromptSubmit drops the prompt', () => {
    expect(toStoredLine({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hello' }, TS)).toEqual({
      v: 1, ts: TS, e: 'UserPromptSubmit', sid: 's1',
    })
  })

  test('PreToolUse keeps the tool, its id and a reduced target', () => {
    expect(
      toStoredLine(
        {
          hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_use_id: 'toolu_1',
          tool_input: { file_path: '/home/user/projects/demo/src/a.ts' }, effort: { level: 'high' },
        },
        TS
      )
    ).toEqual({ v: 1, ts: TS, e: 'PreToolUse', sid: 's1', tool: 'Read', tuid: 'toolu_1', target: 'a.ts', eff: 'high' })
  })

  test('a Bash command is reduced to its first word', () => {
    const line = toStoredLine(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'npm test -- --watch' } },
      TS
    )
    expect(line.target).toBe('npm')
  })

  test('a WebFetch url is reduced to its host', () => {
    const line = toStoredLine(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'WebFetch', tool_use_id: 't', tool_input: { url: 'https://docs.example.invalid/a/b?q=1' } },
      TS
    )
    expect(line.target).toBe('docs.example.invalid')
  })

  test('an Agent call keeps the subagent type as its target', () => {
    const line = toStoredLine(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 't', tool_input: { subagent_type: 'Explore', prompt: 'look around' } },
      TS
    )
    expect(line.target).toBe('Explore')
  })

  test('PostToolUse keeps only the tool and its id', () => {
    expect(
      toStoredLine(
        { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't9', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' } },
        TS
      )
    ).toEqual({ v: 1, ts: TS, e: 'PostToolUse', sid: 's1', tool: 'Bash', tuid: 't9', target: 'ls' })
  })

  test('PostToolUseFailure keeps the interrupt flag and drops the error text', () => {
    expect(
      toStoredLine(
        { hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash', tool_use_id: 't9', error: 'Exit code 1', is_interrupt: true },
        TS
      )
    ).toEqual({ v: 1, ts: TS, e: 'PostToolUseFailure', sid: 's1', tool: 'Bash', tuid: 't9', intr: true })
  })

  test('PermissionRequest keeps the tool and target', () => {
    expect(
      toStoredLine(
        { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } },
        TS
      )
    ).toEqual({ v: 1, ts: TS, e: 'PermissionRequest', sid: 's1', tool: 'Bash', target: 'rm' })
  })

  test('Notification keeps the type only', () => {
    expect(
      toStoredLine({ hook_event_name: 'Notification', session_id: 's1', notification_type: 'idle_prompt', message: 'x', title: 'y' }, TS)
    ).toEqual({ v: 1, ts: TS, e: 'Notification', sid: 's1', nt: 'idle_prompt' })
  })

  test('Stop and StopFailure', () => {
    expect(toStoredLine({ hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'x' }, TS)).toEqual({
      v: 1, ts: TS, e: 'Stop', sid: 's1',
    })
    expect(toStoredLine({ hook_event_name: 'StopFailure', session_id: 's1', error: 'overloaded', error_details: 'x' }, TS)).toEqual({
      v: 1, ts: TS, e: 'StopFailure', sid: 's1', err: 'overloaded',
    })
  })

  test('SubagentStart and SubagentStop keep the agent id and type', () => {
    expect(toStoredLine({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-abc', agent_type: 'Explore' }, TS)).toEqual({
      v: 1, ts: TS, e: 'SubagentStart', sid: 's1', aid: 'abc', at: 'Explore',
    })
    expect(toStoredLine({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'def456', agent_type: 'Plan', last_assistant_message: 'x' }, TS)).toEqual({
      v: 1, ts: TS, e: 'SubagentStop', sid: 's1', aid: 'def456', at: 'Plan',
    })
  })

  test('PreCompact and PostCompact keep the trigger', () => {
    expect(toStoredLine({ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'manual', custom_instructions: 'x' }, TS)).toEqual({
      v: 1, ts: TS, e: 'PreCompact', sid: 's1', trig: 'manual',
    })
    expect(toStoredLine({ hook_event_name: 'PostCompact', session_id: 's1', trigger: 'auto', compact_summary: 'x' }, TS)).toEqual({
      v: 1, ts: TS, e: 'PostCompact', sid: 's1', trig: 'auto',
    })
  })

  test('SessionEnd keeps the reason', () => {
    expect(toStoredLine({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'logout' }, TS)).toEqual({
      v: 1, ts: TS, e: 'SessionEnd', sid: 's1', reason: 'logout',
    })
  })
})

describe('validation', () => {
  test('normaliseAgentId strips one leading agent- and nothing else', () => {
    expect(normaliseAgentId('agent-abc')).toBe('abc')
    expect(normaliseAgentId('def456')).toBe('def456')
    expect(normaliseAgentId('agent-agent-x')).toBe('agent-x')
  })

  test('unknown enum values: reason and error fall back, the others are dropped', () => {
    expect(toStoredLine({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'because' }, TS).reason).toBe('other')
    expect(toStoredLine({ hook_event_name: 'StopFailure', session_id: 's1', error: 'new_kind' }, TS).err).toBe('unknown')
    // the reference documents the matcher as `error_type`; the payload spelling is not shown
    expect(toStoredLine({ hook_event_name: 'StopFailure', session_id: 's1', error_type: 'rate_limit' }, TS).err).toBe('rate_limit')
    const dropped = toStoredLine(
      {
        hook_event_name: 'Notification', session_id: 's1', notification_type: 'made_up',
        permission_mode: 'made_up', effort: { level: 'made_up' },
      },
      TS
    )
    expect(dropped).toEqual({ v: 1, ts: TS, e: 'Notification', sid: 's1' })
    expect(toStoredLine({ hook_event_name: 'SessionStart', session_id: 's1', source: 'made_up' }, TS).src).toBeUndefined()
    expect(toStoredLine({ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'made_up' }, TS).trig).toBeUndefined()
  })

  test('a relative or overlong cwd is dropped, an absolute one kept', () => {
    expect(toStoredLine({ hook_event_name: 'Stop', session_id: 's1', cwd: 'relative/dir' }, TS).cwd).toBeUndefined()
    expect(toStoredLine({ hook_event_name: 'Stop', session_id: 's1', cwd: '/' + 'a'.repeat(1100) }, TS).cwd).toBeUndefined()
    expect(toStoredLine({ hook_event_name: 'Stop', session_id: 's1', cwd: '/a/b\nc' }, TS).cwd).toBeUndefined()
    expect(toStoredLine({ hook_event_name: 'Stop', session_id: 's1', cwd: '/a/b' }, TS).cwd).toBe('/a/b')
  })

  test('a target with a backslash, a control character or over 100 characters is dropped', () => {
    const base = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't' }
    expect(toStoredLine({ ...base, tool_input: { command: 'C:\\tools\\x.exe --flag' } }, TS).target).toBeUndefined()
    expect(toStoredLine({ ...base, tool_input: { command: 'a'.repeat(101) } }, TS).target).toBeUndefined()
    expect(toStoredLine({ ...base, tool_input: { command: 'ok' } }, TS).target).toBe('ok')
    // S1-16: a command that starts with a credential stores nothing
    for (const first of ['sk-ant-FAKESECRET123', 'ghp_FAKEFAKEFAKEFAKE', 'AKIAIOSFODNN7EXAMPLE', 'me@host']) {
      const line = toStoredLine({ ...base, tool_input: { command: `${first} --flag` } }, TS)
      expect(line.target, first).toBeUndefined()
      expect(JSON.stringify(line)).not.toContain(first)
    }
  })

  test('a non-object tool_input is treated as empty', () => {
    const line = toStoredLine(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't', tool_input: 'oops' },
      TS
    )
    expect(line.target).toBeUndefined()
    expect(line.tool).toBe('Bash')
  })
})

describe('malformed and unknown input', () => {
  test('anything that is not a plain object is _malformed', () => {
    for (const bad of [undefined, null, [], 'x', 42, true]) {
      expect(toStoredLine(bad, TS)).toEqual({ v: 1, ts: TS, e: '_malformed' })
    }
  })

  test('an unknown event is _unknown, with its name only when it looks like a name', () => {
    expect(toStoredLine({ hook_event_name: 'FutureThing', session_id: 's1' }, TS)).toEqual({
      v: 1, ts: TS, e: '_unknown', name: 'FutureThing',
    })
    expect(toStoredLine({ hook_event_name: 'not a name!', session_id: 's1' }, TS)).toEqual({ v: 1, ts: TS, e: '_unknown' })
    expect(toStoredLine({ session_id: 's1' }, TS)).toEqual({ v: 1, ts: TS, e: '_unknown' })
  })

  test('serialiseStoredLine is one JSON line with a trailing newline', () => {
    const text = serialiseStoredLine(toStoredLine({ hook_event_name: 'Stop', session_id: 's1' }, TS))
    expect(text.endsWith('\n')).toBe(true)
    expect(text.slice(0, -1).includes('\n')).toBe(false)
    expect(JSON.parse(text)).toEqual({ v: 1, ts: TS, e: 'Stop', sid: 's1' })
  })

  test('keys are written in the documented order', () => {
    const line = toStoredLine(
      {
        hook_event_name: 'PreToolUse', tool_use_id: 't', tool_name: 'Read', session_id: 's1',
        effort: { level: 'low' }, tool_input: { file_path: '/x/y.ts' }, agent_id: 'agent-z', agent_type: 'Explore',
      },
      TS
    )
    expect(Object.keys(line)).toEqual(['v', 'ts', 'e', 'sid', 'aid', 'at', 'tool', 'tuid', 'target', 'eff'])
  })
})
