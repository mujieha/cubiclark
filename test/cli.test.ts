import { describe, expect, test } from 'vitest'
import { parseCli, resolveRoot } from '../src/cli.js'

describe('parseCli', () => {
  test('defaults', () => {
    expect(parseCli([])).toEqual({
      port: 4789,
      open: true,
      fixtureHome: undefined,
      sinceHours: 12,
      help: false,
      version: false,
    })
  })

  test('--port, --no-open, --fixture-home, --since-hours', () => {
    expect(parseCli(['--port', '5000', '--no-open', '--fixture-home', '/tmp/fixture', '--since-hours', '6'])).toEqual({
      port: 5000,
      open: false,
      fixtureHome: '/tmp/fixture',
      sinceHours: 6,
      help: false,
      version: false,
    })
  })

  test('--help and --version', () => {
    expect(parseCli(['--help']).help).toBe(true)
    expect(parseCli(['--version']).version).toBe(true)
  })

  test('an unknown flag throws', () => {
    expect(() => parseCli(['--not-a-real-flag'])).toThrow()
  })

  test('a non-numeric --port throws', () => {
    expect(() => parseCli(['--port', 'nope'])).toThrow()
  })

  test('a zero or negative --since-hours throws', () => {
    expect(() => parseCli(['--since-hours', '0'])).toThrow()
    expect(() => parseCli(['--since-hours', '-1'])).toThrow()
  })
})

describe('resolveRoot', () => {
  test('--fixture-home wins outright, and turns on fixture mode', () => {
    expect(resolveRoot('/tmp/fixture-home', { CLAUDE_CONFIG_DIR: '/should/not/matter' }, '/home/someone')).toEqual({
      root: '/tmp/fixture-home',
      fixtureMode: true,
    })
  })

  test('without --fixture-home, CLAUDE_CONFIG_DIR wins when set', () => {
    expect(resolveRoot(undefined, { CLAUDE_CONFIG_DIR: '/configured/dir' }, '/home/someone')).toEqual({
      root: '/configured/dir',
      fixtureMode: false,
    })
  })

  test('without --fixture-home or CLAUDE_CONFIG_DIR, falls back to homedir()/.claude', () => {
    expect(resolveRoot(undefined, {}, '/home/someone')).toEqual({
      root: '/home/someone/.claude',
      fixtureMode: false,
    })
  })

  test('an empty CLAUDE_CONFIG_DIR is treated as unset', () => {
    expect(resolveRoot(undefined, { CLAUDE_CONFIG_DIR: '' }, '/home/someone')).toEqual({
      root: '/home/someone/.claude',
      fixtureMode: false,
    })
  })
})
