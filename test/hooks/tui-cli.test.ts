/* eslint-disable no-control-regex -- the test is about control characters */
// `cubiclark tui` through the real built CLI, against a copy of the fixture home. Stdout is a pipe, so
// it is never the interactive screen: it prints frames and exits. Never the real ~/.claude or ~/.cubiclark.

import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cellWidth } from '../../src/core/tui/cells.js'
import { ALLOWED_SGR, stripSgr } from '../../src/core/tui/line.js'

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))

let root: string
let home: string
let state: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubiclark-tuicli-'))
  home = join(root, 'claude')
  state = join(root, 'state')
  await cp(join(FIXTURES, 'home'), home, { recursive: true })
  await cp(join(FIXTURES, 'state'), state, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The environment is spelled out: nothing about colour, locale or motion may come from the machine running
 * the test (CI sets FORCE_COLOR). The keys are removed, not blanked: Node itself warns on stderr when both
 * NO_COLOR and FORCE_COLOR are present, even empty. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const drop = new Set(['NO_COLOR', 'FORCE_COLOR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CUBICLARK_REDUCED_MOTION'])
  const kept = Object.entries(process.env).filter(([key]) => !drop.has(key))
  return { ...Object.fromEntries(kept), TERM: 'xterm', ...extra }
}

function tui(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, 'tui', '--fixture-home', home, '--state-dir', state, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: cleanEnv(extra),
  })
}

const linesOf = (stdout: string): string[] => {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

describe('cubiclark tui --once', () => {
  test('prints one frame of the size asked for and exits 0', () => {
    const result = tui(['--once', '--size', '120x40'])
    expect(result.status).toBe(0)
    const lines = linesOf(result.stdout)
    expect(lines).toHaveLength(40)
    for (const l of lines) expect(cellWidth(l)).toBe(120)
    expect(result.stdout).not.toContain('\x1b')
    expect(lines[0]).toMatch(/^Cubiclark /)
    expect(lines[1]).toMatch(/^busy \d+\/\d+/)
    expect(lines.join('\n')).toContain("Manager's office")
  })

  test('shows the fixture agents, not an empty screen', () => {
    const text = tui(['--once', '--size', '120x40']).stdout
    expect(text).toMatch(/\[Agents 8\]/)
    expect(text).toContain('waiting for permission')
  })

  test('writes nothing to stderr', () => {
    expect(tui(['--once']).stderr).toBe('')
  })
})

describe('cubiclark tui --frames', () => {
  test('prints that many frames', () => {
    const result = tui(['--frames', '3', '--size', '80x24'])
    expect(result.status).toBe(0)
    expect(linesOf(result.stdout)).toHaveLength(72)
  })
})

describe('not a terminal', () => {
  test('a pipe gets one frame of 80x24, and never the alternate screen or the cursor sequences', () => {
    const result = tui([])
    expect(result.status).toBe(0)
    expect(linesOf(result.stdout)).toHaveLength(24)
    expect(result.stdout).not.toContain('?1049')
    expect(result.stdout).not.toContain('?25')
  })
})

describe('colour', () => {
  test('FORCE_COLOR gives the allowed colour codes and nothing else that is a control character', () => {
    const result = tui(['--once'], { FORCE_COLOR: '1' })
    expect(result.status).toBe(0)
    expect(result.stdout.match(ALLOWED_SGR)?.length ?? 0).toBeGreaterThan(10)
    expect(result.stdout.replace(ALLOWED_SGR, '').replace(/\n/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    for (const l of linesOf(result.stdout)) expect(cellWidth(stripSgr(l))).toBe(80)
  })

  test('NO_COLOR and --no-color give a frame with no escape byte, whatever FORCE_COLOR says', () => {
    expect(tui(['--once'], { FORCE_COLOR: '1', NO_COLOR: '1' }).stdout).not.toContain('\x1b')
    expect(tui(['--once', '--no-color'], { FORCE_COLOR: '1' }).stdout).not.toContain('\x1b')
  })
})

describe('Morty', () => {
  test('is in the lobby as a d and a word with --ascii', () => {
    const text = tui(['--once', '--ascii']).stdout
    expect(text).toContain('d napping')
    expect(text).not.toContain('\u{1F415}')
    expect(text).not.toMatch(/[^\u0000-\u007f]/)
  })

  test('is a dog emoji under a UTF-8 locale', () => {
    expect(tui(['--once'], { LANG: 'en_US.UTF-8' }).stdout).toContain('\u{1F415} napping')
  })

  test('is absent with --no-mascot', () => {
    const text = tui(['--once', '--ascii', '--no-mascot']).stdout
    expect(text).not.toContain('napping')
    expect(text).not.toMatch(/\bd (napping|wandering|drinking|greeting|sitting by|playing ball|sniffing)/)
  })

  test('sleeps in the same place however many frames, with --no-animation', () => {
    const text = tui(['--frames', '3', '--ascii', '--no-animation']).stdout
    expect(text.match(/d napping/g)).toHaveLength(3)
  })
})

describe('bad input', () => {
  test('--frames 0 is refused with a message on stderr', () => {
    const result = tui(['--frames', '0'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid --frames: 0')
    expect(result.stdout).toBe('')
  })

  test('a flag of another command is refused', () => {
    const result = tui(['--port', '1'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--port is not valid for tui')
  })

  test('a fixture home that does not exist is a first run, still one frame and exit 0', () => {
    const result = spawnSync(process.execPath, [CLI, 'tui', '--once', '--fixture-home', join(root, 'nothing-here'), '--size', '100x30'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: cleanEnv({ NO_COLOR: '1' }),
    })
    expect(result.status).toBe(0)
    expect(linesOf(result.stdout)).toHaveLength(30)
    expect(result.stdout).toContain('Welcome to Cubiclark')
  })
})
