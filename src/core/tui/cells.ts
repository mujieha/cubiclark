// The one printable filter for the terminal (cubiclark-tui), and what it takes to put text in a grid of
// cells. Whatever was read from a transcript, a task folder or a configuration file may hold escape
// sequences (window titles, a cleared screen, OSC 52 writing to the clipboard) or characters that change
// how a line is read (bidi overrides, zero-width joiners), so every string that reaches a frame goes
// through terminalText() first. line() (line.ts) is the only caller that builds a frame line.

import { printable } from '../printable.js'

export interface CellOptions {
  /** The terminal can show more than printable ASCII. Without it every other character becomes `?`. */
  unicode: boolean
}

// Whole escape sequences first, so that no parameter bytes are left behind as text. Each pattern runs
// to its terminator or, when it has none, to the end of the string (an unterminated one is never kept).
/* eslint-disable no-control-regex */
const OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x9c|\x1b\\|$)/g
const STRING_SEQUENCE = /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x9c|\x1b\\|$)/g
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g
const TWO_BYTE = /\x1b[@-_]/g
/* eslint-enable no-control-regex */
// Line breaks and tabs: one space each (the next line's text must not start a new line of the frame).
const SPACES = /[\t\n\r\v\f\u{85}\u{2028}\u{2029}]/gu
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}]/gu
const LONE_SURROGATE = /\p{Cs}/gu
const UNASSIGNED = /[\p{Co}\p{Cn}]/gu

// What the page's own wording uses that plain ASCII has a good stand-in for (middle dot, dashes, ellipsis,
// arrows, quotes), so `--ascii` reads "quota -" and not "quota ?".
const ASCII_FOLDS: Readonly<Record<string, string>> = {
  '\u{b7}': '-',
  '\u{2022}': '*',
  '\u{2013}': '-',
  '\u{2014}': '-',
  '\u{2026}': '...',
  '\u{2192}': '->',
  '\u{2190}': '<-',
  '\u{2191}': '^',
  '\u{2193}': 'v',
  '\u{d7}': 'x',
  '\u{2018}': "'",
  '\u{2019}': "'",
  '\u{201c}': '"',
  '\u{201d}': '"',
  '\u{203a}': '>',
  '\u{a0}': ' ',
}
const FOLDABLE = /[\u{b7}\u{2022}\u{2013}\u{2014}\u{2026}\u{2192}\u{2190}\u{2191}\u{2193}\u{d7}\u{2018}\u{2019}\u{201c}\u{201d}\u{203a}\u{a0}]/gu

export function terminalText(text: string, opts: CellOptions): string {
  let out = text.replace(OSC, '').replace(STRING_SEQUENCE, '').replace(CSI, '').replace(TWO_BYTE, '')
  out = out.replace(SPACES, ' ')
  out = printable(out)
  out = out.normalize('NFC').replace(INVISIBLE, '').replace(LONE_SURROGATE, '\u{FFFD}').replace(UNASSIGNED, '?')
  if (!opts.unicode) {
    // Letters with accents lose them (cafe), the page's punctuation gets its ASCII stand-in, the rest is `?`.
    out = out.replace(FOLDABLE, (char) => ASCII_FOLDS[char] ?? '?')
    out = out.normalize('NFD').replace(INVISIBLE, '').replace(/[^\u{20}-\u{7e}]/gu, '?')
  }
  return out
}

// East Asian wide and fullwidth blocks, and the emoji planes: two cells each. Ambiguous-width
// characters count as one (README, Known limits).
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u

function codePointWidth(char: string): number {
  const cp = char.codePointAt(0) as number
  if (cp < 0x1100) return 1
  if (EMOJI_PRESENTATION.test(char)) return 2
  for (const [from, to] of WIDE_RANGES) if (cp >= from && cp <= to) return 2
  return 1
}

/** Cells taken by text that already went through terminalText. */
export function cellWidth(clean: string): number {
  let width = 0
  for (const char of clean) width += codePointWidth(char)
  return width
}

const ellipsisOf = (opts: CellOptions): string => (opts.unicode ? '\u{2026}' : '~')

/** The text after terminalText, cut to at most `width` cells, with an ellipsis where it was cut. */
export function fitCells(text: string, width: number, opts: CellOptions): string {
  if (width <= 0) return ''
  const clean = terminalText(text, opts)
  if (cellWidth(clean) <= width) return clean
  let out = ''
  let used = 0
  for (const char of clean) {
    const w = codePointWidth(char)
    if (used + w > width - 1) break
    out += char
    used += w
  }
  return out + ellipsisOf(opts)
}

/** Spaces after the text up to exactly `width` cells (the text must not be wider already). */
export function padCells(clean: string, width: number): string {
  return clean + ' '.repeat(Math.max(0, width - cellWidth(clean)))
}

/** The text in lines of at most `width` cells, broken at spaces; a word longer than a line is cut. */
export function wrapCells(text: string, width: number, opts: CellOptions): string[] {
  if (width <= 0) return []
  const words = terminalText(text, opts)
    .split(' ')
    .filter((word) => word !== '')
  const lines: string[] = []
  let current = ''
  const flush = (): void => {
    if (current !== '') lines.push(current)
    current = ''
  }
  for (const word of words) {
    let rest = word
    while (cellWidth(rest) > width) {
      flush()
      let piece = ''
      let used = 0
      for (const char of rest) {
        const w = codePointWidth(char)
        if (used + w > width) break
        piece += char
        used += w
      }
      // a character wider than the whole line still has to go somewhere
      if (piece === '') piece = [...rest][0] as string
      lines.push(piece)
      rest = rest.slice(piece.length)
    }
    if (rest === '') continue
    if (current === '') current = rest
    else if (cellWidth(current) + 1 + cellWidth(rest) <= width) current += ` ${rest}`
    else {
      flush()
      current = rest
    }
  }
  flush()
  return lines.length > 0 ? lines : ['']
}
