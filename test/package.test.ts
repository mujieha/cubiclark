// The package's own metadata: where it lives, and what an npm tarball may hold.

import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { HELP_TEXT } from '../src/cli.js'

interface PackageJson {
  version?: string
  private?: boolean
  repository?: { type?: string; url?: string }
  homepage?: string
  bugs?: { url?: string }
  files?: string[]
  bin?: Record<string, string>
  scripts?: Record<string, string>
}

async function packageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson
}

describe('package.json', () => {
  test('names the repository, the home page and the issue tracker', async () => {
    const pkg = await packageJson()
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/mujieha/cubiclark.git' })
    expect(pkg.homepage).toBe('https://github.com/mujieha/cubiclark#readme')
    expect(pkg.bugs).toEqual({ url: 'https://github.com/mujieha/cubiclark/issues' })
  })

  test('the tarball holds the build, the security policy and the changelog, nothing else of ours', async () => {
    expect((await packageJson()).files).toEqual(['dist', 'SECURITY.md', 'CHANGELOG.md'])
  })

  test('the installed command is the import-free entry that settles the colour variables first', async () => {
    expect((await packageJson()).bin).toEqual({ cubiclark: 'dist/bin.js' })
  })

  test('is publishable, at the version the command prints', async () => {
    const pkg = await packageJson()
    expect(pkg.private, '"private": true would make npm refuse to publish').toBeUndefined()
    expect(pkg.version).toBe('0.1.0')
    expect(HELP_TEXT.startsWith(`cubiclark ${pkg.version}\n`)).toBe(true)
  })

  test('a publish builds from an empty dist and runs the tarball check first', async () => {
    const scripts = (await packageJson()).scripts ?? {}
    expect(scripts['prepublishOnly']).toBe('npm run clean && npm run build && npm run check:tarball')
    expect(scripts['check:tarball']).toBe('tsx scripts/check-tarball.ts')
    expect(scripts['clean']).toContain('dist')
  })
})
