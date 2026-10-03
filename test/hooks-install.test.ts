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
      expect(await entryCount()).toBe(15)
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
    expect(await entryCount()).toBe(15)
    expect((await readSettingsBytes())?.equals(bytes as Buffer)).toBe(true)
    expect((await stat(settingsPath)).mtimeMs).toBe(first.mtimeMs)
  })

  test('--no-tools records 12 events, a later plain on adds the tool entries once, off still restores', async () => {
    const original = await writeFixture('canonical')
    await hooksOn(paths, { tools: false, nowMs: NOW })
    expect(await entryCount()).toBe(12)
    await hooksOn(paths, { tools: true, nowMs: NOW + 1000 })
    expect(await entryCount()).toBe(15)
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
    expect(record.events).toHaveLength(15)
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
    expect(off.removed).toBe(15)
    const after = parseSettings((await readSettingsBytes())?.toString('utf8') ?? '')
    expect(collectorEntries(after)).toHaveLength(0)
    expect(after.theme).toBe('dark')
    expect(JSON.stringify(after.hooks)).toContain('afplay ding.wav')
    expect(JSON.stringify(after.hooks)).toContain('/usr/local/bin/lint.sh')
  })

  test('removes the installed copy and install.json; --purge also removes the events files but keeps the backups', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    await hooksOff(paths, { purge: false })
    expect(existsSync(join(paths.stateDir, 'bin'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'install.json'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'backups'))).toBe(true)

    await hooksOn(paths, { tools: true, nowMs: NOW })
    await writeFile(join(paths.stateDir, 'events.jsonl'), '{}\n')
    await writeFile(join(paths.stateDir, 'off'), 'x')
    await hooksOff(paths, { purge: true })
    expect(existsSync(join(paths.stateDir, 'events.jsonl'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'off'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'backups'))).toBe(true) // the only copy of the original settings
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
    expect(collectorEntries(parseSettings(await readFile(target, 'utf8')))).toHaveLength(15)

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

  test('inspect: installed with all 15 events, then paused, then the copy deleted', async () => {
    await writeFixture('canonical')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    let i = await inspectHooks(paths.configDir, paths.stateDir)
    expect(i).toMatchObject({ settingsState: 'ok', tools: true, collectorExists: true, paused: false })
    expect(i.events).toHaveLength(15)

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
    expect(i.events).toHaveLength(12)
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
    expect(text).toContain('15 events')
    expect(text).toContain('paused: no')
    expect(text).toContain('installed: yes')

    const none = formatHooksStatus(await inspectHooks(join(root, 'nothing'), join(root, 'nothing-state')))
    expect(none).toContain('installed: no')
  })
})

describe('an install from before PostModelSwitch existed', () => {
  test('hooks on again adds the one entry, and hooks off still gives back the original bytes', async () => {
    const original = (await writeFixture('canonical')) as Buffer
    await hooksOn(paths, { tools: true, nowMs: NOW })
    // Rewind to what the previous version wrote: 14 entries, and an install record that matches them.
    const current = parseSettings((await readSettingsBytes())?.toString('utf8') ?? '{}')
    const hooks = current.hooks as Record<string, unknown[]>
    delete hooks.PostModelSwitch
    const older = JSON.stringify(current, null, 2) + '\n'
    await writeFile(settingsPath, older)
    const recordPath = join(paths.stateDir, 'install.json')
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    const { createHash } = await import('node:crypto')
    await writeFile(recordPath, JSON.stringify({ ...record, writtenSha256: createHash('sha256').update(older).digest('hex') }))
    expect(await entryCount()).toBe(14)

    const again = await hooksOn(paths, { tools: true, nowMs: NOW + 1000 })
    expect(again.changed).toBe(true)
    expect(await entryCount()).toBe(15)
    const off = await hooksOff(paths, { purge: false })
    expect(off.restored).toBe('backup')
    expect(await readSettingsBytes()).toEqual(original)
  })
})

