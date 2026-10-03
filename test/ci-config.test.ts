// The CI configuration, checked as text (R2-1, R2-8). A pull request from a fork must never run on the
// self-hosted Mac, and the hosted Linux job must skip the screenshot comparisons, whose baselines are
// macOS and Chromium: so every comparison sits in a test tagged `@pixels`.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const E2E = join(ROOT, 'test/e2e')

describe('the workflow (R2-1, R3-1)', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')

  /** The `if:` line of a job, and the `runs-on:` line that follows it, taken from the job's own text. */
  const guardOf = (job: string): string => {
    const line = job.split('\n').find((text) => text.trim().startsWith('if: '))
    expect(line, 'the job has an if: line').toBeDefined()
    return (line as string).trim()
  }
  const hostedAt = workflow.indexOf('\n  hosted:')
  const selfHostedJob = workflow.slice(0, hostedAt)
  const hostedJob = workflow.slice(hostedAt)

  test('the self-hosted job runs only while the repository is private, for this repository\'s own branches', () => {
    expect(hostedAt).toBeGreaterThan(-1)
    // the self-hosted job is the one that holds the self-hosted runner, and it holds only that
    expect(selfHostedJob).toContain('runs-on: [self-hosted, macOS, ARM64]')
    const guard = guardOf(selfHostedJob)
    // once the repository is public the condition is false, whatever a pull request's workflow says
    expect(guard).toContain('github.event.repository.private == true')
    // a pull request from a fork never selects it
    expect(guard).toContain("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository")
    // the guard sits above its own runs-on line, with no other job line between them
    const guardAt = selfHostedJob.indexOf(guard)
    const runnerAt = selfHostedJob.indexOf('runs-on: [self-hosted, macOS, ARM64]')
    expect(runnerAt).toBeGreaterThan(guardAt)
    expect(selfHostedJob.slice(guardAt, runnerAt)).not.toMatch(/^ {2}\w+:/m)
  })

  test('the self-hosted runner is named by no other job', () => {
    expect(workflow.match(/self-hosted/g)).toHaveLength(1)
  })

  test('a hosted Linux job runs for forks and for a public repository, without the pixel comparisons', () => {
    const job = hostedJob
    expect(job).toContain('runs-on: ubuntu-latest')
    const guard = guardOf(job)
    expect(guard).toContain('github.event.repository.private == false')
    expect(guard).toContain("github.event.pull_request.head.repo.full_name != github.repository")
    for (const command of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm run test:hooks']) {
      expect(job, command).toContain(`- run: ${command}\n`)
    }
    expect(job).toContain('npx playwright install --with-deps chromium')
    expect(job).toContain('npx playwright test --grep-invert @pixels')
    expect(job).not.toContain('self-hosted')
  })

  test('the self-hosted job keeps everything: the cache off, no --with-deps, the pixel specs', () => {
    const selfHosted = selfHostedJob
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

describe('Dependabot (R2-8)', () => {
  test('proposes updates to the actions and to the npm dependencies, weekly, into develop', () => {
    const config = readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8')
    expect(config).toContain('version: 2')
    expect(config).toContain('package-ecosystem: github-actions')
    expect(config).toContain('package-ecosystem: npm')
    expect(config.match(/interval: weekly/g)).toHaveLength(2)
    expect(config.match(/target-branch: develop/g)).toHaveLength(2)
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
