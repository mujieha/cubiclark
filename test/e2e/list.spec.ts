import { cp, mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { runCli } from './helpers.js'

const FIXTURE_HOME = fileURLToPath(new URL('../fixtures/home', import.meta.url))

test('the table lists all five fixture agents with kind, parent, model, state and current tool', async ({ page }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
  try {
    await page.goto(`${cli.url}#list`)
    await expect(page.locator('table tbody tr')).toHaveCount(5)

    const tableText = await page.locator('table').innerText()
    for (const expected of [
      'session',
      'background',
      'subagent',
      'claude-sonnet-5',
      'waiting for you',
      'delegating',
      'searching',
      'rate limited',
      'demo',
      'shop',
      'npm',
      'Explore',
    ]) {
      expect(tableText).toContain(expected)
    }

    // The subagent's row names its parent by short id (the tail of its id, which is what
    // actually varies between our fixture agents) plus nothing — the explore parent has no
    // label of its own, only its subagent does.
    expect(tableText).toContain('00000003')
  } finally {
    await cli.stop()
  }
})

test('the diagnostics line is visible and reports a clean parse', async ({ page }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('.diagnostics')).toContainText('unparsed 0')
  } finally {
    await cli.stop()
  }
})

test('an empty fixture home (no transcripts at all) shows the no-collector screen', async ({ page }) => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-empty-'))
  const cli = await runCli(['--fixture-home', emptyHome, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('[data-empty]')).toHaveAttribute('data-empty', 'no-collector')
  } finally {
    await cli.stop()
    await rm(emptyHome, { recursive: true, force: true })
  }
})

test('a fixture home that cannot be listed (it is a file) shows the unreadable screen', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-file-'))
  const file = join(dir, 'not-a-folder')
  await writeFile(file, 'x')
  const cli = await runCli(['--fixture-home', file, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('[data-empty]')).toHaveAttribute('data-empty', 'unreadable')
  } finally {
    await cli.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a fixture home that does not exist is a first run, not an unreadable folder', async ({ page }) => {
  const missing = join(tmpdir(), 'cubiclark-e2e-missing-does-not-exist')
  const cli = await runCli(['--fixture-home', missing, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('[data-empty]')).toHaveAttribute('data-empty', 'no-collector')
  } finally {
    await cli.stop()
  }
})

test('a live append to a transcript updates a row over SSE, with no page reload', async ({ page }) => {
  const tempHome = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-live-'))
  await cp(FIXTURE_HOME, tempHome, { recursive: true })
  const cli = await runCli(['--fixture-home', tempHome, '--no-open', '--port', '0'])
  try {
    await page.goto(`${cli.url}#list`)
    const backgroundRow = page.locator('tbody tr', { hasText: 'background' })
    await expect(backgroundRow).toContainText('running')

    const bgFile = join(tempHome, 'projects', '-home-user-projects-demo', '00000000-0000-4000-8000-000000000002.jsonl')
    const closingResult = JSON.stringify({
      uuid: '00000000-0000-4000-8000-1ffffffffffe',
      parentUuid: null,
      timestamp: '2026-01-15T10:05:00.000Z',
      sessionId: '00000000-0000-4000-8000-000000000002',
      cwd: '/home/user/projects/demo',
      version: '2.1.284',
      sessionKind: 'bg',
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: 'ok' }] },
    })
    await appendFile(bgFile, `${closingResult}\n`, 'utf8')

    // Closing the worker's only open tool moves it out of 'running' (the reducer's tool_end
    // handler falls back to 'thinking' with no open tools left) with no reload of the page.
    await expect(backgroundRow).not.toContainText('running', { timeout: 5000 })
  } finally {
    await cli.stop()
    await rm(tempHome, { recursive: true, force: true })
  }
})
