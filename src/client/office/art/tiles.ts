// Floors, walls, furniture and props (design §7), drawn in code. Each is a function of (x, y) that
// returns a palette key, so a grid can never be the wrong width. Palette keys: 0 ink, 1 paper,
// 2 light grey, 3 mid grey, 4 wall dark, 5 wall face, 6 wood dark, 7 wood light, a red, b amber,
// c green, d blue.

import type { TileId } from '../../../core/office/tilemap.js'
import type { SpriteDef } from '../sprite.js'

type Pixel = (x: number, y: number) => string

/** A sprite from a pixel function. Out-of-shape pictures are impossible by construction. */
function build(w: number, h: number, pixel: Pixel): SpriteDef {
  return { w, h, rows: Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => pixel(x, y)).join('')) }
}

const tile = (pixel: Pixel): SpriteDef => build(16, 16, pixel)

/** Draws `parts` in order; the last one that returns something other than '.' wins. */
const layers =
  (...parts: Pixel[]): Pixel =>
  (x, y) => {
    let out = '.'
    for (const part of parts) {
      const pixel = part(x, y)
      if (pixel !== '.') out = pixel
    }
    return out
  }

const inRect = (x: number, y: number, x0: number, y0: number, w: number, h: number): boolean => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h

export const TILES: Record<TileId, SpriteDef> = {
  // Floors: one look per room so a person knows where they are without reading the sign.
  floor_wood: tile((x, y) => {
    const seam = (y >> 2) % 2 === 0 ? 5 : 11
    return y % 4 === 3 || x === seam ? '6' : '7'
  }),
  floor_carpet_manager: tile((x, y) => ((x + y) % 4 === 0 ? '5' : '4')),
  floor_carpet_planning: tile((x, y) => ((x * 3 + y * 5) % 7 === 0 ? '7' : '6')),
  floor_tile_review: tile((x, y) => (x % 8 === 0 || y % 8 === 0 ? '3' : (x >> 3) % 2 === (y >> 3) % 2 ? '1' : '2')),
  floor_lobby: tile((x, y) => ((x * 7 + y * 13) % 17 === 0 ? '3' : '2')),
  hall: tile((x, y) => (x === 7 && y % 4 < 2 ? '4' : '5')),
  partition: tile((x, y) => (x === 14 ? '0' : x === 15 ? '4' : y % 8 === 0 && x > 11 ? '0' : '5')),

  // Walls.
  wall_top: tile((x, y) => (y % 4 === 3 || (x + ((y >> 2) % 2) * 4) % 8 === 7 ? '0' : '4')),
  wall_face: tile((x, y) => (y === 12 ? '0' : y > 12 ? '4' : '5')),
  door_closed: tile((x, y) => {
    if (x === 0 || x === 15 || y === 0) return '0'
    if (x === 12 && y > 6 && y < 10) return 'b'
    return inRect(x, y, 3, 3, 10, 12) ? '7' : '6'
  }),
  door_open: tile((x, y) => (x === 0 || x === 15 || y === 0 ? '0' : y > 12 ? '2' : x < 3 || x > 12 ? '6' : '0')),

  // Furniture. A desk is three tiles; the chair sits behind its middle one.
  desk_l: tile((x, y) => (x === 0 ? '0' : y === 0 ? '0' : y < 6 ? '7' : y === 6 ? '0' : y === 15 ? '0' : '6')),
  desk_m: tile((x, y) => (y === 0 ? '0' : y < 6 ? '7' : y === 6 ? '0' : y === 15 ? '0' : '6')),
  desk_r: tile((x, y) => (x === 15 ? '0' : y === 0 ? '0' : y < 6 ? '7' : y === 6 ? '0' : y === 15 ? '0' : '6')),
  chair: tile(layers((x, y) => (inRect(x, y, 3, 8, 10, 8) ? '3' : '.'), (x, y) => (x === 3 || x === 12 || y === 8 ? '0' : '.'))),
  stool: tile(
    layers(
      (x, y) => (inRect(x, y, 4, 8, 8, 3) ? '7' : '.'),
      (x, y) => (inRect(x, y, 4, 8, 8, 1) || inRect(x, y, 4, 10, 8, 1) ? '0' : '.'),
      (x, y) => (inRect(x, y, 7, 11, 2, 4) ? '0' : '.')
    )
  ),
  bench: tile((x, y) => (y < 3 || y > 10 ? '.' : y === 3 || y === 10 ? '0' : y < 7 ? '7' : '6')),
  sign: tile((x, y) => (y === 0 || y === 15 ? '0' : y < 3 || y > 12 ? '6' : '7')),
  whiteboard_l: tile((x, y) => (y < 2 || y > 12 || x === 0 ? '0' : y === 12 ? '3' : '1')),
  whiteboard_r: tile((x, y) => (y < 2 || y > 12 || x === 15 ? '0' : y === 12 ? '3' : '1')),
  meter_frame: tile((x, y) => (inRect(x, y, 1, 2, 14, 10) ? (x === 1 || x === 14 || y === 2 || y === 11 ? '0' : x % 3 === 0 && y > 8 ? '2' : '4') : '.')),
  plant: tile(
    layers(
      (x, y) => (inRect(x, y, 5, 10, 6, 6) ? '6' : '.'),
      (x, y) => (inRect(x, y, 5, 10, 6, 1) ? '0' : '.'),
      (x, y) => ((x - 8) * (x - 8) + (y - 6) * (y - 6) * 2 < 22 ? 'c' : '.'),
      (x, y) => (x === 8 && y >= 6 && y < 10 ? '0' : '.')
    )
  ),
  board: tile((x, y) => (y === 0 || y === 15 || x === 0 || x === 15 ? '6' : (x * 5 + y * 3) % 11 === 0 ? '6' : '7')),
}

