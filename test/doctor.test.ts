import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorOptions,
  type DoctorReport,
} from '../src/server/doctor.js'
import { COLLECTOR_FILES, hooksOn } from '../src/server/hooks-install.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const FIXTURE_HOME = join(FIXTURES, 'home')
const FIXTURE_STATE = join(FIXTURES, 'state')
const FIXTURE_CLAUDE = join(FIXTURES, 'bin', 'claude')

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cubiclark-doctor-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function options(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    root: FIXTURE_HOME,
    configDir: FIXTURE_HOME,
    fixtureMode: true,
    stateDir: undefined,
    sinceHours: 12,
    claudeBin: FIXTURE_CLAUDE,
    nowMs: () => Date.parse('2026-01-15T10:03:00.000Z'),
    ...overrides,
  }
}

const EVENTS = ['SessionStart', 'PreToolUse']

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    claude: { version: '2.1.284', verified: true },
    hookEvents: { verifiedOn: '2.1.284', events: EVENTS },
    transcripts: { status: 'live', reason: '5 transcript files, 5 read (/claude)' },
    hooks: { status: 'missing', reason: 'not installed: run `cubiclark hooks on`' },
    diagnostics: { unparsedLines: 0, unknownHookShapes: 0, unknownTypes: {}, versions: ['2.1.284'], sourceErrors: [] },
    ...overrides,
  }
}

describe('formatDoctorReport', () => {
  test('live transcripts, hooks not installed', () => {
    expect(formatDoctorReport(report())).toBe(
      [
        'Claude Code   2.1.284 — hook events verified against the hooks reference for this version',
        'Hook events   SessionStart, PreToolUse',
        'transcripts   live      5 transcript files, 5 read (/claude)',
        'hooks         missing   not installed: run `cubiclark hooks on`',
        'diagnostics   0 unparsed lines, 0 unknown hook shapes, 0 unknown record types, versions seen: 2.1.284',
      ].join('\n')
    )
  })

  test('failing hooks show their reason, and a different Claude Code version says it is unverified', () => {
    const text = formatDoctorReport(
      report({
        claude: { version: '9.9.9', verified: false },
        hooks: { status: 'failing', reason: 'the collector copy is missing (/s/bin/x.js); run `cubiclark hooks on` again' },
      })
    )
    expect(text).toContain("Claude Code   9.9.9 — not verified; cubiclark's hook events were verified on 2.1.284")
    expect(text).toContain('hooks         failing   the collector copy is missing')
  })

  test('a claude that cannot be run is reported as not found, with the error', () => {
    const text = formatDoctorReport(report({ claude: { verified: false, error: 'spawn claude ENOENT' } }))
    expect(text).toContain('Claude Code   not found (spawn claude ENOENT)')
  })

  test('diagnostics name unknown record types and count source errors', () => {
    const text = formatDoctorReport(
      report({
        diagnostics: {
          unparsedLines: 3,
          unknownHookShapes: 2,
          unknownTypes: { 'future-thing': 1, 'system:x': 2 },
          versions: [],
          sourceErrors: ['boom', 'bang'],
        },
      })
    )
    expect(text).toContain(
      'diagnostics   3 unparsed lines, 2 unknown hook shapes, 2 unknown record types (future-thing, system:x), versions seen: none, 2 source errors (first: boom)'
    )
  })
})

describe('doctorExitCode', () => {
  test('0 unless a source is failing; missing is not a failure', () => {
    expect(doctorExitCode(report())).toBe(0)
    expect(doctorExitCode(report({ transcripts: { status: 'missing', reason: 'no transcripts folder at /x' } }))).toBe(0)
    expect(doctorExitCode(report({ hooks: { status: 'failing', reason: 'x' } }))).toBe(1)
    expect(doctorExitCode(report({ transcripts: { status: 'failing', reason: 'x' } }))).toBe(1)
  })
})

