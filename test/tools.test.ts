import { describe, expect, test } from 'vitest'
import { initialParseState, parseLine } from '../src/core/transcript/parse.js'
import { isPermissionExempt, safeTarget, toolActivity } from '../src/core/transcript/tools.js'
import { reduce } from '../src/core/reducer.js'
import { publicWorld } from '../src/core/view.js'
import { emptyWorld } from '../src/core/world.js'

describe('toolActivity', () => {
  test('Read is reading, target is the file basename', () => {
    expect(toolActivity('Read', { file_path: '/home/user/projects/demo/README.md' })).toEqual({
      state: 'reading',
      target: 'README.md',
    })
  })

  test('Edit is editing, target is the file basename', () => {
    expect(toolActivity('Edit', { file_path: '/home/user/projects/demo/src/a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      state: 'editing',
      target: 'a.ts',
    })
  })

  test('Bash target is the command verb, not the full command or any argument', () => {
    expect(toolActivity('Bash', { command: 'npm test' })).toEqual({ state: 'running', target: 'npm' })
  })

  test('Bash skips leading VAR=value assignments and basenames an absolute path', () => {
    expect(toolActivity('Bash', { command: 'FOO=1 /usr/bin/git status' })).toEqual({
      state: 'running',
      target: 'git',
    })
  })

  // S1-16: a command that starts with a secret would have stored it as the "verb".
  test('a first word that looks like a secret is not a target', () => {
    for (const secret of [
      'sk-ant-FAKESECRET123',
      'ghp_FAKEFAKEFAKEFAKE',
      'xoxb-1234-5678',
      'AKIAIOSFODNN7EXAMPLE',
      'user@host',
      'token:abc',
      '--key=value',
      'a'.repeat(41),
    ]) {
      expect(toolActivity('Bash', { command: `${secret} --flag` }), secret).toEqual({ state: 'running', target: undefined })
    }
    expect(toolActivity('Bash', { command: 'a'.repeat(40) }).target).toBe('a'.repeat(40))
    for (const verb of ['npm', 'git', 'node', 'python3', 'cargo-nextest', 'my_script.sh']) {
      expect(toolActivity('Bash', { command: `${verb} run` }).target, verb).toBe(verb)
    }
  })

  test('Grep never returns the pattern as a target', () => {
    expect(toolActivity('Grep', { pattern: 'password123', path: '/home/user/projects/demo/src' })).toEqual({
      state: 'searching',
      target: 'src',
    })
    expect(toolActivity('Grep', { pattern: 'password123' })).toEqual({ state: 'searching', target: undefined })
  })

  test('WebFetch target is the URL host, never the full URL', () => {
    expect(toolActivity('WebFetch', { url: 'https://example.com/secret/path?x=1' })).toEqual({
      state: 'browsing',
      target: 'example.com',
    })
  })

  test('WebSearch never returns the query as a target', () => {
    expect(toolActivity('WebSearch', { query: 'anything at all' })).toEqual({ state: 'browsing', target: undefined })
  })

  test('Agent/Task delegate, target is the subagent type', () => {
    expect(toolActivity('Agent', { subagent_type: 'Explore', description: 'x', prompt: 'y' })).toEqual({
      state: 'delegating',
      target: 'Explore',
    })
    expect(toolActivity('Task', { subagent_type: 'Plan' })).toEqual({ state: 'delegating', target: 'Plan' })
  })

  test('an unknown tool is running with no target', () => {
    expect(toolActivity('SomeFutureTool', { anything: 'here' })).toEqual({ state: 'running', target: undefined })
  })
})

describe('isPermissionExempt', () => {
  test('Read, Grep and Agent are always exempt', () => {
    expect(isPermissionExempt('Read', 'default')).toBe(true)
    expect(isPermissionExempt('Grep', 'default')).toBe(true)
    expect(isPermissionExempt('Agent', 'default')).toBe(true)
  })

  test('Bash is not exempt in default mode', () => {
    expect(isPermissionExempt('Bash', 'default')).toBe(false)
  })

  test('acceptEdits mode additionally exempts editing tools, but not Bash', () => {
    expect(isPermissionExempt('Edit', 'acceptEdits')).toBe(true)
    expect(isPermissionExempt('Write', 'acceptEdits')).toBe(true)
    expect(isPermissionExempt('Edit', 'default')).toBe(false)
    expect(isPermissionExempt('Bash', 'acceptEdits')).toBe(false)
  })
})

// R2-7: a target from a transcript follows the collector's rule (one function, safeTarget): at most 100
// characters, no control character, no path separator. Otherwise it is dropped, not cut.
describe('safeTarget and the targets of toolActivity (R2-7)', () => {
  const BIG = 'A'.repeat(200_000)

  test('safeTarget keeps a plain name up to 100 characters and drops everything else', () => {
    expect(safeTarget('README.md')).toBe('README.md')
    expect(safeTarget('a'.repeat(100))).toBe('a'.repeat(100))
    expect(safeTarget('a'.repeat(101))).toBeUndefined()
    expect(safeTarget('a/b')).toBeUndefined()
    expect(safeTarget('a\\b')).toBeUndefined()
    for (const bad of ['a\u0007b', 'a\u001bb', 'a\u007fb', 'a\nb', '']) expect(safeTarget(bad), JSON.stringify(bad)).toBeUndefined()
    expect(safeTarget(undefined)).toBeUndefined()
  })

  // Booleans, so that a failure does not print 200,000 characters.
  test('the probe: a 200,000-character file name with an OSC sequence, a subagent type and a host', () => {
    expect(toolActivity('Read', { file_path: `/tmp/${BIG}\u001b]0;title\u0007` }).target === undefined, 'Read').toBe(true)
    expect(toolActivity('Agent', { subagent_type: BIG, description: 'x', prompt: 'y' }).target === undefined, 'Agent').toBe(true)
    expect(toolActivity('WebFetch', { url: `https://${'b'.repeat(250)}.example/x` }).target === undefined, 'WebFetch').toBe(true)
    expect(toolActivity('Bash', { command: `${BIG} --flag` }).target === undefined, 'Bash').toBe(true)
  })

  test('a target of exactly 100 characters is kept, one of 101 is not', () => {
    expect(toolActivity('Read', { file_path: `/x/${'n'.repeat(100)}` }).target).toBe('n'.repeat(100))
    expect(toolActivity('Read', { file_path: `/x/${'n'.repeat(101)}` }).target === undefined).toBe(true)
  })

  test('a control character in a file name drops the target', () => {
    expect(toolActivity('Read', { file_path: '/x/a\u001b[2Jb.ts' }).target).toBeUndefined()
  })

  test('the World built from the probe stays small', () => {
    const sid = '11111111-2222-4333-8444-555555555555'
    const record = (id: string, name: string, input: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'assistant',
        sessionId: sid,
        timestamp: '2026-10-03T10:00:00.000Z',
        cwd: '/work/demo',
        version: '2.1.288',
        message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
      })
    let state = initialParseState()
    let world = emptyWorld('2026-10-03T10:00:00.000Z', '/root')
    for (const line of [
      record('toolu_1', 'Read', { file_path: `/tmp/${BIG}\u001b]0;title\u0007` }),
      record('toolu_2', 'Agent', { subagent_type: BIG, description: 'x', prompt: 'y' }),
      record('toolu_3', 'WebFetch', { url: `https://${'b'.repeat(250)}.example/x` }),
    ]) {
      const parsed = parseLine(line, { agentId: sid, kind: 'session' }, state)
      state = parsed.state
      for (const event of parsed.events) world = reduce(world, event)
    }
    expect(JSON.stringify(publicWorld(world)).length).toBeLessThan(5000) // 401,514 before the cap
  })
})
