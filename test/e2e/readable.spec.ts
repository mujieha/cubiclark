// The office on real screens (cubiclark-readable): it fills the column it is given, its pixel art is
// a whole number of backing px per art px, and every word is drawn at the display's resolution in a
// size a person can read. Headless Playwright's default (1600 px, ratio 1) is the one window where
// the old office already looked right, so the matrix below runs the windows people use. The page
// clock is paused, so an animation is at an exact frame.

import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { hexToRgb } from '../../src/core/theme/colour.js'
import { DAY, NIGHT } from '../../src/core/theme/index.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'

const CLOCK_AT = '2026-01-15T10:30:00.000Z'
const EVIDENCE_DIR = fileURLToPath(new URL('../../test-results/office/', import.meta.url))

/** The windows people use: a laptop, a retina laptop, a monitor, a big monitor. */
const MATRIX = [
  { width: 1280, height: 800, dpr: 1 },
  { width: 1440, height: 900, dpr: 2 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1 },
] as const

interface Measured {
  hostWidth: number
  cssWidth: number
  cssHeight: number
  artWidth: number
  backing: number
  tilePx: number
  scale: number
  textWidth: number
  textHeight: number
  textCssWidth: number
  textCssHeight: number
  density: number
  rendering: string
  signFont: string
  smallFont: string
  signPx: number
  smallPx: number
  labels: { kind: string; text: string; px: number; region: { x: number; y: number; w: number; h: number } }[]
  dpr: number
}

/** Everything the page says about how big it drew the office and its words, in one read. */
async function measure(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    const art = document.querySelector('canvas.office-canvas') as HTMLCanvasElement
    const text = document.querySelector('canvas.office-text') as HTMLCanvasElement
    const host = document.querySelector('.office-host') as HTMLElement
    const artBox = art.getBoundingClientRect()
    const textBox = text.getBoundingClientRect()
    return {
      hostWidth: host.clientWidth,
      cssWidth: artBox.width,
      cssHeight: artBox.height,
      artWidth: art.width,
      backing: Number(art.dataset.backing),
      tilePx: Number(art.dataset.tilePx),
      scale: Number(art.dataset.scale),
      textWidth: text.width,
      textHeight: text.height,
      textCssWidth: textBox.width,
      textCssHeight: textBox.height,
      density: Number(text.dataset.density),
      rendering: getComputedStyle(text).imageRendering,
      signFont: text.dataset.signFont ?? '',
      smallFont: text.dataset.smallFont ?? '',
      signPx: Number(text.dataset.signPx),
      smallPx: Number(text.dataset.smallPx),
      labels: JSON.parse(text.dataset.labels ?? '[]'),
      dpr: window.devicePixelRatio,
    }
  })
}

const pxOf = (font: string): number => Number(/(\d+)px/.exec(font)?.[1])

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

for (const { width, height, dpr } of MATRIX) {
  test.describe(`a ${width}x${height} window at ratio ${dpr}`, () => {
    test.use({ viewport: { width, height }, deviceScaleFactor: dpr })

    test('the office fills its column, the art is a whole number of backing px per art px, and every word is at the display\'s resolution in a readable size', async ({ page }) => {
      const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT, mascot: false })
      try {
        await pushWorld(page, await loadWorld('rooms'), 400)
        const m = await measure(page)
        const use = m.cssWidth / m.hostWidth

        await mkdir(EVIDENCE_DIR, { recursive: true })
        const row = {
          viewport: `${width}x${height}`,
          dpr,
          hostWidth: m.hostWidth,
          cssWidth: m.cssWidth,
          use: Number(use.toFixed(4)),
          tilePx: m.tilePx,
          scale: m.scale,
          backing: m.backing,
          density: m.density,
          signPx: m.signPx,
          smallPx: m.smallPx,
        }
        await writeFile(`${EVIDENCE_DIR}readable-matrix-${width}x${height}@${dpr}.json`, `${JSON.stringify(row, null, 2)}\n`)
        console.log(`readable: ${JSON.stringify(row)}`)

        expect(m.dpr, 'the window really has this ratio').toBe(dpr)
        expect(use, `the office uses ${(use * 100).toFixed(1)} % of its ${m.hostWidth} px column`).toBeGreaterThanOrEqual(0.9)
        expect(m.cssWidth, 'and does not run past it').toBeLessThanOrEqual(m.hostWidth)

        expect(Number.isInteger(m.backing) && m.backing >= 1, `the art has ${m.backing} backing px per art px`).toBe(true)
        expect(m.artWidth, 'no fractional sprite pixel in the backing store').toBe(36 * 16 * m.backing)

        expect(m.density, 'the words are at the display\'s ratio').toBe(dpr)
        expect(m.textWidth, 'the text canvas has a device pixel for each of its CSS px').toBe(Math.floor(m.textCssWidth * dpr))
        expect(m.textHeight).toBe(Math.floor(m.textCssHeight * dpr))
        expect(m.textCssWidth, 'exactly over the art').toBe(m.cssWidth)
        expect(m.textCssHeight).toBe(m.cssHeight)
        expect(['pixelated', 'crisp-edges'], 'the words are smoothed, never nearest-neighbour').not.toContain(m.rendering)

        expect(pxOf(m.signFont), `names and signs are drawn in ${m.signFont}`).toBeGreaterThanOrEqual(12)
        expect(pxOf(m.signFont)).toBe(m.signPx)
        expect(pxOf(m.smallFont), `bubble text and the whiteboard label are drawn in ${m.smallFont}`).toBeGreaterThanOrEqual(10)
        expect(pxOf(m.smallFont)).toBe(m.smallPx)
        for (const label of m.labels) expect(label.px, `${label.kind} "${label.text}"`).toBeGreaterThanOrEqual(12)
        expect(
          m.labels.filter((label) => label.kind === 'room').map((label) => label.text),
          'the three room names are whole'
        ).toEqual(["Manager's office", 'Planning room', 'Review corner'])
        expect(m.labels.some((label) => label.kind === 'project'), 'and there is a project sign').toBe(true)

        if (dpr === 2) {
          // The pictures to look at: the top rooms, and one cluster's sign, at twice the density.
          const box = await page.locator('canvas.office-canvas').boundingBox()
          if (!box) throw new Error('no canvas box')
          const rooms = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: 7 * m.tilePx } })
          await saveEvidence('readable-rooms-dpr2', rooms)
          expect.soft(rooms).toMatchSnapshot('rooms-top-dpr2.png')

          const sign = m.labels.find((label) => label.kind === 'project')
          if (!sign) throw new Error('no project sign')
          const near = await page.screenshot({
            clip: { x: box.x + sign.region.x - 4, y: box.y + sign.region.y - 4, width: sign.region.w + 8, height: sign.region.h + 8 },
          })
          await saveEvidence('readable-sign-dpr2', near)
          expect.soft(near).toMatchSnapshot('cluster-sign-dpr2.png')
        }
      } finally {
        await cli.stop()
      }
    })
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
