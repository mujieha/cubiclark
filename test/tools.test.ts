import { describe, expect, test } from 'vitest'
import { isPermissionExempt, toolActivity } from '../src/core/transcript/tools.js'

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
