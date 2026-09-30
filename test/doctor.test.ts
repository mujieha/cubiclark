import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  scansText,
  type DoctorOptions,
  type DoctorReport,
} from '../src/server/doctor.js'
import { invalidManifest, sunnyOffice } from '../scripts/assets-fixture-lib.js'
import { validateManifest } from '../src/core/assets/manifest.js'
import { assetsStatusOf } from '../src/core/assets/status.js'
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
    claude: { version: '2.1.285', verified: true },
    hookEvents: { verifiedOn: '2.1.285', events: EVENTS },
    transcripts: { status: 'live', reason: '5 transcript files, 5 read (/claude)' },
    hooks: { status: 'missing', reason: 'not installed: run `cubiclark hooks on`' },
    diagnostics: { unparsedLines: 0, unknownHookShapes: 0, unknownTypes: {}, unparsedBy: {}, versions: ['2.1.284'], sourceErrors: [] },
    ...overrides,
  }
}

describe('formatDoctorReport', () => {
  test('live transcripts, hooks not installed', () => {
    expect(formatDoctorReport(report())).toBe(
      [
        'Claude Code   2.1.285 — hook events verified against the hooks reference for this version',
        'Hook events   SessionStart, PreToolUse',
        'transcripts   live      5 transcript files, 5 read (/claude)',
        'hooks         missing   not installed: run `cubiclark hooks on`',
        'diagnostics   0 unparsed lines, 0 unknown hook shapes, 0 unknown record types, versions seen: 2.1.284',
        'unparsed by   none',
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
    expect(text).toContain("Claude Code   9.9.9 — not verified; cubiclark's hook events were verified on 2.1.285")
    expect(text).toContain('hooks         failing   the collector copy is missing')
  })

  test('the assets line: none, ok, and invalid with one line per error', () => {
    const none = formatDoctorReport(report({ assets: assetsStatusOf(undefined, undefined) }))
    expect(none.split('\n').at(-1)).toBe('assets        none')

    const ok = formatDoctorReport(report({ assets: assetsStatusOf(validateManifest(sunnyOffice()), '/p/manifest.json') }))
    expect(ok.split('\n').at(-1)).toBe('assets        ok — sunny-office: 2 palettes, 2 sprites')

    const bad = formatDoctorReport(report({ assets: assetsStatusOf(validateManifest(invalidManifest()), '/p/bad.json') }))
    const lines = bad.split('\n')
    const at = lines.indexOf('assets        invalid — 9 errors')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe(`${' '.repeat(14)}/extra: unknown key (allowed: $schema, version, name, description, palettes, sprites)`)
    expect(lines).toHaveLength(at + 10)
    expect(lines.slice(at + 1).every((line) => line.startsWith(' '.repeat(14)))).toBe(true)
  })

  test('more errors than are listed say how many more', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`nope${i}`, { rows: [] }]))
    const text = formatDoctorReport(report({ assets: assetsStatusOf(validateManifest({ version: 1, name: 'pack', sprites: many }), 'm.json') }))
    expect(text.split('\n').at(-1)).toBe(`${' '.repeat(14)}…and 20 more`)
  })

  test('an invalid manifest is exit code 1, none and ok are not', () => {
    expect(doctorExitCode(report({ assets: assetsStatusOf(validateManifest(invalidManifest()), 'x.json') }))).toBe(1)
    expect(doctorExitCode(report({ assets: assetsStatusOf(validateManifest(sunnyOffice()), 'x.json') }))).toBe(0)
    expect(doctorExitCode(report({ assets: assetsStatusOf(undefined, undefined) }))).toBe(0)
    expect(doctorExitCode(report())).toBe(0)
  })

  test('runDoctor reads the manifest it is given: ok for the example pack, invalid for the broken one, none without', async () => {
    const example = fileURLToPath(new URL('../examples/assets/sunny-office/manifest.json', import.meta.url))
    const broken = join(FIXTURES, 'assets', 'invalid.json')
    expect((await runDoctor(options({ assetsPath: example }))).assets?.status).toBe('ok')
    const invalid = await runDoctor(options({ assetsPath: broken }))
    expect(invalid.assets).toMatchObject({ status: 'invalid', errorCount: 9 })
    expect(doctorExitCode(invalid)).toBe(1)
    expect((await runDoctor(options())).assets?.status).toBe('none')
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
          unparsedBy: {},
          versions: [],
          sourceErrors: ['boom', 'bang'],
        },
      })
    )
    expect(text).toContain(
      'diagnostics   3 unparsed lines, 2 unknown hook shapes, 2 unknown record types (future-thing, system:x), versions seen: none, 2 source errors (first: boom)'
    )
  })

  test('the unparsed-by line: reasons biggest first, each with its top record types', () => {
    const text = formatDoctorReport(
      report({
        diagnostics: {
          unparsedLines: 13,
          unknownHookShapes: 0,
          unknownTypes: { x: 3 },
          unparsedBy: {
            no_timestamp: { mode: 5, 'last-prompt': 3, user: 1 },
            unknown_type: { x: 3 },
            not_json: { '(none)': 1 },
          },
          versions: [],
          sourceErrors: [],
        },
      })
    )
    expect(text).toContain('unparsed by   no_timestamp 9 (mode 5, last-prompt 3, user 1), unknown_type 3 (x 3), not_json 1 ((none) 1)')
  })

  test('the adapter lines: a config line per warning, then one line per adapter', () => {
    const text = formatDoctorReport(
      report({
        adapters: {
          warnings: ['unknown key "x" ignored'],
          entries: [
            { id: 'task-folders', status: 'live', detail: '5 tasks in 1 root · 0 unparsed log lines' },
            { id: 'quota-samples', status: 'missing', detail: 'no samples file found' },
            { id: 'claude-agents', status: 'off', detail: 'not configured' },
          ],
        },
      })
    )
    expect(text.split('\n').slice(-4)).toEqual([
      'config        unknown key "x" ignored',
      'task-folders  live      5 tasks in 1 root · 0 unparsed log lines',
      'quota-samples missing   no samples file found',
      'claude-agents off       not configured',
    ])
  })

  test('the unparsed-by line keeps only the top five types of a reason', () => {
    const types: Record<string, number> = { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, g: 3 }
    const text = formatDoctorReport(
      report({ diagnostics: { unparsedLines: 42, unknownHookShapes: 0, unknownTypes: {}, unparsedBy: { unknown_type: types }, versions: [], sourceErrors: [] } })
    )
    expect(text).toContain('unparsed by   unknown_type 42 (a 9, b 8, c 7, d 6, e 5)')
  })
})

