// The first run: nothing installed and nothing to show. The page says how to begin and explains the
// two ways of seeing agents. Through the real CLI over an empty home and over one that does not exist.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { runCli } from './helpers.js'
import { saveEvidence } from './fake-world.js'

test.describe('the setup screen', () => {
  for (const [name, makeHome] of [
    ['an empty folder', async (): Promise<string> => mkdtemp(join(tmpdir(), 'cubiclark-e2e-setup-'))],
    ['a folder that does not exist yet', async (): Promise<string> => join(tmpdir(), 'cubiclark-e2e-setup-missing', 'nowhere')],
  ] as const) {
    test(`shows for ${name}, with the two modes explained`, async ({ page }) => {
      const home = await makeHome()
      const cli = await runCli(['--fixture-home', home, '--no-open', '--port', '0'])
      try {
        await page.goto(cli.url)
        const empty = page.locator('[data-empty="no-collector"]')
        await expect(empty).toBeVisible()
        await expect(empty.locator('.setup-title')).toHaveText('Welcome to Cubiclark')
        await expect(empty.locator('.setup-mode')).toHaveCount(2)
        const transcripts = empty.locator('.setup-mode[data-mode="transcripts"]')
        await expect(transcripts).toContainText('Transcripts only — nothing to install')
        await expect(transcripts).toContainText('No settings are changed')
        const hooks = empty.locator('.setup-mode[data-mode="hooks"]')
        await expect(hooks).toContainText('With hooks — live and precise')
        await expect(hooks.locator('code')).toHaveText('cubiclark hooks on')
        // the screen is not the "unreadable" one, and its office is the no-collector picture
        await expect(page.locator('canvas.office-canvas')).toHaveAttribute('data-scene', 'no-collector')
        await saveEvidence(`setup-${name.startsWith('an empty') ? 'empty' : 'missing'}`, await page.screenshot())
      } finally {
        await cli.stop()
        await rm(home, { recursive: true, force: true })
      }
    })
  }

  test('goes away once a session appears (the folder is created and a transcript written)', async ({ page }) => {
    // covered end to end by list.spec.ts and office-behaviour.spec.ts (empty start, agents appear): here only
    // that the setup screen is hidden when there is something to show
    const cli = await runCli(['--fixture-home', new URL('../fixtures/home', import.meta.url).pathname, '--no-open', '--port', '0'])
    try {
      await page.goto(cli.url)
      await expect(page.locator('[data-empty]')).toBeHidden()
      await expect(page.locator('.setup')).toHaveCount(0)
    } finally {
      await cli.stop()
    }
  })
})