// S1-4: --purge removes only what Cubiclark writes, and never the home directory.
describe('hooks off --purge', () => {
  test('a directory holding an unrelated file keeps that file', async () => {
    await writeFixture('empty')
    await mkdir(paths.stateDir, { recursive: true })
    await writeFile(join(paths.stateDir, 'important-notes.txt'), 'do not delete')
    await writeFile(join(paths.stateDir, 'events.jsonl'), '{}\n')
    await writeFile(join(paths.stateDir, 'events.1.jsonl'), '{}\n')
    await writeFile(join(paths.stateDir, 'config.json'), '{}')
    await mkdir(join(paths.stateDir, 'assets'))
    await hooksOff(paths, { purge: true })
    expect(await readFile(join(paths.stateDir, 'important-notes.txt'), 'utf8')).toBe('do not delete')
    expect(existsSync(join(paths.stateDir, 'events.jsonl'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'events.1.jsonl'))).toBe(false)
    expect(existsSync(join(paths.stateDir, 'config.json'))).toBe(true)
    expect(existsSync(join(paths.stateDir, 'assets'))).toBe(true)
  })

  test('a state directory with nothing else in it is removed', async () => {
    await mkdir(paths.stateDir, { recursive: true })
    await writeFile(join(paths.stateDir, 'events.jsonl'), '{}\n')
    await hooksOff(paths, { purge: true })
    expect(existsSync(paths.stateDir)).toBe(false)
  })

  test('it refuses the home directory, a directory that contains it, and /, and changes nothing', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const before = await readSettingsBytes()
    const home = join(root, 'home')
    await mkdir(join(home, 'work'), { recursive: true })
    await writeFile(join(home, 'work', 'precious.txt'), 'x')
    for (const stateDir of [home, root, '/']) {
      await expect(hooksOff({ ...paths, stateDir, home }, { purge: true }), stateDir).rejects.toThrow(/refusing to purge/)
    }
    expect(await readSettingsBytes()).toEqual(before) // the refusal came before anything changed
    expect(existsSync(join(home, 'work', 'precious.txt'))).toBe(true)
  })

  test('it refuses a symlink that leads to the home directory', async () => {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    await symlink(home, paths.stateDir)
    await expect(hooksOff({ ...paths, home }, { purge: true })).rejects.toThrow(/refusing to purge/)
  })

  test('a directory beside the home directory, or inside it, is fine', async () => {
    const home = join(root, 'home')
    const inside = join(home, '.cubiclark')
    await mkdir(inside, { recursive: true })
    await writeFile(join(inside, 'events.jsonl'), '{}\n')
    await hooksOff({ ...paths, stateDir: inside, home }, { purge: true })
    expect(existsSync(inside)).toBe(false)
    expect(existsSync(home)).toBe(true)
  })
})

// S1-6: a backup that already runs the collector is never "the original".
describe('hooks off after the install record was lost', () => {
  test('on --no-tools then off leaves no collector entry, even though the file began with some', async () => {
    const stale = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['/gone/bin/hook/cubiclark-collector.js'], timeout: 5 }] }] },
      theme: 'dark',
    }
    await writeFile(settingsPath, JSON.stringify(stale, null, 2) + '\n')
    const on = await hooksOn(paths, { tools: false, nowMs: NOW })
    expect(on.changed).toBe(true)
    const off = await hooksOff(paths, { purge: false })
    expect(off.restored).toBe('structural')
    const after = parseSettings((await readSettingsBytes())?.toString('utf8') ?? '{}')
    expect(collectorEntries(after)).toEqual([])
    expect(after.theme).toBe('dark')
  })

  test('an older install record whose backup holds the collector is not restored either', async () => {
    await writeFixture('canonical')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const record = JSON.parse(await readFile(join(paths.stateDir, 'install.json'), 'utf8')) as { backupPath: string }
    await writeFile(record.backupPath, (await readSettingsBytes()) as Buffer) // the backup now holds our entries
    const off = await hooksOff(paths, { purge: false })
    expect(off.restored).toBe('structural')
    expect(await entryCount()).toBe(0)
  })
})

