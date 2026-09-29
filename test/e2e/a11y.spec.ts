// Accessibility, checked by axe-core (a dev dependency: @axe-core/playwright) on the real page in both
// themes: the HUD panel, the list view and the setup screen. A serious or critical violation fails the
// test and is printed; every run's full result is written to test-results/a11y/ for the operator.
// The canvas is not checked (it is aria-hidden; the overlay buttons and the list carry the labels).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { startDay } from './day.js'
import { runCli } from './helpers.js'

const OUT_DIR = fileURLToPath(new URL('../../test-results/a11y/', import.meta.url))
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const THEMES = ['day', 'night'] as const

interface Found {
  id: string
  impact?: string | null
  help: string
  nodes: { target: unknown[]; html: string }[]
}

async function scan(page: Page, name: string, include?: string[]): Promise<Found[]> {
  let builder = new AxeBuilder({ page }).withTags(TAGS)
  for (const selector of include ?? []) builder = builder.include(selector)
  const { violations } = await builder.analyze()
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, `${name}.json`), JSON.stringify(violations, null, 2))
  return violations as Found[]
}

function seriousOnes(found: Found[]): Found[] {
  return found.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
}

function describeAll(found: Found[]): string {
  return found.map((v) => `${v.id} (${v.impact}): ${v.help} — e.g. ${JSON.stringify(v.nodes[0]?.target)}`).join('\n')
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((choice) => localStorage.setItem('cubiclark.theme', choice), theme)
    })

    test('the HUD panel has no serious violations', async ({ page }) => {
      const cli = await startDay()
      try {
        await page.goto(cli.url)
        await expect(page.locator('button.office-agent')).toHaveCount(8)
        // an agent selected, so the card is filled in as well
        await page.locator('button.office-agent').first().click()
        const found = await scan(page, `hud-${theme}`, ['#hud'])
        expect(seriousOnes(found), describeAll(seriousOnes(found))).toEqual([])
      } finally {
        await cli.stop()
      }
    })

    test('the list view has no serious violations', async ({ page }) => {
      const cli = await startDay()
      try {
        await page.goto(`${cli.url}#list`)
        await expect(page.locator('#list-view tbody tr')).toHaveCount(8)
        const found = await scan(page, `list-${theme}`, ['#list-view', '.header'])
        expect(seriousOnes(found), describeAll(seriousOnes(found))).toEqual([])
      } finally {
        await cli.stop()
      }
    })

    test('the setup screen has no serious violations', async ({ page }) => {
      const home = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-a11y-'))
      const cli = await runCli(['--fixture-home', home, '--no-open', '--port', '0'])
      try {
        await page.goto(cli.url)
        await expect(page.locator('.setup')).toBeVisible()
        const found = await scan(page, `setup-${theme}`, ['.page-main', '.header', '#hud'])
        expect(seriousOnes(found), describeAll(seriousOnes(found))).toEqual([])
      } finally {
        await cli.stop()
        await rm(home, { recursive: true, force: true })
      }
    })
  })
}
