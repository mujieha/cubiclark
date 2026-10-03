// Custom assets on the real page: a valid pack is drawn in the office (and named on the sources line),
// an invalid one is not applied and its errors are shown as text, above everything, also on an empty
// screen. The pack is served by the real CLI; worlds come through the fake EventSource where the test
// needs a paused clock, and from the real server where it needs the sources line.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { DAY } from '../../src/core/theme/index.js'
import { hexToRgb } from '../../src/core/theme/colour.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'
import { runCli } from './helpers.js'

const EXAMPLE = fileURLToPath(new URL('../../examples/assets/sunny-office/manifest.json', import.meta.url))
const INVALID = fileURLToPath(new URL('../fixtures/assets/invalid.json', import.meta.url))
const FIXTURE_HOME = fileURLToPath(new URL('../fixtures/home', import.meta.url))
const CLOCK_AT = '2026-01-15T10:30:00.000Z'

/** How many pixels of the office canvas are exactly this colour. */
async function pixelsOf(page: Page, hex: string): Promise<number> {
  const [r, g, b] = hexToRgb(hex)
  return page.evaluate(
    ([red, green, blue]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.office-canvas')
      const data = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      if (data) for (let i = 0; i < data.length; i += 4) if (data[i] === red && data[i + 1] === green && data[i + 2] === blue) count++
      return count
    },
    [r, g, b]
  )
}

test.describe('a valid pack', () => {
  test('is drawn in the office: its colours and sprites are there, the built-in ones are not, against a baseline', { tag: '@pixels' }, async ({ page }) => {
    // Compared with a pre-Morty baseline: Morty off.
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT, args: ['--assets', EXAMPLE], mascot: false })
    try {
      await pushWorld(page, await loadWorld('rooms'), 400)
      const canvas = page.locator('canvas.office-canvas')
      // the pack's day wood colour replaced the built-in one everywhere the office uses it
      expect(await pixelsOf(page, '#d9a86c')).toBeGreaterThan(0)
      expect(await pixelsOf(page, DAY.palette['7'] as string)).toBe(0)
      await saveEvidence('custom-assets', await canvas.screenshot())
      await expect(canvas).toHaveScreenshot('custom-assets.png')
      await expect(page.locator('#asset-errors')).toBeHidden()
    } finally {
      await cli.stop()
    }
  })

  test('is named on the sources line of the real page', async ({ page }) => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0', '--assets', EXAMPLE])
    try {
      await page.goto(cli.url)
      await expect(page.locator('.sources')).toContainText('assets: ok — sunny-office: 2 palettes, 2 sprites')
      await expect(page.locator('#asset-errors')).toBeHidden()
      await expect.poll(() => pixelsOf(page, '#d9a86c')).toBeGreaterThan(0) // the first frame may still be coming
    } finally {
      await cli.stop()
    }
  })
})

test.describe('an invalid manifest', () => {
  test('is not applied, and its errors are shown as text above everything', async ({ page }) => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0', '--assets', INVALID])
    try {
      await page.goto(cli.url)
      const errors = page.locator('#asset-errors')
      await expect(errors).toBeVisible()
      await expect(errors).toContainText('Custom assets not applied: invalid — 9 errors (invalid.json)')
      await expect(errors).toContainText('/version: must be 1')
      await expect(errors).toContainText('/sprites/tile:floor_wood/rows/0: is 5 characters wide, needs exactly 16')
      // a key that looks like markup is shown as itself, never parsed
      await expect(errors).toContainText('/sprites/<b>bold</b>: not a sprite that can be replaced')
      expect(await errors.locator('b').count()).toBe(0)
      await expect(page.locator('.sources')).toContainText('assets: invalid — 9 errors')
      // the office is drawn in the built-in art and colours
      await expect(page.locator('canvas.office-canvas')).toBeVisible()
      await expect.poll(() => pixelsOf(page, DAY.palette['7'] as string)).toBeGreaterThan(0)
      expect(await pixelsOf(page, '#d9a86c')).toBe(0)
      // it is above the office in the page
      const order = await page.evaluate(() => {
        const errorsBox = document.querySelector('#asset-errors')?.getBoundingClientRect()
        const officeBox = document.querySelector('canvas.office-canvas')?.getBoundingClientRect()
        return (errorsBox?.bottom ?? 0) <= (officeBox?.top ?? 0)
      })
      expect(order).toBe(true)
      await saveEvidence('custom-assets-errors', await page.screenshot())
    } finally {
      await cli.stop()
    }
  })

  test('shows on an empty screen too', async ({ page }) => {
    const empty = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-empty-'))
    const cli = await runCli(['--fixture-home', empty, '--no-open', '--port', '0', '--assets', INVALID])
    try {
      await page.goto(cli.url)
      await expect(page.locator('[data-empty]')).toBeVisible()
      await expect(page.locator('#asset-errors')).toBeVisible()
      await expect(page.locator('#asset-errors')).toContainText('/version: must be 1')
    } finally {
      await cli.stop()
      await rm(empty, { recursive: true, force: true })
    }
  })
})
