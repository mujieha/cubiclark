import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { normalisePath, parentDir, parseConfig, resolveConfigPath } from '../src/core/adapters/config.js'
import { loadConfig } from '../src/server/config-file.js'

const O = { baseDir: '/cfg', home: '/home/user', fixtureMode: false }

function parse(json: unknown, o = O) {
  return parseConfig(JSON.stringify(json), o)
}

describe('parseConfig: bad input never throws', () => {
  test('not JSON, not an object, no adapters', () => {
    expect(parseConfig('{nope', O).config).toEqual({})
    expect(parseConfig('{nope', O).warnings[0]).toContain('not valid JSON')
    expect(parseConfig('[1]', O)).toEqual({ config: {}, warnings: ['config is not a JSON object: nothing configured'] })
    expect(parseConfig('{}', O)).toEqual({ config: {}, warnings: [] })
    expect(parse({ adapters: 3 }).warnings[0]).toContain('"adapters" must be an object')
  })
  test('unknown keys and adapter ids are warnings', () => {
    const r = parse({ nonsense: 1, adapters: { 'made-up': {} } })
    expect(r.config).toEqual({})
    expect(r.warnings).toEqual(['unknown key "nonsense" ignored', 'unknown adapter "made-up" ignored'])
  })
})

describe('paths', () => {
  test('~ expands, relative resolves against the config directory, absolute is kept', () => {
    expect(resolveConfigPath('~/x', '/cfg', '/home/user')).toBe('/home/user/x')
    expect(resolveConfigPath('~', '/cfg', '/home/user')).toBe('/home/user')
    expect(resolveConfigPath('../tasks', '/cfg/sub', '/h')).toBe('/cfg/tasks')
    expect(resolveConfigPath('/a/./b/../c', '/cfg', '/h')).toBe('/a/c')
    expect(normalisePath('a/../..')).toBe('..')
    expect(parentDir('/a/b/tasks')).toBe('/a/b')
    expect(parentDir('/a')).toBe('/')
  })
})

describe('task-folders', () => {
  test('roots, orchestratorCwd default (the roots\' parents) and the 72 h window', () => {
    const r = parse({ adapters: { 'task-folders': { roots: ['~/proj/agent/tasks', 'other'] } } })
    expect(r.config.taskFolders).toEqual({
      roots: ['/home/user/proj/agent/tasks', '/cfg/other'],
      orchestratorCwds: ['/home/user/proj/agent', '/cfg'],
      windowHours: 72,
    })
    expect(r.warnings).toEqual([])
  })
  test('orchestratorCwd as a string or an array', () => {
    expect(parse({ adapters: { 'task-folders': { roots: ['/t'], orchestratorCwd: '~/hq' } } }).config.taskFolders?.orchestratorCwds).toEqual(['/home/user/hq'])
    expect(parse({ adapters: { 'task-folders': { roots: ['/t'], orchestratorCwd: ['/a', '/b'] } } }).config.taskFolders?.orchestratorCwds).toEqual(['/a', '/b'])
  })
  test('windowHours: a number, null, and no window in fixture mode', () => {
    expect(parse({ adapters: { 'task-folders': { roots: ['/t'], windowHours: 24 } } }).config.taskFolders?.windowHours).toBe(24)
    expect(parse({ adapters: { 'task-folders': { roots: ['/t'], windowHours: null } } }).config.taskFolders?.windowHours).toBeNull()
    expect(parse({ adapters: { 'task-folders': { roots: ['/t'] } } }, { ...O, fixtureMode: true }).config.taskFolders?.windowHours).toBeNull()
    const bad = parse({ adapters: { 'task-folders': { roots: ['/t'], windowHours: -3 } } })
    expect(bad.config.taskFolders?.windowHours).toBe(72)
    expect(bad.warnings[0]).toContain('windowHours')
  })
  test('roots must be a non-empty array of strings, else the section is dropped', () => {
    for (const roots of [undefined, [], 'x', [1], ['ok', 2]]) {
      const r = parse({ adapters: { 'task-folders': { roots } } })
      expect(r.config.taskFolders).toBeUndefined()
      expect(r.warnings[0]).toContain('"roots" must be a non-empty array')
    }
    expect(parse({ adapters: { 'task-folders': 'x' } }).config.taskFolders).toBeUndefined()
  })
})

