// One line of a frame (cubiclark-tui): the only place colour is written. Text goes in as spans, every
// span through terminalText (cells.ts), and comes out cut and padded to exactly the width asked for.
// The escape sequences are built here from a closed table of numbers; no text from the World is ever
// part of one. Without colour the line holds no escape byte at all.

import { cellWidth, fitCells } from './cells.js'

export type Tone = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other' | 'morty' | 'alert' | 'muted'

export interface Span {
  text: string
  tone?: Tone
  bold?: boolean
  inverse?: boolean
}

export interface LineStyle {
  color: boolean
  unicode: boolean
}

/** Foreground colours, as SGR parameters: the only ones ever written. */
export const TONE_CODES: Record<Tone, string> = {
  opus: '35',
  sonnet: '34',
  haiku: '32',
  fable: '95',
  other: '39',
  morty: '33',
  alert: '31',
  muted: '90',
}

const BOLD = '1'
const INVERSE = '7'
const RESET = '\x1b[0m'

/** Every escape sequence a frame may hold: reset, bold, inverse, and the foreground colours above. */
// eslint-disable-next-line no-control-regex
export const ALLOWED_SGR = /\x1b\[(?:0|1|7|3[0-79]|9[0-7])(?:;(?:0|1|7|3[0-79]|9[0-7]))*m/g

export function stripSgr(text: string): string {
  return text.replace(ALLOWED_SGR, '')
}

function open(span: Span): string {
  const codes: string[] = []
  if (span.bold) codes.push(BOLD)
  if (span.inverse) codes.push(INVERSE)
  if (span.tone !== undefined) codes.push(TONE_CODES[span.tone])
  return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`
}

/** The spans as one line of exactly `width` cells (spaces after the last one). */
export function line(spans: readonly Span[], width: number, style: LineStyle): string {
  if (width <= 0) return ''
  let left = width
  let out = ''
  for (const span of spans) {
    if (left <= 0) break
    const text = fitCells(span.text, left, style)
    if (text === '') continue
    const start = style.color ? open(span) : ''
    out += start === '' ? text : `${start}${text}${RESET}`
    left -= cellWidth(text)
  }
  return out + ' '.repeat(Math.max(0, left))
}
