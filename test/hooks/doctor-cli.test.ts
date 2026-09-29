// `cubiclark doctor` through the real built CLI, against a copy of the fixture home. Never the
// real ~/.claude or ~/.cubiclark, and never the real claude: --claude-bin is a stand-in script.

import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const FIXTURE_HOME = join(FIXTURES, 'home')
const FIXTURE_STATE = join(FIXTURES, 'state')
const FIXTURE_CLAUDE = join(FIXTURES, 'bin', 'claude')

let root: string
let home: string
let state: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubiclark-doctorcli-'))
  home = join(root, 'claude')
  state = join(root, 'state')
  await cp(FIXTURE_HOME, home, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args, '--claude-bin', FIXTURE_CLAUDE], { encoding: 'utf8' })
}

describe('cubiclark doctor', () => {
  test('the fixture home, hooks not installed: exit 0, transcripts live, hooks missing', () => {
    const result = cli('doctor', '--fixture-home', home, '--state-dir', state)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('2.1.285 — hook events verified')
    expect(result.stdout).toMatch(/transcripts {3}live {6}5 transcript files, 5 read/)
    expect(result.stdout).toMatch(/hooks {9}missing {3}not installed/)
    expect(result.stdout).toContain('0 unparsed lines')
    expect(result.stdout).toMatch(/unparsed by {3}none/)
  })

  test('after hooks on it reports the hooks live; with the collector copy deleted it fails with exit 1', async () => {
    const on = spawnSync(process.execPath, [CLI, 'hooks', 'on', '--config-dir', home, '--state-dir', state], { encoding: 'utf8' })
    expect(on.status).toBe(0)
    await cp(join(FIXTURE_STATE, 'events.jsonl'), join(state, 'events.jsonl'))

    const live = cli('doctor', '--fixture-home', home, '--config-dir', home, '--state-dir', state)
    expect(live.status).toBe(0)
    expect(live.stdout).toMatch(/hooks {9}live {6}14 events \(tools on\)/)

    await rm(join(state, 'bin'), { recursive: true })
    const failing = cli('doctor', '--fixture-home', home, '--config-dir', home, '--state-dir', state)
    expect(failing.status).toBe(1)
    expect(failing.stdout).toMatch(/hooks {9}failing {3}the collector copy is missing/)
  })

  test('a fixture home with no state dir never touches the real one', () => {
    const result = cli('doctor', '--fixture-home', home)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('not checked: fixture mode without --state-dir')
  })

  test('a claude that is not there is reported, not fatal', () => {
    const result = spawnSync(process.execPath, [CLI, 'doctor', '--fixture-home', home, '--state-dir', state, '--claude-bin', join(root, 'nope')], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Claude Code   not found')
  })

  test('a missing transcripts folder is reported as missing with exit 0', () => {
    const result = cli('doctor', '--fixture-home', join(root, 'nowhere'), '--state-dir', state)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/transcripts {3}missing {3}no transcripts folder at/)
  })
})

describe('cubiclark doctor --adapters, on the fixture day', () => {
  // A copy with the layout the day's config expects (../../bin/claude), and a config file that is
  // ours alone whatever the checkout's umask was.
  async function dayCopy(): Promise<string> {
    await cp(join(FIXTURES, 'day'), join(root, 'day'), { recursive: true })
    await cp(join(FIXTURES, 'bin'), join(root, 'bin'), { recursive: true })
    await chmod(join(root, 'day', 'state', 'config.json'), 0o600)
    return join(root, 'day')
  }

  test('each adapter says what it found; exit 0', async () => {
    const day = await dayCopy()
    const result = cli('doctor', '--fixture-home', join(day, 'home'), '--state-dir', join(day, 'state'), '--adapters')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/task-folders {2}live {6}5 tasks \(1 planning, 1 building, 1 review, 1 blocked, 1 done\) in 1 root · 0 unparsed log lines/)
    expect(result.stdout).toMatch(/quota-samples live {6}5h 62% · 7d 40% · newest sample 2026-01-16T17:30:00\.000Z/)
    expect(result.stdout).toMatch(/claude-agents live {6}4 sessions/)
    expect(result.stdout).toMatch(/unparsed by {3}none/)
  })

  test('without --adapters no adapter is read, and a fixture home without a state dir reads no config', async () => {
    const day = await dayCopy()
    expect(cli('doctor', '--fixture-home', join(day, 'home'), '--state-dir', join(day, 'state')).stdout).not.toContain('task-folders')
    const noState = cli('doctor', '--fixture-home', join(day, 'home'), '--adapters')
    expect(noState.status).toBe(0)
    expect(noState.stdout).toMatch(/task-folders {2}off {7}not configured/)
  })

  test('a config that names a missing tasks root: that adapter is missing, exit 0', async () => {
    const day = await dayCopy()
    await writeFile(join(day, 'state', 'config.json'), JSON.stringify({ adapters: { 'task-folders': { roots: ['../nowhere'] } } }), { mode: 0o600 })
    const result = cli('doctor', '--fixture-home', join(day, 'home'), '--state-dir', join(day, 'state'), '--adapters')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/task-folders {2}missing {3}no readable tasks root/)
    expect(result.stdout).toMatch(/quota-samples off {7}not configured/)
  })
})
