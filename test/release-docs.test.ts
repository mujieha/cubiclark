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

  test('has the 0.1.0 entry, dated, with its three sections in order', () => {
    const at = (needle: string): number => CHANGELOG.indexOf(needle)
    expect(CHANGELOG).toMatch(/\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n/)
    expect(CHANGELOG).toMatch(/\n## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}\n/)
    expect(at('## [0.1.1]')).toBeLessThan(at('## [0.1.0]'))
    expect(at('### Added')).toBeGreaterThan(at('## [0.1.0]'))
    expect(at('### Security')).toBeGreaterThan(at('### Added'))
    expect(at('### Known limits')).toBeGreaterThan(at('### Security'))
  })

  test('names every security review round', () => {
    for (const phrase of ['**Review round 1**', '**Review round 2**', '**Review round 3**', '**Cold review**']) {
      expect(CHANGELOG, phrase).toContain(phrase)
    }
  })

  test('points to the Known limits and links the release', () => {
    expect(CHANGELOG).toContain('(README.md#known-limits)')
    expect(CHANGELOG).toContain('(SECURITY.md#known-limits)')
    expect(CHANGELOG).toContain('[0.1.0]: https://github.com/mujieha/cubiclark/releases/tag/v0.1.0')
    expect(CHANGELOG).toContain('[0.1.1]: https://github.com/mujieha/cubiclark/releases/tag/v0.1.1')
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
      'A third round verified every round-2 fix',
      'A cold second reviewer, who was not given the earlier reviews,',
    ]) {
      expect(SECURITY, phrase).toContain(phrase)
    }
  })
})

// The cold reviewer's re-check (D2) and the fourth round (R4-5, R4-6) found sentences that said more than was
// true. Each correction is pinned here, so the old words cannot come back.
describe('the review paragraph and the CHANGELOG say what the reviews did (D2, R4-5, R4-6)', () => {
  const DOCS = [
    ['SECURITY.md', SECURITY],
    ['CHANGELOG.md', collapse(CHANGELOG)],
  ] as const

  test.each(DOCS)('%s: the second reviewer "was not given the earlier reviews"', (_name, text) => {
    expect(text).not.toContain('told nothing of the earlier rounds')
    expect(text).toContain('who was not given the earlier reviews')
  })

  test.each(DOCS)('%s: the runner "will be removed", it has not been yet', (_name, text) => {
    expect(text).not.toContain('is removed from the repository before it becomes public')
    expect(text).not.toContain('runner is removed)')
    expect(text).toContain('will be removed from the repository before it becomes public')
  })

  test('SECURITY.md names the finding closed by a decision, not by a test', () => {
    expect(SECURITY).toContain(
      'were fixed with a test each, except one closed by a recorded decision (a prepublish build and tarball check instead of a prepack step)'
    )
  })

  test('CHANGELOG.md says a cold-review finding was fixed, decided, or is a step before the switch', () => {
    expect(collapse(CHANGELOG)).toContain('each finding was fixed with a test, closed by a recorded decision, or is a step before the repository is public')
  })

  test('the CHANGELOG whitelist bullet names the working directory, as SECURITY.md does', () => {
    expect(collapse(CHANGELOG)).toContain("a few enum values and the session's working directory")
    expect(SECURITY).toContain('The working directory is the one full absolute path the collector keeps')
  })

  test('the `cwd` is kept in full for the orchestrator match only, not for `claude agents`', () => {
    expect(SECURITY).not.toContain('and to a `claude agents` entry by it')
    expect(SECURITY).toContain("matches a session to an orchestrator's task folders by it (the `orchestratorCwds` match in `src/core/adapters/apply.ts`)")
  })

  test("a maintainer's push to a Dependabot branch is named in both documents", () => {
    expect(SECURITY).toContain("A maintainer's own push to a Dependabot branch runs as the maintainer.")
    expect(collapse(CHANGELOG)).toContain(
      "One edge stays and is in `SECURITY.md`: a maintainer's own push to a Dependabot branch runs as the maintainer."
    )
  })

  test('the events-file section says the time of a line is checked, and as what', () => {
    expect(SECURITY).toContain('every field of a line that is read is checked again, the time included, which must be an ISO instant')
  })

  test('the file readers named in SECURITY.md are all the ones that open with O_NONBLOCK', () => {
    expect(SECURITY).toContain("the read of a subagent's sidecar file and the two reads of the hooks status")
  })
})
