// The words on the office (cubiclark-readable): how big, in which font, cut where, on which plate and
// in which colours. Pure: the renderer measures text and passes the measure in. Sizes are CSS px,
// never below a readable minimum whatever the office's scale; above it they grow with the office.

import type { PaletteKey } from '../theme/theme.js'
import { TILE, type Rect } from './geometry.js'
import type { OfficeLayout } from './layout.js'

/** Room names and project signs. */
export const SIGN_MIN_PX = 12
export const SIGN_MAX_PX = 20
/** Bubble text and the whiteboard label. */
export const SMALL_MIN_PX = 10
export const SMALL_MAX_PX = 16
export const TEXT_FAMILY = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"

export interface TextMetrics {
  /** Room names and project signs. */
  signPx: number
  /** Bubble text and the whiteboard label. */
  smallPx: number
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))

/** 7 and 6 logical px were the old sizes: they still set how the words grow with the office. */
export function textMetrics(cssScale: number): TextMetrics {
  const s = Number.isFinite(cssScale) && cssScale > 0 ? cssScale : 1
  return { signPx: clamp(Math.round(7 * s), SIGN_MIN_PX, SIGN_MAX_PX), smallPx: clamp(Math.round(6 * s), SMALL_MIN_PX, SMALL_MAX_PX) }
}

export function fontFor(px: number, bold = false): string {
  return `${bold ? 'bold ' : ''}${px}px ${TEXT_FAMILY}`
}

/** `text` whole if it fits `maxWidth`, else as many leading characters as fit with an ellipsis, else
 * just the ellipsis if that fits, else ''. */
export function fitText(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (!(maxWidth > 0) || text === '') return ''
  if (measure(text) <= maxWidth) return text
  const chars = [...text]
  for (let n = chars.length - 1; n > 0; n--) {
    const cut = `${chars.slice(0, n).join('')}…`
    if (measure(cut) <= maxWidth) return cut
  }
  return measure('…') <= maxWidth ? '…' : ''
}

/** A text colour on the colour behind it: every pair is checked by paletteProblems (theme/rules.ts). */
export interface TextPair {
  name: string
  ink: PaletteKey
  plate: PaletteKey
}

export const ROOM_NAME_TEXT: TextPair = { name: 'room names', ink: '1', plate: '5' }
export const PROJECT_SIGN_TEXT: TextPair = { name: 'project signs', ink: '1', plate: '6' }
export const WHITEBOARD_TEXT: TextPair = { name: 'the whiteboard label', ink: '0', plate: '1' }

/** The fill, edge, icon ink and accent, and text of each bubble style. Alert bubbles carry no text
 * (visual.ts: `text: 'none'` for every alert state; a unit test pins it), so their `text` is unchecked. */
export const BUBBLE_STYLES = {
  plain: { fill: '1', edge: '0', ink: '0', accent: 'd', text: '0' },
  alert: { fill: 'a', edge: '0', ink: '1', accent: '1', text: '1' },
  // Muted text was '3' (2.7:1): '0' on the light grey is 8.2 by day and 6.4 at night.
  muted: { fill: '2', edge: '3', ink: '3', accent: '2', text: '0' },
} as const satisfies Record<string, { fill: PaletteKey; edge: PaletteKey; ink: PaletteKey; accent: PaletteKey; text: PaletteKey }>

/** Every pair a word is drawn in, for the rule. */
export const CANVAS_TEXT_PAIRS: readonly TextPair[] = [
  ROOM_NAME_TEXT,
  PROJECT_SIGN_TEXT,
  WHITEBOARD_TEXT,
  { name: 'bubble text', ink: BUBBLE_STYLES.plain.text, plate: BUBBLE_STYLES.plain.fill },
  { name: "a quiet agent's bubble text", ink: BUBBLE_STYLES.muted.text, plate: BUBBLE_STYLES.muted.fill },
]

export type LabelKind = 'room' | 'project'

/** A room name or project sign, in CSS px: the band it belongs to, its plate, and where its text
 * starts (left edge, vertical middle). */
export interface LabelBox {
  kind: LabelKind
  text: string
  px: number
  region: Rect
  plate: Rect
  x: number
  y: number
}

/** Logical px: the band each label sits in. Room names are on row 2 of the wall (row 1 has the
 * whiteboard and the meter); project signs inside their sign tile's border. Both bands are 12 tall. */
const BAND_H = 12
const TOP_ROOM_IDS: ReadonlySet<string> = new Set(['manager', 'planning', 'review'])

export function labelBoxes(layout: OfficeLayout, cssScale: number, measure: (text: string, px: number) => number): LabelBox[] {
  const s = Number.isFinite(cssScale) && cssScale > 0 ? cssScale : 1
  const { signPx } = textMetrics(s)
  const pad = Math.max(3, Math.round(signPx / 3))
  const box = (kind: LabelKind, name: string, x: number, y: number, w: number): LabelBox | undefined => {
    const region: Rect = { x: x * s, y: y * s, w: w * s, h: BAND_H * s }
    const text = fitText(name, region.w - 2 * pad, (t) => measure(t, signPx))
    if (text === '') return undefined
    const plateH = Math.max(region.h, signPx + 4)
    const plateX = Math.round(region.x)
    const plate: Rect = {
      x: plateX,
      y: Math.round(region.y + region.h / 2 - plateH / 2),
      // Rounded, but never past the band's right edge.
      w: Math.min(Math.round(measure(text, signPx) + 2 * pad), Math.round(region.x + region.w) - plateX),
      h: Math.round(plateH),
    }
    return { kind, text, px: signPx, region, plate, x: plate.x + pad, y: plate.y + plate.h / 2 }
  }
  const out: LabelBox[] = []
  for (const room of layout.rooms) {
    if (!TOP_ROOM_IDS.has(room.id)) continue
    const label = box('room', room.name, room.rect.x * TILE + 2, 2 * TILE, room.rect.w * TILE - 4)
    if (label) out.push(label)
  }
  for (const cluster of layout.clusters) {
    const sign = cluster.signRect
    const label = box('project', cluster.project, sign.x * TILE + 2, sign.y * TILE + 2, sign.w * TILE - 4)
    if (label) out.push(label)
  }
  return out
}
