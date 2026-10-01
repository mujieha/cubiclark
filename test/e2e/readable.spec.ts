// The office on real screens (cubiclark-readable): it fills the column it is given, its pixel art is
// a whole number of backing px per art px, and every word is drawn at the display's resolution in a
// size a person can read. Headless Playwright's default (1600 px, ratio 1) is the one window where
// the old office already looked right, so the matrix below runs the windows people use. The page
// clock is paused, so an animation is at an exact frame.

import { expect, test, type Page } from '@playwright/test'
import { hexToRgb } from '../../src/core/theme/colour.js'
import { DAY, NIGHT } from '../../src/core/theme/index.js'
import { loadWorld, openWithFakeWorld, pushWorld } from './fake-world.js'

const CLOCK_AT = '2026-01-15T10:30:00.000Z'

/** The text canvas's pixel at the corner of the first project sign's plate, as '#rrggbb'. */
async function plateColour(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.office-text')
    if (!canvas) return 'no text canvas'
    const labels = JSON.parse(canvas.dataset.labels ?? '[]') as { kind: string; plate: { x: number; y: number } }[]
    const sign = labels.find((label) => label.kind === 'project')
    if (!sign) return 'no project sign'
    const density = Number(canvas.dataset.density)
    const [r, g, b] = canvas.getContext('2d')?.getImageData(Math.round((sign.plate.x + 1) * density), Math.round((sign.plate.y + 1) * density), 1, 1).data ?? []
    const hex = (n: number | undefined): string => (n ?? 0).toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  })
}

test.describe('the plates follow the theme', () => {
  test('a project sign is drawn on dark wood of the day theme, then of the night theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
    try {
      await pushWorld(page, await loadWorld('rooms'), 400)
      expect(hexToRgb(await plateColour(page))).toEqual(hexToRgb(DAY.palette['6'] as string))
      await page.locator('#theme-toggle').click() // day
      await page.locator('#theme-toggle').click() // night
      await page.clock.runFor(200)
      expect(hexToRgb(await plateColour(page))).toEqual(hexToRgb(NIGHT.palette['6'] as string))
    } finally {
      await cli.stop()
    }
  })
})