describe('doctorExitCode', () => {
  const scans = {
    scans: 1,
    scansLastMinute: 1,
    lastScanFiles: 5,
    lastScanDirs: 6,
    lastScanMs: 2,
    rootEntriesSkipped: 0,
    maxConcurrentScans: 1,
    rescanMs: 5000,
    watchEvents: 0,
    watchEventsIgnored: 0,
  }

  test('the scans line follows the transcripts line and says what a scan costs', () => {
    const lines = formatDoctorReport(report({ scans })).split('\n')
    expect(lines[2]).toMatch(/^transcripts /)
    expect(lines[3]).toBe(
      'scans         1 scan in this check, at most 12 a minute while serving · 5 files walked in 6 folders, 2 ms · 0 other entries at the root not walked'
    )
  })

  test('the scans line uses singular words, and says so when every pass rescans', () => {
    const one = formatDoctorReport(report({ scans: { ...scans, scans: 2, lastScanFiles: 1, lastScanDirs: 1, rootEntriesSkipped: 1 } }))
    expect(one).toContain('2 scans in this check')
    expect(one).toContain('1 file walked in 1 folder, 2 ms · 1 other entry at the root not walked')
    const always = formatDoctorReport(report({ scans: { ...scans, rescanMs: 0 } }))
    expect(always).toContain('a scan on every pass while serving')
  })

  test('scansText is exported for anyone who wants the words', () => {
    expect(scansText({ ...scans, rescanMs: 30_000 })).toContain('at most 2 a minute')
  })

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
    expect(r.claude).toEqual({ version: '2.1.285', verified: true })
    expect(r.diagnostics.versions).toContain('2.1.284')
    expect(r.diagnostics.unparsedLines).toBe(0)
    expect(doctorExitCode(r)).toBe(0)
  })

  test('it reports what its one scan cost: the files walked under projects/, and nothing else', async () => {
    const files = async (path: string): Promise<number> => {
      let count = 0
      for (const entry of await readdir(path, { withFileTypes: true })) {
        count += entry.isDirectory() ? await files(join(path, entry.name)) : 1
      }
      return count
    }
    const r = await runDoctor(options())
    expect(r.scans).toMatchObject({ scans: 1, rootEntriesSkipped: 0, maxConcurrentScans: 1, rescanMs: 5000 })
    expect(r.scans?.lastScanFiles).toBe(await files(join(FIXTURE_HOME, 'projects')))
    expect(r.scans?.lastScanDirs).toBeGreaterThanOrEqual(3)
  })

  test('a missing transcripts folder is missing, not failing', async () => {
    const r = await runDoctor(options({ root: join(root, 'nowhere'), configDir: join(root, 'nowhere') }))
    expect(r.transcripts).toEqual({ status: 'missing', reason: `no transcripts folder at ${join(root, 'nowhere')}` })
    expect(doctorExitCode(r)).toBe(0)
  })

  describe('--adapters', () => {
    const FIXTURE_TASKS = join(FIXTURES, 'tasks')
    const FIXTURE_QUOTA = join(FIXTURES, 'quota', 'samples-*.jsonl')
    // a fixture clock inside the quota fixture's day, before the 17:30 sample's 19:00 reset
    const AT = Date.parse('2026-01-16T17:45:00Z')

    async function configWith(adapters: unknown): Promise<string> {
      const path = join(root, 'config.json')
      await writeFile(path, JSON.stringify({ adapters }), { mode: 0o600 })
      await chmod(path, 0o600)
      return path
    }
    const withAdapters = async (adapters: unknown, extra: Partial<DoctorOptions> = {}): Promise<DoctorReport> =>
      // real mode (not a fixture home) so that the injected clock, not the newest transcript, is "now"
      runDoctor(options({ fixtureMode: false, nowMs: () => AT, adapters: { configPath: await configWith(adapters), home: '/home/user' }, ...extra }))

    test('without the flag no adapter is read', async () => {
      expect((await runDoctor(options())).adapters).toBeUndefined()
    })

    test('each configured adapter is detected and read; the others are off', async () => {
      const r = await withAdapters({
        'task-folders': { roots: [FIXTURE_TASKS] },
        'quota-samples': { file: FIXTURE_QUOTA },
        'claude-agents': { enabled: true, bin: FIXTURE_CLAUDE },
      })
      expect(r.adapters?.warnings).toEqual([])
      const [tasks, quota, agents] = r.adapters?.entries ?? []
      expect(tasks).toMatchObject({ id: 'task-folders', status: 'live' })
      expect(tasks?.detail).toMatch(/^7 tasks \(2 planning, 2 building, 1 review, 1 blocked, 1 done\) in 1 root · 1 unparsed log line$/)
      expect(quota).toMatchObject({ id: 'quota-samples', status: 'live' })
      expect(quota?.detail).toContain('5h 62% · 7d 40% · newest sample 2026-01-16T17:30:00.000Z')
      expect(agents).toMatchObject({ id: 'claude-agents', status: 'live' })
      expect(agents?.detail).toContain('4 sessions')
    })

    test('an adapter that is not configured is off; one whose source is absent is missing; exit 0', async () => {
      const r = await withAdapters({ 'quota-samples': { file: join(root, 'nope-*.jsonl') }, 'task-folders': { roots: [join(root, 'nowhere')] } })
      expect(r.adapters?.entries).toEqual([
        { id: 'task-folders', status: 'missing', detail: 'no readable tasks root' },
        { id: 'quota-samples', status: 'missing', detail: 'no samples file found' },
        { id: 'claude-agents', status: 'off', detail: 'not configured' },
      ])
      expect(doctorExitCode(r)).toBe(0)
    })

    test('no config file at all: every adapter is off, no warning', async () => {
      const r = await runDoctor(options({ adapters: { configPath: join(root, 'absent.json'), home: '/h' } }))
      expect(r.adapters?.warnings).toEqual([])
      expect(r.adapters?.entries.map((e) => e.status)).toEqual(['off', 'off', 'off'])
    })

    test('a configuration problem is a warning line', async () => {
      const r = await withAdapters({ 'quota-samples': {}, 'mystery': {} })
      expect(r.adapters?.warnings).toEqual([
        'unknown adapter "mystery" ignored',
        'quota-samples: "file" is required (a path, or a glob such as samples-*.jsonl); ignored',
      ])
    })
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

    test('hooks live: 15 events, and the hook agents are folded into the diagnostics', async () => {
      const r = await runDoctor(options({ root: claude, configDir: claude, stateDir: state }))
      expect(r.hooks.status).toBe('live')
      expect(r.hooks.reason).toContain('15 events (tools on)')
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