describe('runDoctor', () => {
  test('the fixture home with no state dir: transcripts live, hooks not checked', async () => {
    const r = await runDoctor(options())
    expect(r.transcripts).toMatchObject({ status: 'live' })
    expect(r.transcripts.reason).toContain('5 transcript files, 5 read')
    expect(r.hooks.status).toBe('missing')
    expect(r.hooks.reason).toContain('not checked')
    expect(r.claude).toEqual({ version: '2.1.284', verified: true })
    expect(r.diagnostics.versions).toContain('2.1.284')
    expect(r.diagnostics.unparsedLines).toBe(0)
    expect(doctorExitCode(r)).toBe(0)
  })

  test('a missing transcripts folder is missing, not failing', async () => {
    const r = await runDoctor(options({ root: join(root, 'nowhere'), configDir: join(root, 'nowhere') }))
    expect(r.transcripts).toEqual({ status: 'missing', reason: `no transcripts folder at ${join(root, 'nowhere')}` })
    expect(doctorExitCode(r)).toBe(0)
  })

  describe('with the collector installed', () => {
    let claude: string
    let state: string
    let dist: string

    beforeEach(async () => {
      claude = join(root, 'claude')
      state = join(root, 'state')
      dist = join(root, 'dist')
      await cp(FIXTURE_HOME, claude, { recursive: true })
      for (const [from] of COLLECTOR_FILES) {
        await mkdir(join(dist, from, '..'), { recursive: true })
        await writeFile(join(dist, from), '// stub\n')
      }
      await hooksOn(
        { configDir: claude, stateDir: state, distDir: dist, defaultStateDir: join(root, 'default-state') },
        { tools: true, nowMs: Date.now() }
      )
      await cp(join(FIXTURE_STATE, 'events.jsonl'), join(state, 'events.jsonl'))
    })

    test('hooks live: 14 events, and the hook agents are folded into the diagnostics', async () => {
      const r = await runDoctor(options({ root: claude, configDir: claude, stateDir: state }))
      expect(r.hooks.status).toBe('live')
      expect(r.hooks.reason).toContain('14 events (tools on)')
      expect(r.diagnostics.unknownHookShapes).toBe(0)
      expect(r.transcripts.status).toBe('live')
    })

    test('the collector copy deleted: hooks failing, exit code 1', async () => {
      await rm(join(state, 'bin'), { recursive: true })
      const r = await runDoctor(options({ root: claude, configDir: claude, stateDir: state }))
      expect(r.hooks.status).toBe('failing')
      expect(r.hooks.reason).toContain('collector copy is missing')
      expect(doctorExitCode(r)).toBe(1)
    })

    test('paused: hooks missing with the resume command', async () => {
      await writeFile(join(state, 'off'), 'paused\n')
      const r = await runDoctor(options({ root: claude, configDir: claude, stateDir: state }))
      expect(r.hooks.status).toBe('missing')
      expect(r.hooks.reason).toContain('cubiclark hooks resume')
    })

    test('a garbled line in events.jsonl is counted in the diagnostics', async () => {
      await writeFile(join(state, 'events.jsonl'), 'garbage\n{"v":1,"ts":"2026-01-15T10:00:00.000Z","e":"_malformed"}\n')
      const r = await runDoctor(options({ root: claude, configDir: claude, stateDir: state }))
      expect(r.diagnostics.unparsedLines).toBe(1)
      expect(r.diagnostics.unknownHookShapes).toBe(1)
    })
  })

  describe('the Claude Code version', () => {
    test('a version this build was not verified on is reported as such', async () => {
      const other = join(root, 'claude-other')
      await writeFile(other, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n')
      await chmod(other, 0o755)
      const r = await runDoctor(options({ claudeBin: other }))
      expect(r.claude).toEqual({ version: '9.9.9', verified: false })
    })

    test('a claude that is not there is reported with the error', async () => {
      const r = await runDoctor(options({ claudeBin: join(root, 'no-such-claude') }))
      expect(r.claude.version).toBeUndefined()
      expect(r.claude.error).toContain('ENOENT')
    })

    test('output that is not a version is reported as an error, not guessed at', async () => {
      const odd = join(root, 'claude-odd')
      await writeFile(odd, '#!/bin/sh\necho "hello"\n')
      await chmod(odd, 0o755)
      const r = await runDoctor(options({ claudeBin: odd }))
      expect(r.claude.version).toBeUndefined()
      expect(r.claude.error).toContain('hello')
    })
  })
})
