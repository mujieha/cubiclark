// The release documents say what a first release must say: a changelog in Keep a Changelog's shape,
// how to install and where it was tested, and how to report a vulnerability. Read as text.

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const collapse = (text: string): string => text.replace(/\s+/g, ' ')
const CHANGELOG = readFileSync(`${ROOT}CHANGELOG.md`, 'utf8')
const README = collapse(readFileSync(`${ROOT}README.md`, 'utf8'))
const SECURITY = collapse(readFileSync(`${ROOT}SECURITY.md`, 'utf8'))

describe('CHANGELOG.md', () => {
  test('is a Keep a Changelog file', () => {
    expect(CHANGELOG.startsWith('# Changelog\n')).toBe(true)
    expect(CHANGELOG).toContain('https://keepachangelog.com/en/1.1.0/')
  })

  test('has the 0.1.0 entry, its date left for the release day, with its three sections in order', () => {
    const at = (needle: string): number => CHANGELOG.indexOf(needle)
    expect(at('## [0.1.0] - YYYY-MM-DD')).toBeGreaterThan(0)
    expect(at('### Added')).toBeGreaterThan(at('## [0.1.0]'))
    expect(at('### Security')).toBeGreaterThan(at('### Added'))
    expect(at('### Known limits')).toBeGreaterThan(at('### Security'))
  })

  test('points to the Known limits and links the release', () => {
    expect(CHANGELOG).toContain('(README.md#known-limits)')
    expect(CHANGELOG).toContain('(SECURITY.md#known-limits)')
    expect(CHANGELOG).toContain('[0.1.0]: https://github.com/mujieha/cubiclark/releases/tag/v0.1.0')
  })
})

describe('README.md', () => {
  test('says how to install before it explains the two ways', () => {
    expect(README.indexOf('## Install')).toBeGreaterThan(0)
    expect(README.indexOf('## Install')).toBeLessThan(README.indexOf('## Two ways to see agents'))
    for (const phrase of ['npx cubiclark', 'npm install -g cubiclark', 'Node.js 22.12 or later', 'cubiclark hooks on']) {
      expect(README, phrase).toContain(phrase)
    }
  })

  test('shows the intro animation under the description, linked to the video', () => {
    expect(README).toContain('<a href="docs/media/cubiclark-intro.mp4"><img src="docs/media/cubiclark-intro.gif" width="720" alt="')
    expect(README.indexOf('cubiclark-intro.gif')).toBeLessThan(README.indexOf('The page is a pixel-art office'))
  })

  test('the animation files exist, and stay small enough for a README and a repository', () => {
    expect(statSync(`${ROOT}docs/media/cubiclark-intro.gif`).size).toBeLessThan(3_000_000)
    expect(statSync(`${ROOT}docs/media/cubiclark-intro.mp4`).size).toBeLessThan(2_000_000)
  })

  test('says where it was tested', () => {
    expect(README).toContain('## Platforms')
    expect(README).toContain('**macOS:** developed and tested')
    expect(README).toContain('tested in CI from the first public run')
    expect(README).toContain('**Windows:** untested')
  })
})

describe('SECURITY.md', () => {
  test('names GitHub private vulnerability reporting as the only channel', () => {
    for (const phrase of [
      'private vulnerability reporting',
      'security/advisories/new',
      'There is no e-mail address for reports',
      'A second round reviewed',
    ]) {
      expect(SECURITY, phrase).toContain(phrase)
    }
  })
})
