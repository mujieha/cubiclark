// `cubiclark doctor` through the real built CLI, against a copy of the fixture home. Never the
// real ~/.claude or ~/.cubiclark, and never the real claude: --claude-bin is a stand-in script.

import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
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
