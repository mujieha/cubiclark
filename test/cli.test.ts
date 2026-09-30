import { describe, expect, test } from 'vitest'
import { HELP_TEXT, parseCli, resolveRoot, resolveStateDir } from '../src/cli.js'

describe('parseCli: serve (the default command)', () => {
  test('defaults', () => {
    expect(parseCli([])).toEqual({
      command: 'serve',
      port: 4789,
      open: true,
      fixtureHome: undefined,
      sinceHours: 12,
      stateDir: undefined,
      mascot: true,
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
      mascot: true,
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
      config: undefined,
      adapters: false,
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
      config: undefined,
      adapters: false,
    })
  })

  test('--adapters and --config', () => {
    expect(parseCli(['doctor', '--adapters', '--config', '/c.json'])).toMatchObject({ command: 'doctor', adapters: true, config: '/c.json' })
  })
})

describe('parseCli: replay', () => {
  test('--since is the window; speed defaults to 10', () => {
    expect(parseCli(['replay', '--since', '3h'])).toEqual({
      command: 'replay',
      since: '3h',
      sinceMs: 3 * 3_600_000,
      speed: 10,
      port: 4789,
      open: true,
      fixtureHome: undefined,
      configDir: undefined,
      stateDir: undefined,
      config: undefined,
      mascot: true,
    })
  })

  test('every flag it takes', () => {
    expect(
      parseCli(['replay', '--since', '1h30m', '--speed', '25', '--port', '0', '--no-open', '--fixture-home', '/f', '--state-dir', '/s', '--config', '/c.json', '--config-dir', '/d'])
    ).toEqual({
      command: 'replay',
      since: '1h30m',
      sinceMs: 90 * 60_000,
      speed: 25,
      port: 0,
      open: false,
      fixtureHome: '/f',
      configDir: '/d',
      stateDir: '/s',
      config: '/c.json',
      mascot: true,
    })
    expect(parseCli(['replay', '--since', '0.5s', '--speed', '1000'])).toMatchObject({ sinceMs: 500, speed: 1000 })
  })

  test('--since is required and must be a duration', () => {
    expect(() => parseCli(['replay'])).toThrow(/needs --since/)
    expect(() => parseCli(['replay', '--since', 'soon'])).toThrow(/invalid --since: soon/)
    expect(() => parseCli(['replay', '--since', '0h'])).toThrow(/invalid --since/)
    expect(() => parseCli(['replay', '--since', '15d'])).toThrow(/at most 14d/)
  })

  test('--speed must be above 0 and at most 1000', () => {
    expect(() => parseCli(['replay', '--since', '3h', '--speed', '0'])).toThrow(/invalid --speed/)
    expect(() => parseCli(['replay', '--since', '3h', '--speed=-2'])).toThrow(/invalid --speed/)
    expect(() => parseCli(['replay', '--since', '3h', '--speed', '-2'])).toThrow(/invalid arguments/) // parseArgs itself refuses it
    expect(() => parseCli(['replay', '--since', '3h', '--speed', 'fast'])).toThrow(/invalid --speed/)
    expect(() => parseCli(['replay', '--since', '3h', '--speed', '1001'])).toThrow(/at most 1000/)
  })

  test('flags of other commands are refused, and so is a stray argument', () => {
    expect(() => parseCli(['replay', '--since', '3h', '--since-hours', '3'])).toThrow(/not valid for replay/)
    expect(() => parseCli(['replay', '--since', '3h', '--adapters'])).toThrow(/not valid for replay/)
    expect(() => parseCli(['replay', '--since', '3h', 'extra'])).toThrow(/unexpected argument/)
    expect(() => parseCli(['hooks', 'on', '--since', '3h'])).toThrow(/not valid for hooks/)
    expect(() => parseCli(['--since', '3h'])).toThrow(/not valid for the default command/)
    expect(() => parseCli(['doctor', '--speed', '10'])).toThrow(/not valid for doctor/)
  })
})

describe('parseCli: --config', () => {
  test('the default command takes it; hooks does not', () => {
    expect(parseCli(['--config', '/c.json'])).toMatchObject({ command: 'serve', config: '/c.json' })
    expect(parseCli([])).toMatchObject({ command: 'serve', config: undefined })
    expect(() => parseCli(['hooks', 'on', '--config', '/c.json'])).toThrow()
    expect(() => parseCli(['--adapters'])).toThrow(/not valid/)
  })
})

describe('parseCli: --assets', () => {
  test('serve, doctor and replay take it; hooks does not', () => {
    expect(parseCli(['--assets', '/a.json'])).toMatchObject({ command: 'serve', assets: '/a.json' })
    expect(parseCli(['doctor', '--assets', '/a.json'])).toMatchObject({ command: 'doctor', assets: '/a.json' })
    expect(parseCli(['replay', '--since', '3h', '--assets', '/a.json'])).toMatchObject({ command: 'replay', assets: '/a.json' })
    expect(parseCli([])).toMatchObject({ assets: undefined })
    expect(() => parseCli(['hooks', 'on', '--assets', '/a.json'])).toThrow(/not valid for hooks/)
    expect(() => parseCli(['--assets'])).toThrow(/invalid arguments/)
  })
})

describe('parseCli: --no-mascot', () => {
  test('Morty is on by default, and serve and replay can leave him out', () => {
    expect(parseCli([])).toMatchObject({ command: 'serve', mascot: true })
    expect(parseCli(['--no-mascot'])).toMatchObject({ command: 'serve', mascot: false })
    expect(parseCli(['replay', '--since', '1h'])).toMatchObject({ command: 'replay', mascot: true })
    expect(parseCli(['replay', '--since', '1h', '--no-mascot'])).toMatchObject({ command: 'replay', mascot: false })
  })

  test('doctor and hooks do not take it', () => {
    expect(() => parseCli(['doctor', '--no-mascot'])).toThrow(/--no-mascot is not valid for doctor/)
    expect(() => parseCli(['hooks', 'on', '--no-mascot'])).toThrow(/not valid for hooks/)
  })

  test('the help text names it', () => {
    expect(HELP_TEXT).toContain('--no-mascot          Leave Morty, the office corgi, out of the page (serve, replay)')
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
