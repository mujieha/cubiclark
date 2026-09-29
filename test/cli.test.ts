import { describe, expect, test } from 'vitest'
import { parseCli, resolveRoot, resolveStateDir } from '../src/cli.js'

describe('parseCli: serve (the default command)', () => {
  test('defaults', () => {
    expect(parseCli([])).toEqual({
      command: 'serve',
      port: 4789,
      open: true,
      fixtureHome: undefined,
      sinceHours: 12,
      stateDir: undefined,
    })
  })

  test('--port, --no-open, --fixture-home, --since-hours, --state-dir', () => {
    expect(
      parseCli(['--port', '5000', '--no-open', '--fixture-home', '/tmp/fixture', '--since-hours', '6', '--state-dir', '/tmp/state'])
    ).toEqual({
      command: 'serve',
      port: 5000,
      open: false,
      fixtureHome: '/tmp/fixture',
      sinceHours: 6,
      stateDir: '/tmp/state',
    })
  })

  test('--help and --version', () => {
    expect(parseCli(['--help'])).toEqual({ command: 'help' })
    expect(parseCli(['--version'])).toEqual({ command: 'version' })
    expect(parseCli(['hooks', 'on', '--help'])).toEqual({ command: 'help' })
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

  test('an unknown subcommand throws', () => {
    expect(() => parseCli(['frobnicate'])).toThrow(/unknown command/)
  })

  test('flags that belong to other commands are refused, not silently ignored', () => {
    expect(() => parseCli(['--no-tools'])).toThrow()
    expect(() => parseCli(['--purge'])).toThrow()
    expect(() => parseCli(['--claude-bin', 'claude'])).toThrow()
    expect(() => parseCli(['--config-dir', '/x'])).toThrow()
  })
})

describe('parseCli: hook (the collector entry)', () => {
  test('hook ignores everything after it, so extra arguments from Claude Code cannot break it', () => {
    expect(parseCli(['hook'])).toEqual({ command: 'hook' })
    expect(parseCli(['hook', '--state-dir', '/x', '--whatever'])).toEqual({ command: 'hook' })
  })
})

describe('parseCli: hooks', () => {
  test('on, off, status, pause and resume', () => {
    expect(parseCli(['hooks', 'on'])).toEqual({
      command: 'hooks',
      action: 'on',
      tools: true,
      purge: false,
      configDir: undefined,
      stateDir: undefined,
    })
    expect(parseCli(['hooks', 'off']).command).toBe('hooks')
    for (const action of ['status', 'pause', 'resume'] as const) {
      expect(parseCli(['hooks', action])).toMatchObject({ command: 'hooks', action })
    }
  })

  test('--no-tools is for on, --purge is for off', () => {
    expect(parseCli(['hooks', 'on', '--no-tools'])).toMatchObject({ action: 'on', tools: false })
    expect(parseCli(['hooks', 'off', '--purge'])).toMatchObject({ action: 'off', purge: true })
    expect(() => parseCli(['hooks', 'off', '--no-tools'])).toThrow()
    expect(() => parseCli(['hooks', 'on', '--purge'])).toThrow()
    expect(() => parseCli(['hooks', 'status', '--no-tools'])).toThrow()
  })

  test('--config-dir and --state-dir pass through', () => {
    expect(parseCli(['hooks', 'on', '--config-dir', '/c', '--state-dir', '/s'])).toMatchObject({
      configDir: '/c',
      stateDir: '/s',
    })
  })

  test('a missing or unknown action throws', () => {
    expect(() => parseCli(['hooks'])).toThrow(/on\|off\|status\|pause\|resume/)
    expect(() => parseCli(['hooks', 'sideways'])).toThrow(/on\|off\|status\|pause\|resume/)
  })

  test('server flags are refused for hooks', () => {
    expect(() => parseCli(['hooks', 'on', '--port', '1'])).toThrow()
  })
})

describe('parseCli: doctor', () => {
  test('defaults', () => {
    expect(parseCli(['doctor'])).toEqual({
      command: 'doctor',
      configDir: undefined,
      fixtureHome: undefined,
      stateDir: undefined,
      sinceHours: 12,
      claudeBin: 'claude',
    })
  })

  test('flags', () => {
    expect(
      parseCli(['doctor', '--fixture-home', '/f', '--state-dir', '/s', '--claude-bin', '/bin/x', '--since-hours', '3', '--config-dir', '/c'])
    ).toEqual({
      command: 'doctor',
      configDir: '/c',
      fixtureHome: '/f',
      stateDir: '/s',
      sinceHours: 3,
      claudeBin: '/bin/x',
    })
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

describe('resolveStateDir', () => {
  test('the flag wins, then CUBICLARK_HOME, then ~/.cubiclark', () => {
    expect(resolveStateDir('/flag', { CUBICLARK_HOME: '/env' }, '/home/someone')).toBe('/flag')
    expect(resolveStateDir(undefined, { CUBICLARK_HOME: '/env' }, '/home/someone')).toBe('/env')
    expect(resolveStateDir(undefined, {}, '/home/someone')).toBe('/home/someone/.cubiclark')
  })

  test('an empty CUBICLARK_HOME is treated as unset', () => {
    expect(resolveStateDir(undefined, { CUBICLARK_HOME: '' }, '/home/someone')).toBe('/home/someone/.cubiclark')
  })
})
