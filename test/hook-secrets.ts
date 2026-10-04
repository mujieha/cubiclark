// Fake secrets and hook payloads stuffed with them. Shared by the whitelist unit test and the
// collector spawn test: whatever route a payload takes to disk, none of SECRETS may survive it.

export const SECRETS = [
  'sk-ant-api03-FAKEFAKEFAKEFAKE',
  'ghp_FAKEfakeFAKEfakeFAKEfake00',
  'AKIAFAKEFAKEFAKEFAKE',
  'hunter2-FAKE-password',
  'xoxb-FAKE-slack-token',
  'eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE',
  'BEGIN FAKE PRIVATE KEY',
  'fake-db-password-9f8e',
  'fake@example.invalid',
] as const

const [a, b, c, d, e, f, g, h, i] = SECRETS

export const SECRET_PAYLOADS: Record<string, unknown>[] = [
  { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/home/user/projects/demo', prompt: `use ${a} and ${b}` },
  {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'Bash',
    tool_use_id: 't1',
    tool_input: {
      command: `curl -H "Authorization: Bearer ${f}" https://user:${d}@api.example.invalid/x?token=${e}`,
      description: c,
    },
  },
  {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'Bash',
    tool_use_id: 't2',
    tool_input: { command: `AWS_SECRET=${c} aws s3 ls` },
  },
  {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'Write',
    tool_use_id: 't3',
    tool_input: { file_path: '/home/user/projects/demo/.env', content: `KEY=${a}\n${g}` },
  },
  {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'WebFetch',
    tool_use_id: 't4',
    tool_input: { url: `https://x:${d}@example.invalid/?k=${e}`, prompt: h },
  },
  {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_name: 'Read',
    tool_use_id: 't5',
    tool_input: { file_path: '/home/user/projects/demo/secrets.txt' },
    tool_response: { content: `${a}${b}${c}` },
  },
  {
    hook_event_name: 'PostToolUseFailure',
    session_id: 's1',
    tool_name: 'Bash',
    tool_use_id: 't6',
    error: `Exit code 1\n${h}`,
  },
  {
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: `echo ${b}` },
    permission_suggestions: [{ rules: [{ ruleContent: b }] }],
  },
  {
    hook_event_name: 'Notification',
    session_id: 's1',
    message: `token ${e}`,
    title: i,
    notification_type: 'permission_prompt',
  },
  {
    hook_event_name: 'Stop',
    session_id: 's1',
    last_assistant_message: `here is ${a}`,
    background_tasks: [{ command: `x ${c}` }],
    session_crons: [{ prompt: d }],
  },
  {
    hook_event_name: 'StopFailure',
    session_id: 's1',
    error: 'rate_limit',
    error_details: f,
    last_assistant_message: g,
  },
  {
    hook_event_name: 'SubagentStop',
    session_id: 's1',
    agent_id: 'agent-abc',
    agent_type: 'Explore',
    last_assistant_message: h,
  },
  { hook_event_name: 'PreCompact', session_id: 's1', trigger: 'manual', custom_instructions: i },
  { hook_event_name: 'PostCompact', session_id: 's1', trigger: 'auto', compact_summary: `${a} ${b}` },
  {
    hook_event_name: 'SessionStart',
    session_id: 's1',
    source: 'startup',
    model: 'claude-opus-5-5',
    session_title: e,
  },
  { hook_event_name: 'SessionEnd', session_id: 's1', reason: d },
  { hook_event_name: 'UserPromptSubmit', session_id: 's1', extra_future_field: a, nested: { deep: b } },
  { hook_event_name: 'NotARealEvent', session_id: 's1', leak: c },
  // Secrets inside id/name fields: the spaces make them fail ID_RE/NAME_RE, so they are dropped.
  // (A bare token like `a` would match ID_RE: an id that looks like a secret is indistinguishable
  // from a real session id, which is why this case adds the space.)
  { hook_event_name: 'PreToolUse', session_id: `${a} x`, tool_name: `Bash ${b}`, tool_use_id: `x ${c}` },
]
