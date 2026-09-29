// hooks on/off against fixture settings files in temp dirs. Nothing here touches the real
// ~/.claude or ~/.cubiclark: configDir, stateDir and distDir are all under one mkdtemp dir.

import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { collectorEntries, parseSettings } from '../src/core/hooks/settings.js'
import {
  COLLECTOR_FILES,
  HooksCommandError,
  formatHooksStatus,
  hooksOff,
  hooksOn,
  inspectHooks,
  pauseHooks,
  resumeHooks,
  type HooksPaths,
} from '../src/server/hooks-install.js'
import { PARSEABLE_FIXTURES, REFUSED_FIXTURES, SETTINGS_FIXTURES } from './hooks-fixtures.js'

const NOW = Date.parse('2026-01-15T10:00:00.000Z')

let root: string
let paths: HooksPaths
let settingsPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubiclark-install-'))
  paths = {
    configDir: join(root, 'claude'),
    stateDir: join(root, 'state'),
    distDir: join(root, 'dist'),
    defaultStateDir: join(root, 'state'),
  }
  settingsPath = join(paths.configDir, 'settings.json')
  await mkdir(paths.configDir, { recursive: true })
  for (const [from] of COLLECTOR_FILES) {
    await mkdir(join(paths.distDir, from, '..'), { recursive: true })
    await writeFile(join(paths.distDir, from), `// stub ${from}\n`)
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeFixture(name: string): Promise<Buffer | undefined> {
  const text = SETTINGS_FIXTURES[name]
  if (text === null || text === undefined) return undefined
  await writeFile(settingsPath, text)
  return Buffer.from(text)
}

async function readSettingsBytes(): Promise<Buffer | undefined> {
  try {
    return await readFile(settingsPath)
  } catch {
    return undefined
  }
}

async function entryCount(): Promise<number> {
  const bytes = await readSettingsBytes()
  return bytes ? collectorEntries(parseSettings(bytes.toString('utf8'))).length : 0
}

describe('on then off is byte-identical', () => {
  for (const name of ['absent', ...PARSEABLE_FIXTURES]) {
    test(`fixture ${name}`, async () => {
      const original = await writeFixture(name)
      const on = await hooksOn(paths, { tools: true, nowMs: NOW })
      expect(on.changed).toBe(true)
      expect(await entryCount()).toBe(14)
      const off = await hooksOff(paths, { purge: false })
      expect(off.restored).toBe('backup')
      const after = await readSettingsBytes()
      if (original === undefined) expect(after).toBeUndefined()
      else expect(after?.equals(original)).toBe(true)
    })
  }
})

describe('hooks on', () => {
  test('twice adds the entries once and the second call leaves the file alone', async () => {
    await writeFixture('canonical')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const first = await stat(settingsPath)
    const bytes = await readSettingsBytes()
    const second = await hooksOn(paths, { tools: true, nowMs: NOW + 1000 })
    expect(second.changed).toBe(false)
    expect(await entryCount()).toBe(14)
    expect((await readSettingsBytes())?.equals(bytes as Buffer)).toBe(true)
    expect((await stat(settingsPath)).mtimeMs).toBe(first.mtimeMs)
  })

  test('--no-tools records 11 events, a later plain on adds the tool entries once, off still restores', async () => {
    const original = await writeFixture('canonical')
    await hooksOn(paths, { tools: false, nowMs: NOW })
    expect(await entryCount()).toBe(11)
    await hooksOn(paths, { tools: true, nowMs: NOW + 1000 })
    expect(await entryCount()).toBe(14)
    await hooksOff(paths, { purge: false })
    expect((await readSettingsBytes())?.equals(original as Buffer)).toBe(true)
  })

  for (const name of REFUSED_FIXTURES) {
    test(`refuses ${name}: nothing is written anywhere`, async () => {
      const original = await writeFixture(name)
      await expect(hooksOn(paths, { tools: true, nowMs: NOW })).rejects.toThrow(HooksCommandError)
      expect((await readSettingsBytes())?.equals(original as Buffer)).toBe(true)
      expect(existsSync(join(paths.stateDir, 'backups'))).toBe(false)
      expect(existsSync(join(paths.stateDir, 'bin'))).toBe(false)
      expect(existsSync(join(paths.stateDir, 'install.json'))).toBe(false)
      expect((await readdir(paths.configDir)).sort()).toEqual(['settings.json'])
    })
  }

  test('keeps a backup of the original bytes and records both hashes', async () => {
    const original = await writeFixture('canonical')
    const on = await hooksOn(paths, { tools: true, nowMs: NOW })
    expect(on.backupPath).toBeDefined()
    expect((await readFile(on.backupPath as string)).equals(original as Buffer)).toBe(true)
    const record = JSON.parse(await readFile(join(paths.stateDir, 'install.json'), 'utf8')) as Record<string, unknown>
    expect(record.originalSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(record.writtenSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(record.originalSha256).not.toBe(record.writtenSha256)
    expect(record.events).toHaveLength(14)
  })

  test('copies the collector files into <stateDir>/bin and marks the folder as ESM', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const collector = join(paths.stateDir, 'bin', 'hook', 'cubiclark-collector.js')
    expect(await readFile(collector, 'utf8')).toBe('// stub hook/collector.js\n')
    expect(await readFile(join(paths.stateDir, 'bin', 'core', 'hooks', 'whitelist.js'), 'utf8')).toContain('stub')
    expect(JSON.parse(await readFile(join(paths.stateDir, 'bin', 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    const entries = collectorEntries(parseSettings((await readSettingsBytes())?.toString('utf8') ?? ''))
    expect(JSON.stringify(entries[0]?.handler)).toContain(collector)
  })

  test('a custom state dir is passed to the collector with --state-dir', async () => {
    await writeFixture('empty')
    await hooksOn({ ...paths, defaultStateDir: join(root, 'somewhere-else') }, { tools: true, nowMs: NOW })
    const entries = collectorEntries(parseSettings((await readSettingsBytes())?.toString('utf8') ?? ''))
    expect(JSON.stringify(entries[0]?.handler)).toContain('--state-dir')
  })

  test('the default state dir adds no --state-dir', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const entries = collectorEntries(parseSettings((await readSettingsBytes())?.toString('utf8') ?? ''))
    expect(JSON.stringify(entries[0]?.handler)).not.toContain('--state-dir')
  })

  test('preserves the settings file mode across on and off', async () => {
    await writeFixture('canonical')
    await chmod(settingsPath, 0o644)
    await hooksOn(paths, { tools: true, nowMs: NOW })
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o644)
    await hooksOff(paths, { purge: false })
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o644)
  })

  test('leaves no temp file behind', async () => {
    await writeFixture('canonical')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    await hooksOff(paths, { purge: false })
    expect((await readdir(paths.configDir)).sort()).toEqual(['settings.json'])
  })

  test('refuses a dangling settings.json symlink', async () => {
    await symlink(join(root, 'nowhere.json'), settingsPath)
    await expect(hooksOn(paths, { tools: true, nowMs: NOW })).rejects.toThrow(HooksCommandError)
  })
})

describe('hooks off', () => {
  test('after an outside edit it removes only our entries and keeps the edit (structural path)', async () => {
    await writeFixture('canonical')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const edited = parseSettings((await readSettingsBytes())?.toString('utf8') ?? '') as Record<string, unknown>
    edited.theme = 'dark'
    const hooks = edited.hooks as Record<string, unknown[]>
    hooks.Stop?.unshift({ hooks: [{ type: 'command', command: 'afplay ding.wav' }] })
    await writeFile(settingsPath, JSON.stringify(edited, null, 2) + '\n')

    const off = await hooksOff(paths, { purge: false })
    expect(off.restored).toBe('structural')
    expect(off.removed).toBe(14)
    const after = parseSettings((await readSettingsBytes())?.toString('utf8') ?? '')
    expect(collectorEntries(after)).toHaveLength(0)
    expect(after.theme).toBe('dark')
    expect(JSON.stringify(after.hooks)).toContain('afplay ding.wav')
    expect(JSON.stringify(after.hooks)).toContain('/usr/local/bin/lint.sh')
  })

  test('removes the installed copy and install.json; --purge removes the whole state dir', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    await hooksOff(paths, { purge: false })
    expect(existsSync(join(paths.stateDir, 'bin'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'install.json'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'backups'))).toBe(true)

    await hooksOn(paths, { tools: true, nowMs: NOW })
    await hooksOff(paths, { purge: true })
    expect(existsSync(paths.stateDir)).toBe(false)
  })

  test('with nothing installed it does nothing', async () => {
    const original = await writeFixture('canonical')
    const off = await hooksOff(paths, { purge: false })
    expect(off).toMatchObject({ removed: 0, restored: 'nothing' })
    expect((await readSettingsBytes())?.equals(original as Buffer)).toBe(true)
  })

  test('refuses an unparseable settings file and changes nothing', async () => {
    const original = await writeFixture('broken')
    await expect(hooksOff(paths, { purge: false })).rejects.toThrow(HooksCommandError)
    expect((await readSettingsBytes())?.equals(original as Buffer)).toBe(true)
  })
})

describe('a symlinked settings.json (dotfile managers)', () => {
  test('stays a symlink through on and off, and the target carries every change', async () => {
    const dotfiles = join(root, 'dotfiles')
    await mkdir(dotfiles)
    const target = join(dotfiles, 'claude-settings.json')
    const text = SETTINGS_FIXTURES.canonical as string
    await writeFile(target, text)
    await symlink(target, settingsPath)

    await hooksOn(paths, { tools: true, nowMs: NOW })
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true)
    expect(collectorEntries(parseSettings(await readFile(target, 'utf8')))).toHaveLength(14)

    await hooksOff(paths, { purge: false })
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe(text)
    expect((await readdir(dotfiles)).sort()).toEqual(['claude-settings.json'])
  })
})

describe('pause, resume and inspect', () => {
  test('pause creates <stateDir>/off and resume removes it', async () => {
    await pauseHooks(paths.stateDir)
    expect(existsSync(join(paths.stateDir, 'off'))).toBe(true)
    await resumeHooks(paths.stateDir)
    expect(existsSync(join(paths.stateDir, 'off'))).toBe(false)
    await resumeHooks(paths.stateDir) // no error when already resumed
  })

  test('inspect: no settings file', async () => {
    const i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i).toMatchObject({ settingsState: 'absent', events: [], tools: false, collectorExists: false, paused: false })
  })

  test('inspect: unparseable settings', async () => {
    await writeFixture('broken')
    const i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i.settingsState).toBe('unparseable')
    expect(i.parseError).toBeTruthy()
  })

  test('inspect: installed with all 14 events, then paused, then the copy deleted', async () => {
    await writeFixture('canonical')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    let i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i).toMatchObject({ settingsState: 'ok', tools: true, collectorExists: true, paused: false })
    expect(i.events).toHaveLength(14)

    await pauseHooks(paths.stateDir)
    i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i.paused).toBe(true)

    await rm(join(paths.stateDir, 'bin'), { recursive: true })
    i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i.collectorExists).toBe(false)
  })

  test('inspect: --no-tools install reports tools off', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: false, nowMs: NOW })
    const i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i.tools).toBe(false)
    expect(i.events).toHaveLength(11)
  })

  test('inspect: last event time comes from the last complete line, ignoring a partial one', async () => {
    await mkdir(paths.stateDir, { recursive: true })
    const good = JSON.stringify({ v: 1, ts: '2026-01-15T10:00:05.000Z', e: 'Stop' })
    const older = JSON.stringify({ v: 1, ts: '2026-01-15T10:00:01.000Z', e: 'Stop' })
    await writeFile(join(paths.stateDir, 'events.jsonl'), `${older}\n${good}\n{"v":1,"ts":"2026-01-15T10:9`)
    const i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i.lastEventTs).toBe('2026-01-15T10:00:05.000Z')
    expect(i.eventsBytes).toBeGreaterThan(0)
  })

  test('formatHooksStatus names the event count and whether it is paused', async () => {
    await writeFixture('canonical')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const text = formatHooksStatus(await inspectHooks(paths.configDir, paths.stateDir))
    expect(text).toContain('14 events')
    expect(text).toContain('paused: no')
    expect(text).toContain('installed: yes')

    const none = formatHooksStatus(await inspectHooks(join(root, 'nothing'), join(root, 'nothing-state')))
    expect(none).toContain('installed: no')
  })
})
