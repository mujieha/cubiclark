// The two themes, on the real page: `auto` follows the operating system's setting (live), the toggle
// cycles auto, day and night and the choice survives a reload, blocked storage does not break the
// page, and the palette really reaches the canvas. The whole page is compared with a baseline in
// each theme. The page clock is paused so an animation is at an exact frame.

import { expect, test, type Page } from '@playwright/test'
import { DAY, NIGHT } from '../../src/core/theme/index.js'
import { hexToRgb } from '../../src/core/theme/colour.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'

const CLOCK_AT = '2026-01-15T10:30:00.000Z'

const theme = (page: Page): Promise<string | undefined> => page.evaluate(() => document.documentElement.dataset.theme)
const toggleText = (page: Page): Promise<string | null> => page.locator('#theme-toggle').textContent()

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

test.describe('the theme follows the operating system while it is on auto', () => {
  test('dark is night, light is day, and a change while the page is open is followed', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    const cli = await openWithFakeWorld(page)
    try {
      await expect.poll(() => theme(page)).toBe('night')
      expect(await toggleText(page)).toBe('Theme: Auto (night)')
      await page.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => theme(page)).toBe('day')
      expect(await toggleText(page)).toBe('Theme: Auto (day)')
      // the page's own colours followed
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 244, 238)')
    } finally {
      await cli.stop()
    }
  })
})

test.describe('the toggle', () => {
  test('cycles auto, day, night, auto, and the choice is remembered', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    const cli = await openWithFakeWorld(page)
    try {
      const toggle = page.locator('#theme-toggle')
      await expect(toggle).toHaveText('Theme: Auto (day)')
      await toggle.click()
      await expect(toggle).toHaveText('Theme: Day')
      await toggle.click()
      await expect(toggle).toHaveText('Theme: Night')
      expect(await theme(page)).toBe('night')
      // a chosen theme does not follow the operating system
      await page.emulateMedia({ colorScheme: 'light' })
      expect(await theme(page)).toBe('night')

      await page.reload()
      await expect(toggle).toHaveText('Theme: Night')
      expect(await theme(page)).toBe('night')
      await toggle.click()
      await expect(toggle).toHaveText('Theme: Auto (day)')
    } finally {
      await cli.stop()
    }
  })

  test('the toggle is the first control, before the panel and view toggles', async ({ page }) => {
    const cli = await openWithFakeWorld(page)
    try {
      const order = await page.evaluate(() => [...document.querySelectorAll('header button')].map((button) => button.id))
      expect(order).toEqual(['theme-toggle', 'hud-toggle', 'view-toggle'])
    } finally {
      await cli.stop()
    }
  })

  test('with storage blocked the page still renders and the toggle works for the session', async ({ page }) => {
    await page.addInitScript(() => {
      const fail = (): never => {
        throw new Error('storage blocked')
      }
      Storage.prototype.getItem = fail
      Storage.prototype.setItem = fail
    })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('rooms'))
      await expect(page.locator('canvas.office-canvas')).toBeVisible()
      const toggle = page.locator('#theme-toggle')
      await expect(toggle).toContainText('Theme: Auto')
      await toggle.click()
      await expect(toggle).toHaveText('Theme: Day')
      await toggle.click()
      expect(await theme(page)).toBe('night')
    } finally {
      await cli.stop()
    }
  })
})

test.describe('the palette reaches the canvas', () => {
  test('night draws its own wall colour and none of day\'s, and the other way round', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
    try {
      await pushWorld(page, await loadWorld('rooms'), 400)
      expect(await pixelsOf(page, DAY.palette['4'] as string)).toBeGreaterThan(0)
      expect(await pixelsOf(page, NIGHT.palette['4'] as string)).toBe(0)
      await page.locator('#theme-toggle').click() // day
      await page.locator('#theme-toggle').click() // night
      await page.clock.runFor(200)
      expect(await pixelsOf(page, NIGHT.palette['4'] as string)).toBeGreaterThan(0)
      expect(await pixelsOf(page, DAY.palette['4'] as string)).toBe(0)
    } finally {
      await cli.stop()
    }
  })
})

test.describe('the whole page in each theme', () => {
  for (const id of ['day', 'night'] as const) {
    test(`${id}, against a baseline`, async ({ page }) => {
      await page.addInitScript((choice) => localStorage.setItem('cubiclark.theme', choice), id)
      // Compared with a pre-Morty baseline: Morty off.
      const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT, mascot: false })
      try {
        await pushWorld(page, await loadWorld('rooms'), 400)
        expect(await theme(page)).toBe(id)
        await saveEvidence(`theme-${id}`, await page.screenshot())
        await expect(page).toHaveScreenshot(`theme-${id}.png`)
      } finally {
        await cli.stop()
      }
    })
  }
})
