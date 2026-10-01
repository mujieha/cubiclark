// How big the office is drawn (cubiclark-readable): in whole CSS px per tile, as wide as the column
// it is given, with the art a whole number of backing px per art px and the words at the display's
// own resolution.

import { describe, expect, test } from 'vitest'
import { MAX_BACKING_AREA_PX, MAX_BACKING_SIDE_PX, MAX_TILE_CSS_PX, MIN_TILE_CSS_PX, TILE, officeSize } from '../src/core/office/geometry.js'

const COLS = 36

/** The office's column for a window `viewport` px wide. Mirrors `#app` in src/client/style.css: 16 px
 * of padding each side, a 16 px gap and the 380 px panel; below 1100 px one column. */
const columnFor = (viewport: number): number => (viewport < 1100 ? viewport - 32 : viewport - 32 - 16 - 380)
const columnWithoutPanel = (viewport: number): number => viewport - 32

describe('officeSize: the width it uses', () => {
  test('at least 90 % of every column from 576 to 2240 CSS px', () => {
    for (let column = 576; column <= 2240; column++) {
      const size = officeSize(column, 1, COLS, 20)
      expect(size.cssWidth / column, `a column of ${column} px`).toBeGreaterThanOrEqual(0.9)
      expect(size.cssWidth, `a column of ${column} px`).toBeLessThanOrEqual(column)
    }
  })

  test('at least 90 % in every window from 900 to 2600 px with the panel open, at ratios 1 and 2', () => {
    for (let viewport = 900; viewport <= 2600; viewport++) {
      for (const dpr of [1, 2]) {
        const column = columnFor(viewport)
        const size = officeSize(column, dpr, COLS, 20)
        expect(size.cssWidth / column, `a window of ${viewport} px at ratio ${dpr}`).toBeGreaterThanOrEqual(0.9)
        expect(size.cssWidth, `a window of ${viewport} px`).toBeLessThanOrEqual(column)
      }
    }
  })

  test('at least 90 % with the panel hidden, up to the window where the largest tile stops it growing', () => {
    // 56-px tiles are 2016 px wide: that is 90 % of a 2240 px column, a 2272 px window.
    for (let viewport = 900; viewport <= 2272; viewport++) {
      const column = columnWithoutPanel(viewport)
      expect(officeSize(column, 1, COLS, 20).cssWidth / column, `a window of ${viewport} px, panel hidden`).toBeGreaterThanOrEqual(0.9)
    }
  })
})

describe('officeSize: the matrix windows', () => {
  test.each([
    // column, ratio, tile px, scale, art backing, text density
    [852, 1, 23, 1.4375, 1, 1],
    [1012, 2, 28, 1.75, 4, 2],
    [1172, 1, 32, 2, 2, 1],
    [1492, 1, 41, 2.5625, 3, 1],
    [2132, 1, 56, 3.5, 4, 1],
    [2132, 2, 56, 3.5, 7, 2],
  ])('a column of %i px at ratio %i: %i px tiles, scale %f, art backing %i, text density %i', (column, dpr, tile, scale, backing, density) => {
    const size = officeSize(column, dpr, COLS, 20)
    expect(size.tileCssPx).toBe(tile)
    expect(size.cssScale).toBe(scale)
    expect(size.cssWidth).toBe(COLS * tile)
    expect(size.cssHeight).toBe(20 * tile)
    expect(size.backing).toBe(backing)
    expect(size.textDensity).toBe(density)
  })
})

describe('officeSize: the tile', () => {
  test('is a whole number of CSS px from 16 to 56, whatever the column is said to be', () => {
    for (const column of [0, -5, Number.NaN, 100, 575, 576, 900, 4000, Number.POSITIVE_INFINITY]) {
      const size = officeSize(column, 1, COLS, 20)
      expect(Number.isInteger(size.tileCssPx), `column ${column}`).toBe(true)
      expect(size.tileCssPx, `column ${column}`).toBeGreaterThanOrEqual(MIN_TILE_CSS_PX)
      expect(size.tileCssPx, `column ${column}`).toBeLessThanOrEqual(MAX_TILE_CSS_PX)
      expect(size.cssWidth, `column ${column}`).toBe(COLS * size.tileCssPx)
      expect(size.cssHeight, `column ${column}`).toBe(20 * size.tileCssPx)
      expect(size.cssScale, `column ${column}`).toBe(size.tileCssPx / TILE)
    }
  })

  test('a column narrower than the office is drawn at the smallest tile, and scrolls, as before', () => {
    expect(officeSize(575, 1, COLS, 20).tileCssPx).toBe(16)
    expect(officeSize(300, 1, COLS, 20).tileCssPx).toBe(16)
  })

  test('a very wide column stops at the largest tile', () => {
    expect(officeSize(4000, 1, COLS, 20).tileCssPx).toBe(56)
  })
})

describe('officeSize: the art', () => {
  test('is a whole number of backing px per art px, and the browser stretches it by a factor within 2/3 and 3/2', () => {
    for (let column = 576; column <= 2240; column += 7) {
      for (const dpr of [1, 1.5, 2]) {
        const size = officeSize(column, dpr, COLS, 20)
        const label = `a column of ${column} px at ratio ${dpr}`
        expect(Number.isInteger(size.backing), label).toBe(true)
        expect(size.backing, label).toBeGreaterThanOrEqual(1)
        expect(size.backing, label).toBe(Math.round(size.cssScale * dpr))
        const stretch = (size.cssScale * dpr) / size.backing
        expect(stretch, label).toBeGreaterThanOrEqual(2 / 3)
        expect(stretch, label).toBeLessThanOrEqual(3 / 2)
      }
    }
  })

  test('at a ratio of 3 it is still a whole number of at least 1 (the area cap may lower it)', () => {
    for (let column = 576; column <= 2240; column += 31) {
      const size = officeSize(column, 3, COLS, 20)
      expect(Number.isInteger(size.backing), `a column of ${column} px`).toBe(true)
      expect(size.backing, `a column of ${column} px`).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('officeSize: the words', () => {
  test('are at the display ratio for an office of ordinary size', () => {
    for (let rows = 5; rows <= 30; rows++) {
      for (let column = 576; column <= 2240; column += 13) {
        for (const dpr of [1, 2]) {
          expect(officeSize(column, dpr, COLS, rows).textDensity, `${rows} rows, a column of ${column} px, ratio ${dpr}`).toBe(dpr)
        }
      }
    }
  })

  test('on a tall office stay inside the limits of a canvas, and are never zero', () => {
    for (const rows of [329, 5000]) {
      const size = officeSize(1172, 2, COLS, rows)
      const width = Math.floor(size.cssWidth * size.textDensity)
      const height = Math.floor(size.cssHeight * size.textDensity)
      expect(size.textDensity, `${rows} rows`).toBeGreaterThan(0)
      expect(size.textDensity, `${rows} rows`).toBeLessThan(2)
      expect(width, `${rows} rows`).toBeLessThanOrEqual(MAX_BACKING_SIDE_PX)
      expect(height, `${rows} rows`).toBeLessThanOrEqual(MAX_BACKING_SIDE_PX)
      expect(width * height, `${rows} rows`).toBeLessThanOrEqual(MAX_BACKING_AREA_PX)
    }
  })
})