// --- Props: smaller pieces drawn on top of the tiles ------------------------------------------

const monitor = (screen: Pixel): SpriteDef =>
  build(8, 8, (x, y) => {
    if (y === 7) return x === 3 || x === 4 ? '3' : '.'
    if (x === 0 || x === 7 || y === 0 || y === 5) return '0'
    return y === 6 ? (x === 3 || x === 4 ? '3' : '.') : screen(x, y)
  })

const lamp = (shade: string): SpriteDef =>
  build(6, 8, (x, y) => {
    if (y < 4) return x >= 1 - Math.min(y, 1) && x <= 4 + Math.min(y, 1) ? (y === 0 || x === 0 || x === 5 ? '0' : shade) : '.'
    if (y < 7) return x === 2 || x === 3 ? '0' : '.'
    return x >= 1 && x <= 4 ? '0' : '.'
  })

export const PROPS = {
  monitor_off: monitor(() => '4'),
  monitor_on: monitor((x, y) => (y % 2 === 0 && x > 1 && x < 6 ? '1' : 'd')),
  monitor_flicker: monitor((x, y) => ((x + y) % 2 === 0 ? '1' : 'd')),
  lamp_off: lamp('3'),
  lamp_red: lamp('a'),
  lamp_amber: lamp('b'),
  wall_clock: build(10, 10, (x, y) => {
    const d = (x - 4.5) * (x - 4.5) + (y - 4.5) * (y - 4.5)
    if (d > 22) return '.'
    if (d > 15) return '0'
    if ((x === 5 && y >= 2 && y <= 5) || (y === 5 && x >= 5 && x <= 7)) return '0'
    return '1'
  }),
  sign_unplugged: build(12, 10, (x, y) => {
    if (x === 0 || x === 11 || y === 0 || y === 9) return '0'
    if (y === 4 && x < 5) return '0'
    if (inRect(x, y, 5, 3, 3, 3)) return '3'
    if (x === 9 && y > 5 && y < 8) return 'a'
    if ((x === 8 || x === 10) && (y === 5 || y === 8)) return 'a'
    return '1'
  }),
  cabinet_locked: build(12, 16, (x, y) => {
    if (x === 0 || x === 11 || y === 0 || y === 15) return '0'
    if (y === 5 || y === 10) return '0'
    if (inRect(x, y, 5, 3, 2, 2) || inRect(x, y, 5, 8, 2, 2) || inRect(x, y, 5, 13, 2, 2)) return '4'
    if (inRect(x, y, 8, 11, 3, 3)) return 'a'
    return y < 5 ? '2' : '3'
  }),
  papers: build(8, 6, (x, y) => (y === 0 || y === 5 || x === 0 || x === 7 ? '0' : y % 2 === 0 ? '3' : '1')),
} satisfies Record<string, SpriteDef>

export type PropId = keyof typeof PROPS
