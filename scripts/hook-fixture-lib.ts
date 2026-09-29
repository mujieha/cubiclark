// Synthetic hook payloads for test/fixtures/state/events.jsonl, in the shape Claude Code 2.1.284
// sends (docs: code.claude.com/docs/en/hooks). Every id, path and timestamp is invented, from
// the same families as the transcript fixtures. make-fixtures.ts runs each payload through the
// real whitelist (toStoredLine), so the fixture is exactly what the collector would have written.
//
// Two sessions, alongside the five transcript agents of test/fixtures/home:
//   ...0006  delegates to an Explore subagent, which is searching: session delegating, subagent
//            searching, parent linked by SubagentStart alone (no transcript exists for either)
//   ...0007  has a PermissionRequest open for `npm test`: waiting for permission, observed

import { DEMO_CWD, sessionId, subagentId, toolUseId } from './fixture-lib.js'

export interface HookFixtureEvent {
  ts: string
  payload: Record<string, unknown>
}

// Just after the newest transcript in the home world (10:01:50), so the fixture clock, which
// freezes at the newest record seen across both sources, stays a few seconds later than that.
const DELEGATING_START = Date.parse('2026-01-15T10:02:00.000Z')
const WAITING_START = Date.parse('2026-01-15T10:02:20.000Z')

function at(startMs: number, step: number): string {
  return new Date(startMs + step * 2000).toISOString()
}

export function hookFixtureEvents(): HookFixtureEvent[] {
  const delegatingSid = sessionId('6')
  const subagent = subagentId('e2')
  const waitingSid = sessionId('7')
  const common = (sid: string) => ({ session_id: sid, cwd: DEMO_CWD, permission_mode: 'default' })

  const delegating: HookFixtureEvent[] = [
    { ts: at(DELEGATING_START, 0), payload: { ...common(delegatingSid), hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' } },
    { ts: at(DELEGATING_START, 1), payload: { ...common(delegatingSid), hook_event_name: 'UserPromptSubmit' } },
    {
      ts: at(DELEGATING_START, 2),
      payload: {
        ...common(delegatingSid),
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_use_id: toolUseId(60),
        tool_input: { subagent_type: 'Explore' },
      },
    },
    {
      ts: at(DELEGATING_START, 3),
      payload: { ...common(delegatingSid), hook_event_name: 'SubagentStart', agent_id: `agent-${subagent}`, agent_type: 'Explore' },
    },
    {
      ts: at(DELEGATING_START, 4),
      payload: {
        ...common(delegatingSid),
        hook_event_name: 'PreToolUse',
        agent_id: `agent-${subagent}`,
        agent_type: 'Explore',
        tool_name: 'Read',
        tool_use_id: toolUseId(61),
        tool_input: { file_path: `${DEMO_CWD}/notes.md` },
      },
    },
    {
      ts: at(DELEGATING_START, 5),
      payload: {
        ...common(delegatingSid),
        hook_event_name: 'PostToolUse',
        agent_id: `agent-${subagent}`,
        agent_type: 'Explore',
        tool_name: 'Read',
        tool_use_id: toolUseId(61),
      },
    },
    {
      ts: at(DELEGATING_START, 6),
      payload: {
        ...common(delegatingSid),
        hook_event_name: 'PreToolUse',
        agent_id: `agent-${subagent}`,
        agent_type: 'Explore',
        tool_name: 'Grep',
        tool_use_id: toolUseId(62),
        tool_input: { pattern: 'lorem', path: DEMO_CWD },
      },
    },
  ]

  const waiting: HookFixtureEvent[] = [
    { ts: at(WAITING_START, 0), payload: { ...common(waitingSid), hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5' } },
    { ts: at(WAITING_START, 1), payload: { ...common(waitingSid), hook_event_name: 'UserPromptSubmit' } },
    {
      ts: at(WAITING_START, 2),
      payload: {
        ...common(waitingSid),
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: toolUseId(70),
        tool_input: { command: 'npm test' },
      },
    },
    {
      ts: at(WAITING_START, 3),
      payload: { ...common(waitingSid), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    },
  ]

  return [...delegating, ...waiting]
}
