// Spawns the built collector (dist/hook/collector.js) exactly as Claude Code does: payload on
// stdin, no shell, one process per event. Every case asserts the two invariants that matter most:
// exit code 0 and empty stdout (a decision or any output could change what Claude does).

import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { toStoredLine } from '../../src/core/hooks/whitelist.js'
import { SECRETS, SECRET_PAYLOADS } from '../hook-secrets.js'

const COLLECTOR = fileURLToPath(new URL('../../dist/hook/collector.js', import.meta.url))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-collector-'))
})
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

function collect(stateDir: string, input: string) {
  const result = spawnSync(process.execPath, [COLLECTOR, '--state-dir', stateDir], { input, encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  return result
}

async function lines(stateDir: string): Promise<string[]> {
  const text = await readFile(join(stateDir, 'events.jsonl'), 'utf8')
  return text.split('\n').filter((l) => l.length > 0)
}

const PRE_TOOL = {
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  cwd: '/home/user/projects/demo',
  tool_name: 'Bash',
  tool_use_id: 'toolu_1',
  tool_input: { command: 'npm test' },
}

describe('the collector process', () => {
  test('a valid payload becomes exactly one whitelisted line', async () => {
    const state = join(dir, 'state')
    collect(state, JSON.stringify(PRE_TOOL))
    const stored = await lines(state)
    expect(stored).toHaveLength(1)
    const parsed = JSON.parse(stored[0] as string) as { ts: string }
    expect(parsed).toEqual(toStoredLine(PRE_TOOL, parsed.ts))
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false)
  })

  test('malformed stdin still exits 0 with empty stdout and leaves one _malformed line each', async () => {
    const state = join(dir, 'state')
    const inputs = ['', 'not json', '{', '[1,2]', '\u0000ÿ']
    for (const input of inputs) collect(state, input)
    const stored = (await lines(state)).map((l) => JSON.parse(l) as { e: string })
    expect(stored).toHaveLength(inputs.length)
    expect(stored.every((l) => l.e === '_malformed')).toBe(true)
  })

  test('with the soft-off file present nothing is written', async () => {
    const state = join(dir, 'state')
    await mkdir(state)
    await writeFile(join(state, 'off'), 'paused\n')
    const before = await readdir(state)
    collect(state, JSON.stringify(PRE_TOOL))
    expect(await readdir(state)).toEqual(before)
  })

  test('a PostModelSwitch payload stores one line with the new model only, prints nothing', async () => {
    const state = join(dir, 'state')
    const payload = { hook_event_name: 'PostModelSwitch', session_id: 's1', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5' }
    const result = collect(state, JSON.stringify(payload))
    expect(result.stderr).toBe('')
    const stored = await lines(state)
    expect(stored).toHaveLength(1)
    expect(JSON.parse(stored[0] as string)).toMatchObject({ e: 'PostModelSwitch', sid: 's1', model: 'claude-sonnet-5-5' })
    expect(stored[0]).not.toContain('opus')
  })

  test('a PermissionRequest prints no decision and nothing on stderr', () => {
    const payload = { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }
    const result = collect(join(dir, 'state'), JSON.stringify(payload))
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  test('an unwritable state directory still exits 0 with empty stdout', async () => {
    const locked = join(dir, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)
    collect(join(locked, 'state'), JSON.stringify(PRE_TOOL))
  })

  test('at 5 MB the file is rotated to events.1.jsonl', async () => {
    const state = join(dir, 'state')
    await mkdir(state)
    const size = 5 * 1024 * 1024
    await writeFile(join(state, 'events.jsonl'), Buffer.alloc(size, 'x'))
    collect(state, JSON.stringify(PRE_TOOL))
    expect((await stat(join(state, 'events.1.jsonl'))).size).toBe(size)
    expect(await lines(state)).toHaveLength(1)
  })

  test('secrets end to end: none of the fake secrets reaches the file', async () => {
    const state = join(dir, 'state')
    for (const payload of SECRET_PAYLOADS) collect(state, JSON.stringify(payload))
    const text = await readFile(join(state, 'events.jsonl'), 'utf8')
    expect(text).toContain('"e":"PreToolUse"')
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  })

  test('a 6 MB tool response is not stored: one short line', async () => {
    const state = join(dir, 'state')
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Read',
      tool_use_id: 'toolu_big',
      tool_input: { file_path: '/home/user/projects/demo/big.bin' },
      tool_response: { content: 'x'.repeat(6 * 1024 * 1024) },
    }
    collect(state, JSON.stringify(payload))
    const stored = await lines(state)
    expect(stored).toHaveLength(1)
    expect((stored[0] as string).length).toBeLessThan(2048)
  })

  test('20 collectors appending at once leave 20 whole lines', async () => {
    const state = join(dir, 'state')
    await mkdir(state)
    const runs = Array.from({ length: 20 }, (_, i) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [COLLECTOR, '--state-dir', state], { stdio: ['pipe', 'pipe', 'pipe'] })
        child.on('close', (code) => resolve(code))
        child.stdin.end(JSON.stringify({ ...PRE_TOOL, tool_use_id: `toolu_${i}` }))
      })
    )
    expect(await Promise.all(runs)).toEqual(Array.from({ length: 20 }, () => 0))
    const stored = (await lines(state)).map((l) => JSON.parse(l) as { tuid: string })
    expect(stored).toHaveLength(20)
    expect(new Set(stored.map((l) => l.tuid)).size).toBe(20)
  })

  test('without --state-dir, CUBICLARK_HOME picks the directory', async () => {
    const state = join(dir, 'from-env')
    const result = spawnSync(process.execPath, [COLLECTOR], {
      input: JSON.stringify(PRE_TOOL),
      encoding: 'utf8',
      env: { ...process.env, CUBICLARK_HOME: state },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(await lines(state)).toHaveLength(1)
  })

  test('a relative CUBICLARK_HOME writes nothing into the working directory (C1)', async () => {
    const project = join(dir, 'project')
    await mkdir(project)
    const home = join(dir, 'home')
    await mkdir(home)
    const result = spawnSync(process.execPath, [COLLECTOR], {
      input: JSON.stringify(PRE_TOOL),
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, HOME: home, CUBICLARK_HOME: 'state/cubi' },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(await readdir(project)).toEqual([])
    expect(await lines(join(home, '.cubiclark'))).toHaveLength(1)
  })

  test('still records when launched through a symlinked path (macOS /var -> /private/var)', async () => {
    // Node reports argv[1] as given but import.meta.url as the resolved real path; a naive
    // "am I the entry point" comparison would differ here and the collector would do nothing.
    const distDir = join(COLLECTOR, '..', '..')
    const link = join(dir, 'dist-link')
    await symlink(distDir, link)
    const state = join(dir, 'state')
    const result = spawnSync(process.execPath, [join(link, 'hook', 'collector.js'), '--state-dir', state], {
      input: JSON.stringify(PRE_TOOL),
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(await lines(state)).toHaveLength(1)
  })
})
