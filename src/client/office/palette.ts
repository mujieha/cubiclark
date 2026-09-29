// The one 16-colour palette (design §7) and how an agent picks its shirt, skin and hair. Our own
// values, not a published palette. Nothing here touches the DOM, so tests can import it.

import type { ModelFamily } from '../../core/office/roles.js'

/** Palette key -> '#rrggbb'. Keys are the single characters used in sprite grids. */
export type Palette = Readonly<Record<string, string>>

export const PALETTE: Palette = {
  '0': '#16161d', // outline, ink
  '1': '#f2efe6', // paper, bubble fill
  '2': '#a8b0b8', // light grey, muted bubble
  '3': '#5b6470', // mid grey, shirt for "other"
  '4': '#2b3140', // wall dark
  '5': '#3e4a5e', // wall face, hallway
  '6': '#8c5a3a', // wood dark
  '7': '#c9955f', // wood light, desk top
  '8': '#f0c9a0', // skin light
  '9': '#9a6444', // skin dark
  a: '#d8483f', // red: alert bubble, red lamp, cross
  b: '#f0a830', // amber lamp
  c: '#4caf6e', // green: shirt haiku, check tag, plants
  d: '#3d7fd9', // blue: shirt sonnet, screens
  e: '#8a5cc7', // purple: shirt opus
  f: '#e87fa8', // pink: shirt fable
}

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

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** The colour a palette entry takes in a variant: dimmed (a stuck agent: everything greyed) or
 * dark (the lights-off scene). Normal is the palette's own colour. */
export function toneFor(hex: string, variant: Variant): string {
  if (variant === 'normal') return hex
  const lum = luminance(hex)
  if (variant === 'dim') return lum < 0.18 ? (PALETTE['4'] as string) : lum < 0.5 ? (PALETTE['3'] as string) : (PALETTE['2'] as string)
  return lum < 0.18 ? (PALETTE['0'] as string) : lum < 0.5 ? (PALETTE['4'] as string) : (PALETTE['5'] as string)
}
