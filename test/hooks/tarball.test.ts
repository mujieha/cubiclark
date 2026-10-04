// scripts/check-tarball.ts against a fresh `npm pack` of the built repository, and against tarballs made
// by hand with one thing wrong. Never the real home: npm gets a home of its own to keep its cache in.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'check-tarball.ts')

let work: string
let npmHome: string

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'cubiclark-tarball-test-'))
  npmHome = join(work, 'home')
  await mkdir(npmHome)
})
afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

function env(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: npmHome, COPYFILE_DISABLE: '1' }
}

/** Runs the check on a tarball. */
function check(tarball: string): { status: number | null; stdout: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, tarball], { cwd: ROOT, encoding: 'utf8', env: env() })
  return { status: run.status, stdout: run.stdout }
}

/** A package that passes the check, with `extra` files added (a path inside package/ and its text). */
async function handMadeTarball(extra: Record<string, string> = {}): Promise<string> {
  const files: Record<string, string> = {
    'package.json': '{"name":"x","version":"0.1.0"}\n',
    LICENSE: 'MIT License\n',
    'README.md': '# x\n',
    'SECURITY.md': '# x\n',
    'CHANGELOG.md': '# x\n',
    'dist/bin.js': '#!/usr/bin/env node\n',
    'dist/cli.js': 'export {}\n',
    'dist/hook/collector.js': 'export {}\n',
    'dist/client/index.html': '<!doctype html>\n',
    ...extra,
  }
  const root = join(work, `made-${Object.keys(extra).length}-${Math.random().toString(36).slice(2)}`)
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, 'package', path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text)
  }
  const tarball = `${root}.tgz`
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package'], { env: env() })
  return tarball
}

describe('scripts/check-tarball.ts', () => {
  test('a fresh npm pack of the built repository is clean, and holds the documents and dist/ only', async () => {
    const packed = join(work, 'packed')
    await mkdir(packed)
    execFileSync('npm', ['pack', '--json', '--dry-run=false', '--pack-destination', packed], { cwd: ROOT, env: env(), stdio: 'ignore' })
    const [tarball] = await readdir(packed)
    expect(tarball, 'npm pack made a tarball').toBeDefined()

    const { status, stdout } = check(join(packed, tarball as string))
    expect(stdout).toContain('tarball check: clean')
    expect(status).toBe(0)
    for (const file of ['LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json', 'dist/bin.js', 'dist/hook/collector.js']) {
      expect(stdout, file).toContain(`\n  ${file}\n`)
    }
    const listed = stdout.split('\n').filter((line) => line.startsWith('  '))
    expect(listed.every((line) => /^ {2}(LICENSE|README\.md|SECURITY\.md|CHANGELOG\.md|package\.json|dist\/.+)$/.test(line))).toBe(true)
  }, 120_000)

  test('a hand-made package with nothing wrong passes (the control for the two below)', async () => {
    const { status, stdout } = check(await handMadeTarball())
    expect(stdout).toContain('tarball check: clean')
    expect(status).toBe(0)
  })

  test('a home path in a built file fails it, and the output names the file and the pattern', async () => {
    const { status, stdout } = check(await handMadeTarball({ 'dist/x.js': 'const p = "/Users/someone/x"\n' }))
    expect(status).toBe(1)
    expect(stdout).toContain('hit: dist/x.js:1 [/Users/]')
    expect(stdout).toContain('tarball check: 1 problem(s)')
  })

  test('a test file in the package fails it, and the output names the file', async () => {
    const { status, stdout } = check(await handMadeTarball({ 'test/a.test.ts': 'export {}\n' }))
    expect(status).toBe(1)
    expect(stdout).toContain('problem: unexpected file: test/a.test.ts')
  })
})
