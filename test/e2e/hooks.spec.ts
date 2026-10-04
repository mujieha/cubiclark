// The list page with a hook source: two sessions that exist only in test/fixtures/state/
// events.jsonl (no transcript at all), next to the five transcript agents of the home world.

import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { runCli } from './helpers.js'

const FIXTURE_HOME = fileURLToPath(new URL('../fixtures/home', import.meta.url))
const FIXTURE_STATE = fileURLToPath(new URL('../fixtures/state', import.meta.url))

test('hook-driven agents appear beside the transcript ones, with observed states and a subagent under its parent', async ({ page }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--state-dir', FIXTURE_STATE, '--no-open', '--port', '0'])
  try {
    await page.goto(`${cli.url}#list`)
    // 5 transcript agents + session ...06 + its subagent + session ...07
    await expect(page.locator('table tbody tr')).toHaveCount(8)

    // A session that started a subagent is delegating.
    const delegating = page.locator('tbody tr', { hasText: 'claude-opus-5-5' })
    await expect(delegating).toHaveCount(1)
    await expect(delegating).toContainText('delegating')

    // Its subagent, known only from SubagentStart, sits under it and is searching.
    const subagent = page.locator('tbody tr', { hasText: '00000006' })
    await expect(subagent).toHaveCount(1)
    await expect(subagent).toContainText('subagent')
    await expect(subagent).toContainText('searching')
    await expect(subagent).toContainText('Grep')

    // A PermissionRequest is a fact, not a guess: no "(inferred)" and no question mark.
    const waiting = page.locator('tbody tr', { hasText: 'claude-sonnet-5-5' })
    await expect(waiting).toHaveCount(1)
    await expect(waiting).toContainText('waiting for permission')
    await expect(waiting).not.toContainText('inferred')
    await expect(waiting).not.toContainText('permission?')

    await expect(page.locator('.sources')).toContainText('transcripts: live')
    await expect(page.locator('.sources')).toContainText('hooks: live (11 events')
  } finally {
    await cli.stop()
  }
})

test('a live append to events.jsonl moves a row over SSE, with no page reload', async ({ page }) => {
  const tempState = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-state-'))
  await cp(FIXTURE_STATE, tempState, { recursive: true })
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--state-dir', tempState, '--no-open', '--port', '0'])
  try {
    await page.goto(`${cli.url}#list`)
    const waiting = page.locator('tbody tr', { hasText: 'claude-sonnet-5-5' })
    await expect(waiting).toContainText('waiting for permission')

    // The user approves, the command finishes: PostToolUse closes the tool and the wait ends.
    const closing = JSON.stringify({
      v: 1,
      ts: '2026-01-15T10:02:30.000Z',
      e: 'PostToolUse',
      sid: '00000000-0000-4000-8000-000000000007',
      tool: 'Bash',
      tuid: 'toolu_fx000070',
    })
    await appendFile(join(tempState, 'events.jsonl'), `${closing}\n`, 'utf8')

    await expect(waiting).not.toContainText('waiting for permission', { timeout: 5000 })
    await expect(waiting).toContainText('thinking')
  } finally {
    await cli.stop()
    await rm(tempState, { recursive: true, force: true })
  }
})

test('without --state-dir a fixture home has no hook source and says so', async ({ page }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('.sources')).toContainText('hooks: not installed')
  } finally {
    await cli.stop()
  }
})
