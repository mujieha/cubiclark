// What every palette and every set of page colours must satisfy (design §3.1: two different
// situations never render the same way). A built-in theme, a custom palette merged over one, and a
// test all go through these, so a theme can never make two states look alike or text unreadable.
// Each problem is one sentence that names the keys, worded for the person who wrote the palette.

import { contrastRatio, rgbDistance } from './colour.js'
import { PALETTE_KEYS, type PageTokens, type Palette } from './theme.js'

const HEX = /^#[0-9a-fA-F]{6}$/

/** Ink on paper is the text in every bubble. */
export const MIN_INK_CONTRAST = 4.5
/** Paper on red is the alert bubble's text and cross. */
export const MIN_ALERT_CONTRAST = 3
/** The lamps and marks: red, amber and green must not look alike. */
export const MIN_MARK_DISTANCE = 80
/** The shirts say which model an agent runs. */
export const MIN_SHIRT_DISTANCE = 60
/** Text on the page, WCAG AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5

const MARKS = ['a', 'b', 'c'] as const
const SHIRTS = ['3', 'c', 'd', 'e', 'f'] as const

/** Problems with a canvas palette; empty when it is fine. */
export function paletteProblems(palette: Palette): string[] {
  const problems: string[] = []
  for (const key of PALETTE_KEYS) {
    const value = palette[key]
    if (value === undefined) problems.push(`key ${key} is missing`)
    else if (!HEX.test(value)) problems.push(`key ${key} is "${printableValue(value)}", not a #rrggbb colour`)
  }
  const extra = Object.keys(palette).filter((key) => !(PALETTE_KEYS as readonly string[]).includes(key))
  if (extra.length > 0) problems.push(`unknown palette keys: ${extra.slice(0, 5).map(printableValue).join(', ')}`)
  if (problems.length > 0) return problems // the checks below need sixteen good colours

  const at = (key: string): string => palette[key] as string
  const ink = contrastRatio(at('0'), at('1'))
  if (ink < MIN_INK_CONTRAST) {
    problems.push(`keys 0 and 1 have contrast ${ink.toFixed(1)}, need ${MIN_INK_CONTRAST}: bubble text would be hard to read`)
  }
  const alert = contrastRatio(at('1'), at('a'))
  if (alert < MIN_ALERT_CONTRAST) {
    problems.push(`keys 1 and a have contrast ${alert.toFixed(1)}, need ${MIN_ALERT_CONTRAST}: the red alert bubble would be hard to read`)
  }
  pairwise(MARKS, MIN_MARK_DISTANCE, at, problems, 'red, amber and green lamps and marks would look alike')
  pairwise(SHIRTS, MIN_SHIRT_DISTANCE, at, problems, 'two models would wear the same shirt')
  return problems
}

function pairwise(keys: readonly string[], need: number, at: (key: string) => string, problems: string[], why: string): void {
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i] as string
      const b = keys[j] as string
      const distance = rgbDistance(at(a), at(b))
      if (distance < need) problems.push(`keys ${a} and ${b} are too close (distance ${Math.round(distance)}, need ${need}): ${why}`)
    }
  }
}

function printableValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 20)
}

const TEXT_ON = ['bg', 'panelBg', 'rowHover'] as const
const TEXTS = ['fg', 'dim', 'accent', 'warn', 'err'] as const

/** Problems with the page colours: every text colour must have AA contrast on every background it is drawn on. */
export function pageProblems(tokens: PageTokens): string[] {
  const problems: string[] = []
  for (const [name, value] of Object.entries(tokens)) {
    if (!HEX.test(value)) problems.push(`${name} is "${printableValue(value)}", not a #rrggbb colour`)
  }
  if (problems.length > 0) return problems
  for (const text of TEXTS) {
    for (const background of TEXT_ON) {
      const ratio = contrastRatio(tokens[text], tokens[background])
      if (ratio < MIN_TEXT_CONTRAST) {
        problems.push(`${text} on ${background} has contrast ${ratio.toFixed(1)}, need ${MIN_TEXT_CONTRAST}`)
      }
    }
  }
  return problems
}
