// The CI configuration, checked as text (R2-1, R2-8). A pull request from a fork must never run on the
// self-hosted Mac, and the hosted Linux job must skip the screenshot comparisons, whose baselines are
// macOS and Chromium: so every comparison sits in a test tagged `@pixels`.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const E2E = join(ROOT, 'test/e2e')

describe('the workflow (R2-1)', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')

  test('the self-hosted job is skipped for a pull request from a fork', () => {
    const guard = "if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"
    const guardAt = workflow.indexOf(guard)
    const runnerAt = workflow.indexOf('runs-on: [self-hosted, macOS, ARM64]')
    expect(guardAt).toBeGreaterThan(-1)
    expect(runnerAt).toBeGreaterThan(guardAt)
    // the guard belongs to the self-hosted job: no other job line sits between them
    expect(workflow.slice(guardAt, runnerAt)).not.toMatch(/^ {2}\w+:/m)
  })

  test('a hosted Linux job runs for forks and for a public repository, without the pixel comparisons', () => {
    const at = workflow.indexOf('\n  hosted:')
    expect(at).toBeGreaterThan(-1)
    const job = workflow.slice(at)
    expect(job).toContain('runs-on: ubuntu-latest')
    expect(job).toContain('github.event.repository.private == false')
    expect(job).toContain("github.event.pull_request.head.repo.full_name != github.repository")
    for (const command of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run test:hooks']) {
      expect(job, command).toContain(`- run: ${command}\n`)
    }
    expect(job).toContain('npx playwright install --with-deps chromium')
    expect(job).toContain('npx playwright test --grep-invert @pixels')
    expect(job).not.toContain('self-hosted')
  })

  test('the self-hosted job keeps everything: the cache off, no --with-deps, the pixel specs', () => {
    const hostedAt = workflow.indexOf('\n  hosted:')
    const selfHosted = workflow.slice(0, hostedAt)
    expect(selfHosted).toContain("cache: ''")
    expect(selfHosted).not.toContain('--with-deps')
    expect(selfHosted).toContain('npm run test:e2e')
    expect(workflow.match(/cache: ''/g)).toHaveLength(1)
  })

  test('no pull_request_target, and every action is pinned by a full SHA', () => {
    expect(workflow).not.toContain('pull_request_target')
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1] as string)
    expect(uses.length).toBe(4)
    for (const use of uses) expect(use, use).toMatch(/@[0-9a-f]{40}$/)
  })
})

describe('the screenshot comparisons (R2-1)', () => {
  const specs = readdirSync(E2E).filter((name) => name.endsWith('.spec.ts'))

  test('there are specs to check', () => {
    expect(specs.length).toBeGreaterThan(10)
  })

  test.each(specs)('every comparison in %s is in a test tagged @pixels', (name) => {
    const source = readFileSync(join(E2E, name), 'utf8')
    for (const match of source.matchAll(/toHaveScreenshot\(|toMatchSnapshot\(/g)) {
      const at = match.index as number
      const starts = [...source.slice(0, at).matchAll(/\btest\(/g)]
      const start = starts[starts.length - 1]?.index
      expect(start, `${name}: a comparison at ${at} outside any test()`).toBeDefined()
      const head = source.slice(start as number, source.indexOf('async', start as number))
      expect(head, `${name}: the test holding the comparison at ${at}`).toContain('@pixels')
    }
  })
})
