// The package's own metadata: where it lives, and what an npm tarball may hold.

import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

interface PackageJson {
  repository?: { type?: string; url?: string }
  homepage?: string
  bugs?: { url?: string }
  files?: string[]
  bin?: Record<string, string>
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

  test('the tarball holds the build and the security policy, nothing else of ours', async () => {
    expect((await packageJson()).files).toEqual(['dist', 'SECURITY.md'])
  })

  test('the installed command is the import-free entry that settles the colour variables first', async () => {
    expect((await packageJson()).bin).toEqual({ cubiclark: 'dist/bin.js' })
  })
})
