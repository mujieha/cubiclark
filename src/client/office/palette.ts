// The palette the office is drawn in, and how an agent picks its shirt, skin and hair. The colours
// themselves are data in src/core/theme/ (one file per theme); this module is what the sprite code
// imports. `PALETTE` is the day palette, the one whose keys every sprite grid is validated
// against. Nothing here touches the DOM, so tests can import it.

import type { ModelFamily } from '../../core/office/roles.js'
import { DAY } from '../../core/theme/day.js'
import { hexToRgb } from '../../core/theme/colour.js'
import type { Palette } from '../../core/theme/theme.js'

export type { Palette }
export { hexToRgb }

/** Palette key -> '#rrggbb'. Keys are the single characters used in sprite grids. */
export const PALETTE: Palette = DAY.palette

/** Placeholders a character grid uses, replaced with a palette key when the sprite is baked. */
export interface Subst {
  /** Shirt. */
  S?: string
  /** Skin. */
  K?: string
  /** Hair. */
  H?: string
}

export type Variant = 'normal' | 'dim' | 'dark'

const SHIRT_KEYS: Record<ModelFamily, string> = { opus: 'e', sonnet: 'd', haiku: 'c', fable: 'f', other: '3' }

export function shirtKey(family: ModelFamily): string {
  return SHIRT_KEYS[family]
}

const SKIN_KEYS = ['8', '7', '9'] as const
const HAIR_KEYS = ['0', '6', 'b', '2'] as const

/** FNV-1a over the UTF-16 code units: a stable, well-spread hash that needs no library. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Skin and hair for an agent, stable for its id, so a character looks the same on every visit. */
export function variantFor(agentId: string): { K: string; H: string } {
  const hash = fnv1a(agentId)
  return { K: SKIN_KEYS[hash % SKIN_KEYS.length] as string, H: HAIR_KEYS[(hash >>> 8) % HAIR_KEYS.length] as string }
}

/** The colour a palette entry takes in a variant: dimmed (a stuck agent: everything greyed) or
 * dark (the lights-off scene). Normal is the palette's own colour. The greys it tones towards are
 * the given palette's own `2`-`5`, so a theme's dim and dark scenes stay inside that theme. */
export function toneFor(hex: string, variant: Variant, palette: Palette = PALETTE): string {
  if (variant === 'normal') return hex
  const lum = brightness(hex)
  if (variant === 'dim') return lum < 0.18 ? (palette['4'] as string) : lum < 0.5 ? (palette['3'] as string) : (palette['2'] as string)
  return lum < 0.18 ? (palette['0'] as string) : lum < 0.5 ? (palette['4'] as string) : (palette['5'] as string)
}

/** Weighted brightness of the gamma-encoded channels, 0 to 1: what the tones' thresholds were set
 * against (kept as it was, so no existing picture changes). */
function brightness(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}
