// String-grid sprites (design §7): a sprite is rows of characters, `.` for transparent, one palette
// key per pixel, and three placeholders (S shirt, K skin, H hair) filled in when it is baked.
// Everything here is pure (bytes in, bytes out); bake.ts is what puts pixels on a canvas.

import type { Point } from '../../core/office/geometry.js'
import { PALETTE, hexToRgb, toneFor, type Palette, type Subst, type Variant } from './palette.js'

export interface SpriteDef {
  w: number
  h: number
  rows: readonly string[]
  /** Where accessories attach: the head and the chest. */
  anchors?: Record<'head' | 'chest', Point>
}

export type { Palette, Subst, Variant }

const PLACEHOLDERS = 'SKH'

/** Problems with a sprite, worded for a test failure; empty when it is fine. With `allowPlaceholders`
 * false the S, K and H placeholders count as errors too, which is how a finished sprite is checked. */
export function validateSprite(def: SpriteDef, name: string, allowPlaceholders = true): string[] {
  const errors: string[] = []
  if (def.rows.length !== def.h) errors.push(`${name}: has ${def.rows.length} rows, expected ${def.h}`)
  def.rows.forEach((row, y) => {
    if (row.length !== def.w) errors.push(`${name}: row ${y} is ${row.length} wide, expected ${def.w}`)
    for (const char of row) {
      if (char === '.' || char in PALETTE) continue
      if (PLACEHOLDERS.includes(char)) {
        if (!allowPlaceholders) errors.push(`${name}: row ${y} has the unsubstituted placeholder "${char}"`)
        continue
      }
      errors.push(`${name}: row ${y} has the unknown character "${char}"`)
    }
  })
  for (const [anchorName, point] of Object.entries(def.anchors ?? {})) {
    if (point.x < 0 || point.y < 0 || point.x >= def.w || point.y >= def.h) {
      errors.push(`${name}: anchor ${anchorName} (${point.x},${point.y}) is outside ${def.w}x${def.h}`)
    }
  }
  return errors
}

function colourOf(char: string, palette: Palette, subst: Subst): string | undefined {
  if (char === '.') return undefined
  const key = char === 'S' || char === 'K' || char === 'H' ? subst[char] : char
  if (key === undefined) throw new Error(`sprite uses the placeholder "${char}" but no substitution was given`)
  const hex = palette[key]
  if (hex === undefined) throw new Error(`sprite uses the unknown palette key "${key}"`)
  return hex
}

/** RGBA bytes, `w * h * 4`, for a sprite: transparent where the grid says `.`, opaque elsewhere. */
export function rasterize(
  def: SpriteDef,
  palette: Palette,
  subst: Subst = {},
  variant: Variant = 'normal'
): Uint8ClampedArray<ArrayBuffer> {
  const bytes = new Uint8ClampedArray(def.w * def.h * 4)
  def.rows.forEach((row, y) => {
    for (let x = 0; x < def.w; x++) {
      const hex = colourOf(row[x] ?? '.', palette, subst)
      if (hex === undefined) continue
      const [r, g, b] = hexToRgb(toneFor(hex, variant, palette))
      const at = (y * def.w + x) * 4
      bytes[at] = r
      bytes[at + 1] = g
      bytes[at + 2] = b
      bytes[at + 3] = 255
    }
  })
  return bytes
}

/** Left-right flip; anchors flip with it. */
export function mirror(def: SpriteDef): SpriteDef {
  return {
    ...def,
    rows: def.rows.map((row) => [...row].reverse().join('')),
    anchors: def.anchors && {
      head: { x: def.w - 1 - def.anchors.head.x, y: def.anchors.head.y },
      chest: { x: def.w - 1 - def.anchors.chest.x, y: def.anchors.chest.y },
    },
  }
}

/** A quarter turn clockwise, for the arrow icon (square sprites only; anchors are dropped). */
export function rotate90(def: SpriteDef): SpriteDef {
  if (def.w !== def.h) throw new Error(`rotate90 needs a square sprite, got ${def.w}x${def.h}`)
  const rows = Array.from({ length: def.w }, (_, y) => Array.from({ length: def.h }, (_, x) => def.rows[def.h - 1 - x]?.[y] ?? '.').join(''))
  return { w: def.w, h: def.h, rows }
}

/** The silhouette: `#` where the sprite has a pixel, `.` where it does not. Two icons that differ
 * only in colour have equal masks, which is exactly what the shape-coding test looks for. */
export function alphaMask(def: SpriteDef): string {
  return def.rows.map((row) => [...row].map((char) => (char === '.' ? '.' : '#')).join('')).join('\n')
}
