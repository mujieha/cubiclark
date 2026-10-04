// line(): exact width, colour only from the table, no escape byte at all without colour.

import { describe, expect, test } from 'vitest'
import { cellWidth } from '../src/core/tui/cells.js'
import { ALLOWED_SGR, TONE_CODES, line, stripSgr, type Span, type Tone } from '../src/core/tui/line.js'

const mono = { color: false, unicode: true }
const colour = { color: true, unicode: true }

describe('line', () => {
  test('pads to exactly the width', () => {
    expect(line([{ text: 'ab' }], 5, mono)).toBe('ab   ')
    expect(line([], 3, mono)).toBe('   ')
    expect(line([{ text: 'ab' }], 0, mono)).toBe('')
  })

  test('a tone is one foreground colour from the table, then a reset', () => {
    expect(line([{ text: 'Eo', tone: 'opus' }], 4, colour)).toBe('\x1b[35mEo\x1b[0m  ')
  })

  test('bold, inverse and a tone together are still allowed sequences', () => {
    const out = line([{ text: 'x', tone: 'alert', bold: true, inverse: true }], 3, colour)
    expect(out).toBe('\x1b[1;7;31mx\x1b[0m  ')
    expect(stripSgr(out)).toBe('x  ')
  })

  test('every tone is written with its own code and nothing else', () => {
    for (const tone of Object.keys(TONE_CODES) as Tone[]) {
      const out = line([{ text: 'a', tone }], 1, colour)
      expect(out).toBe(`\x1b[${TONE_CODES[tone]}ma\x1b[0m`)
      expect(out.replace(ALLOWED_SGR, '')).toBe('a')
    }
  })

  test('without colour no span writes an escape byte, whatever it asks for', () => {
    const spans: Span[] = [{ text: 'a', tone: 'alert', bold: true, inverse: true }, { text: 'b', tone: 'opus' }]
    expect(line(spans, 4, mono)).toBe('ab  ')
    expect(line(spans, 4, mono)).not.toContain('\x1b')
  })

  test('escape sequences in a span\'s text are stripped, the only ones left are the line\'s own', () => {
    const out = line([{ text: 'a\x1b[31mb\x1b]0;owned\x07c', tone: 'haiku' }], 6, colour)
    expect(out.replace(ALLOWED_SGR, '')).toBe('abc   ')
    expect(out.match(ALLOWED_SGR)).toEqual(['\x1b[32m', '\x1b[0m'])
  })

  test('spans that are too wide come out at exactly the width', () => {
    const spans: Span[] = [{ text: 'hello ', tone: 'opus' }, { text: 'wide 漢字漢字 text', bold: true }, { text: 'more' }]
    for (const width of [1, 5, 8, 12, 17, 30]) {
      for (const style of [mono, colour]) {
        expect(cellWidth(stripSgr(line(spans, width, style)))).toBe(width)
      }
    }
  })

  test('a span cut to nothing writes no colour', () => {
    expect(line([{ text: 'abc' }, { text: 'zzz', tone: 'alert' }], 3, colour)).toBe('abc')
  })
})
