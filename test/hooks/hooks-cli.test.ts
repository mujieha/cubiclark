// `cubiclark hooks ...` through the real built CLI (dist/cli.js), against fixture settings files
// in temp dirs. --config-dir and --state-dir are always explicit: never the real ~/.claude.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { collectorEntries, parseSettings } from '../../src/core/hooks/settings.js'
import { SETTINGS_FIXTURES } from '../hooks-fixtures.js'

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

let root: string
let configDir: string
let stateDir: string
let settingsPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubiclark-hookscli-'))
  configDir = join(root, 'claude')
  stateDir = join(root, 'state')
  settingsPath = join(configDir, 'settings.json')
  await mkdir(configDir)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args, '--config-dir', configDir, '--state-dir', stateDir], { encoding: 'utf8' })
}

async function installedEntries(): Promise<{ event: string; handler: Record<string, unknown> }[]> {
  return collectorEntries(parseSettings(await readFile(settingsPath, 'utf8')))
}

const SESSION_START = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' })

describe('cubiclark hooks', () => {
  test('on then off leaves the canonical settings byte for byte, exit 0, stdout empty', async () => {
    const original = SETTINGS_FIXTURES.canonical as string
    await writeFile(settingsPath, original)
    const on = cli('hooks', 'on')
    expect(on.status).toBe(0)
    expect(on.stdout).toBe('')
    expect(await installedEntries()).toHaveLength(15)
    const off = cli('hooks', 'off')
    expect(off.status).toBe(0)
    expect(off.stdout).toBe('')
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
  })

  test('hooks on twice adds the entries once', async () => {
    await writeFile(settingsPath, SETTINGS_FIXTURES.canonical as string)
    expect(cli('hooks', 'on').status).toBe(0)
    const again = cli('hooks', 'on')
    expect(again.status).toBe(0)
    expect(again.stderr).toContain('already on')
    expect(await installedEntries()).toHaveLength(15)
  })

  test('hooks on --no-tools installs the 12 lifecycle events only', async () => {
    await writeFile(settingsPath, SETTINGS_FIXTURES.empty as string)
    expect(cli('hooks', 'on', '--no-tools').status).toBe(0)
    const events = (await installedEntries()).map((e) => e.event)
    expect(events).toHaveLength(12)
    expect(events).toContain('PostModelSwitch')
    expect(events).not.toContain('PreModelSwitch')
    expect(events).not.toContain('PreToolUse')
  })

  test('an unparseable settings file: exit 1, "does not parse", file untouched', async () => {
    const original = SETTINGS_FIXTURES.broken as string
    await writeFile(settingsPath, original)
    const result = cli('hooks', 'on')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not parse')
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
    expect(existsSync(stateDir)).toBe(false)
  })

  test('the installed entry really works: running it records the event', async () => {
    await writeFile(settingsPath, SETTINGS_FIXTURES.canonical as string)
    expect(cli('hooks', 'on').status).toBe(0)
    const handler = (await installedEntries())[0]?.handler as { command: string; args: string[] }
    const run = spawnSync(handler.command === 'node' ? process.execPath : handler.command, handler.args, {
      input: SESSION_START,
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    const stored = (await readFile(join(stateDir, 'events.jsonl'), 'utf8')).trim().split('\n')
    expect(stored).toHaveLength(1)
    expect(JSON.parse(stored[0] as string)).toMatchObject({ e: 'SessionStart', sid: 's1', src: 'startup' })
  })

  test('status reports the event count and paused: no; after pause the installed handler writes nothing', async () => {
    await writeFile(settingsPath, SETTINGS_FIXTURES.canonical as string)
    cli('hooks', 'on')
    const status = cli('hooks', 'status')
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('15 events')
    expect(status.stdout).toContain('paused: no')

    expect(cli('hooks', 'pause').status).toBe(0)
    expect(cli('hooks', 'status').stdout).toContain('paused: yes')
    const handler = (await installedEntries())[0]?.handler as { args: string[] }
    const run = spawnSync(process.execPath, handler.args, { input: SESSION_START, encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(existsSync(join(stateDir, 'events.jsonl'))).toBe(false)

    expect(cli('hooks', 'resume').status).toBe(0)
    expect(cli('hooks', 'status').stdout).toContain('paused: no')
  })

  test('an unknown action exits 1 with the usage list', () => {
    const result = spawnSync(process.execPath, [CLI, 'hooks', 'sideways'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('on|off|status|pause|resume')
  })
})