// S1-8: an executable goes only into a directory that this user alone can write.
// R2-2: `off` removed `<state dir>/bin` recursively on every run, whatever was in it, and only
// `--purge` refused the home directory.
describe('hooks off and an unrelated file in bin/ (R2-2)', () => {
  const collector = (): string => join(paths.stateDir, 'bin', 'hook', 'cubiclark-collector.js')

  for (const purge of [false, true]) {
    test(`off${purge ? ' --purge' : ''} removes what on placed, keeps an unrelated file, and removes only empty directories`, async () => {
      await writeFixture('empty')
      await hooksOn(paths, { tools: true, nowMs: NOW })
      await writeFile(join(paths.stateDir, 'bin', 'my-script.sh'), 'echo mine')
      await writeFile(join(paths.stateDir, 'bin', 'hook', 'notes.txt'), 'mine too')
      await hooksOff(paths, { purge })
      expect(await readFile(join(paths.stateDir, 'bin', 'my-script.sh'), 'utf8')).toBe('echo mine')
      expect(await readFile(join(paths.stateDir, 'bin', 'hook', 'notes.txt'), 'utf8')).toBe('mine too')
      expect(existsSync(collector())).toBe(false)
      for (const [, to] of COLLECTOR_FILES) expect(existsSync(join(paths.stateDir, 'bin', to)), to).toBe(false)
      expect(existsSync(join(paths.stateDir, 'bin', 'package.json'))).toBe(false)
      expect(existsSync(join(paths.stateDir, 'bin', 'core'))).toBe(false) // emptied, so removed
      expect(existsSync(join(paths.stateDir, 'install.json'))).toBe(false)
    })
  }

  test('a bin/package.json that is not the one on writes stays', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    await writeFile(join(paths.stateDir, 'bin', 'package.json'), '{"name":"mine"}')
    await hooksOff(paths, { purge: false })
    expect(await readFile(join(paths.stateDir, 'bin', 'package.json'), 'utf8')).toBe('{"name":"mine"}')
  })

  test('a bin that is a symlink to another directory is not followed', async () => {
    await writeFixture('empty')
    const elsewhere = join(root, 'elsewhere')
    await mkdir(join(elsewhere, 'hook'), { recursive: true })
    await writeFile(join(elsewhere, 'hook', 'cubiclark-collector.js'), 'not ours')
    await mkdir(paths.stateDir, { recursive: true })
    await symlink(elsewhere, join(paths.stateDir, 'bin'))
    await hooksOff(paths, { purge: false })
    expect(await readFile(join(elsewhere, 'hook', 'cubiclark-collector.js'), 'utf8')).toBe('not ours')
  })

  test('plain off refuses the home directory, a directory that contains it, and /, and changes nothing', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const before = await readSettingsBytes()
    const home = join(root, 'home')
    await mkdir(join(home, 'bin'), { recursive: true })
    await writeFile(join(home, 'bin', 'my-script.sh'), 'echo mine')
    for (const stateDir of [home, root, '/']) {
      await expect(hooksOff({ ...paths, stateDir, home }, { purge: false }), stateDir).rejects.toThrow(/refusing to remove hooks from/)
    }
    expect(await readSettingsBytes()).toEqual(before)
    expect(await readFile(join(home, 'bin', 'my-script.sh'), 'utf8')).toBe('echo mine')
  })

  test('on refuses the home directory too, and writes nothing', async () => {
    await writeFixture('empty')
    const before = await readSettingsBytes()
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    await expect(hooksOn({ ...paths, stateDir: home, home }, { tools: true, nowMs: NOW })).rejects.toThrow(/refusing to install into/)
    expect(await readSettingsBytes()).toEqual(before)
    expect(existsSync(join(home, 'bin'))).toBe(false)
  })

  test('the file has no recursive removal left', async () => {
    const source = await readFile(new URL('../src/server/hooks-install.ts', import.meta.url), 'utf8')
    expect(/\brm\(.*recursive/.test(source), 'a recursive rm( in hooks-install.ts').toBe(false)
  })
})

