// Fixture settings.json texts for the hooks install tests. Every test that touches a settings
// file writes one of these into a temp dir; nothing here or in any test ever reads the real
// ~/.claude.

const canonicalValue = {
  permissions: { allow: ['Bash(npm test)'] },
  env: { FOO: 'bar' },
  hooks: {
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '/usr/local/bin/lint.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
  },
}

const canonical = JSON.stringify(canonicalValue, null, 2) + '\n'

/** null means "the file does not exist". */
export const SETTINGS_FIXTURES: Record<string, string | null> = {
  absent: null,
  empty: '{}\n',
  canonical,
  fourSpace: JSON.stringify(canonicalValue, null, 4),
  nonCanonical:
    '{"model":"x",   "hooks": {"Stop": [ {"hooks":[{"type":"command","command":"say done"}]} ]},\n"theme" : "dark"}',
  crlf: canonical.replace(/\n/g, '\r\n'),
  broken: '{ "hooks": { ',
  comments: '// a comment\n{}',
  hooksNotObject: '{"hooks": []}',
  rootArray: '[]',
}

/** The fixtures a settings file can legitimately be in (everything but the refusals). */
export const PARSEABLE_FIXTURES = ['empty', 'canonical', 'fourSpace', 'nonCanonical', 'crlf'] as const
export const REFUSED_FIXTURES = ['broken', 'comments', 'hooksNotObject', 'rootArray'] as const