describe('quota-samples', () => {
  test('the file may be a glob; it is required', () => {
    expect(parse({ adapters: { 'quota-samples': { file: '~/.claude/metrics/samples-*.jsonl' } } }).config.quotaSamples).toEqual({
      file: '/home/user/.claude/metrics/samples-*.jsonl',
    })
    const r = parse({ adapters: { 'quota-samples': {} } })
    expect(r.config.quotaSamples).toBeUndefined()
    expect(r.warnings[0]).toContain('"file" is required')
  })
})

describe('claude-agents', () => {
  test('present only when enabled is true', () => {
    expect(parse({ adapters: { 'claude-agents': {} } }).config.claudeAgents).toBeUndefined()
    expect(parse({ adapters: { 'claude-agents': { enabled: 'yes' } } }).config.claudeAgents).toBeUndefined()
    expect(parse({ adapters: { 'claude-agents': { enabled: false, bin: 'x' } } }).config.claudeAgents).toBeUndefined()
    expect(parse({ adapters: { 'claude-agents': { enabled: true } } }).config.claudeAgents).toEqual({ bin: 'claude', pollMs: 15_000 })
  })
  test('bin: a bare name stays, a path resolves; pollSeconds is at least 15', () => {
    expect(parse({ adapters: { 'claude-agents': { enabled: true, bin: 'my-claude' } } }).config.claudeAgents?.bin).toBe('my-claude')
    expect(parse({ adapters: { 'claude-agents': { enabled: true, bin: '../bin/claude' } } }).config.claudeAgents?.bin).toBe('/bin/claude')
    expect(parse({ adapters: { 'claude-agents': { enabled: true, pollSeconds: 5 } } }).config.claudeAgents?.pollMs).toBe(15_000)
    expect(parse({ adapters: { 'claude-agents': { enabled: true, pollSeconds: 60 } } }).config.claudeAgents?.pollMs).toBe(60_000)
    expect(parse({ adapters: { 'claude-agents': { enabled: true, pollSeconds: 'fast' } } }).warnings[0]).toContain('pollSeconds')
  })
})

describe('loadConfig', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cubiclark-config-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const ENABLED = JSON.stringify({
    adapters: { 'task-folders': { roots: ['tasks'] }, 'claude-agents': { enabled: true, bin: 'claude' } },
  })

  test('a missing file is no adapters and no warnings', async () => {
    expect(await loadConfig(join(dir, 'nope.json'), { home: '/h', fixtureMode: false })).toEqual({ config: {}, warnings: [] })
  })

  test('relative paths resolve against the config file\'s directory', async () => {
    const file = join(dir, 'config.json')
    await writeFile(file, ENABLED, { mode: 0o600 })
    await chmod(file, 0o600)
    const r = await loadConfig(file, { home: '/h', fixtureMode: false })
    expect(r.config.taskFolders?.roots).toEqual([join(dir, 'tasks')])
    expect(r.config.claudeAgents).toEqual({ bin: 'claude', pollMs: 15_000 })
    expect(r.warnings).toEqual([])
  })

  test('a file writable by others keeps the readers but drops claude-agents', async () => {
    const file = join(dir, 'config.json')
    await writeFile(file, ENABLED)
    await chmod(file, 0o666)
    const r = await loadConfig(file, { home: '/h', fixtureMode: false })
    expect(r.config.taskFolders).toBeDefined()
    expect(r.config.claudeAgents).toBeUndefined()
    expect(r.warnings).toContain('config.json is writable by others; claude-agents stays off')
  })

  test('an unreadable path is a warning, not a throw', async () => {
    const r = await loadConfig(dir, { home: '/h', fixtureMode: false }) // a directory
    expect(r.config).toEqual({})
    expect(r.warnings[0]).toContain('cannot read the config file')
  })
})