describe('hooks on and the state directory', () => {
  test('a state directory that group or others can write is refused, and nothing is installed', async () => {
    await writeFixture('empty')
    const before = await readSettingsBytes()
    await mkdir(paths.stateDir, { recursive: true })
    await chmod(paths.stateDir, 0o777)
    await expect(hooksOn(paths, { tools: true, nowMs: NOW })).rejects.toThrow(/writable by group or others/)
    expect(await readSettingsBytes()).toEqual(before)
    expect(existsSync(join(paths.stateDir, 'bin'))).toBe(false)
  })

  test('a state directory owned by another user is refused', async () => {
    await writeFixture('empty')
    await mkdir(paths.stateDir, { recursive: true })
    const other = (process.getuid?.() ?? 1000) + 1
    await expect(hooksOn({ ...paths, uid: other }, { tools: true, nowMs: NOW })).rejects.toThrow(/owned by another user/)
  })

  test('a state directory that is a symlink is refused', async () => {
    await writeFixture('empty')
    const real = join(root, 'real-state')
    await mkdir(real, { recursive: true, mode: 0o700 })
    await symlink(real, paths.stateDir)
    await expect(hooksOn(paths, { tools: true, nowMs: NOW })).rejects.toThrow(/is a symlink/)
  })

  test('a bin directory that others can write is refused', async () => {
    await writeFixture('empty')
    await mkdir(join(paths.stateDir, 'bin'), { recursive: true, mode: 0o700 })
    await chmod(join(paths.stateDir, 'bin'), 0o777)
    await expect(hooksOn(paths, { tools: true, nowMs: NOW })).rejects.toThrow(/writable by group or others/)
  })

  test('a symlink planted at a collector file is replaced, never followed', async () => {
    await writeFixture('empty')
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const victim = join(root, 'victim.txt')
    await writeFile(victim, 'untouched')
    const collector = join(paths.stateDir, 'bin', 'hook', 'cubiclark-collector.js')
    await rm(collector)
    await symlink(victim, collector)
    await hooksOn(paths, { tools: true, nowMs: NOW })
    expect(await readFile(victim, 'utf8')).toBe('untouched')
    expect((await lstat(collector)).isSymbolicLink()).toBe(false)
    expect(await readFile(collector, 'utf8')).toContain('stub')
  })
})

// S1-17: the settings write, and a settings key called __proto__.
describe('the settings write', () => {
  test('a symlink at the old predictable temp name is not followed', async () => {
    await writeFixture('empty')
    const victim = join(root, 'victim.txt')
    await writeFile(victim, 'untouched')
    await symlink(victim, join(paths.configDir, `.settings.json.cubiclark-${process.pid}.tmp`))
    await hooksOn(paths, { tools: true, nowMs: NOW })
    expect(await readFile(victim, 'utf8')).toBe('untouched')
    expect(await entryCount()).toBe(15)
    expect((await readdir(paths.configDir)).filter((name) => name.endsWith('.tmp') && !name.includes(String(process.pid)))).toEqual([])
  })

  test('a key called __proto__ survives on, an edit and a structural off', async () => {
    const text = '{\n  "__proto__": {"a": 1},\n  "hooks": {\n    "__proto__": [{"hooks": [{"type": "command", "command": "keep-me"}]}]\n  }\n}\n'
    await writeFile(settingsPath, text)
    await hooksOn(paths, { tools: true, nowMs: NOW })
    const edited = (await readFile(settingsPath, 'utf8')).replace('{\n', '{\n  "editor": "vim",\n')
    await writeFile(settingsPath, edited) // changed since: off must be structural
    const off = await hooksOff(paths, { purge: false })
    expect(off.restored).toBe('structural')
    const after = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    expect(Object.hasOwn(after, '__proto__')).toBe(true)
    expect(JSON.stringify(after.__proto__)).toBe('{"a":1}')
    const hooks = after.hooks as Record<string, unknown>
    expect(Object.hasOwn(hooks, '__proto__')).toBe(true)
    expect(after.editor).toBe('vim')
  })
})
