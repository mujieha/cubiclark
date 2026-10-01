// terminalText: the one filter for text going to a terminal; and the widths cut, pad and wrap work in.

/* eslint-disable no-control-regex -- the test is about control characters */
import { describe, expect, test } from 'vitest'
import { cellWidth, fitCells, padCells, terminalText, wrapCells } from '../src/core/tui/cells.js'

const U = { unicode: true }
const A = { unicode: false }

describe('terminalText: escape sequences leave whole', () => {
  test.each([
    ['a\x1b[31mb', 'ab'],
    ['a\x1b]0;title\x07b', 'ab'],
    ['a\x1b]8;;http://x\x1b\\b', 'ab'],
    ['\x9b2Jx', 'x'],
    ['a\x1b[?1049lb', 'ab'],
    ['a\x1b[', 'a'],
    ['a\x1b', 'a'],
    ['\x1bPpayload\x1b\\z', 'z'],
    ['a\x1b]52;c;AAAA', 'a'],
    ['a\x9d0;t\x9cb', 'ab'],
  ])('%j -> %j', (input, expected) => {
    expect(terminalText(input, U)).toBe(expected)
  })
})

describe('terminalText: controls and invisible characters', () => {
  test('line breaks and tabs become one space each', () => {
    expect(terminalText('a\nb\r\tc\u{2028}d', U)).toBe('a b  c d')
  })

  test('NUL, BEL, DEL and the C1 controls are gone', () => {
    const text = terminalText('a\u0000b\u0007c\u007fd\u0085e\u0096f', U)
    expect(text).not.toMatch(/[\u0000-\u0008\u007f-\u009f]/)
    expect(text.replace(/ /g, '')).toBe('abcdef')
  })

  test('bidi overrides, zero-width characters, joiners and the BOM are gone', () => {
    expect(terminalText('a‮b​c‍d⁦e﻿­f', U)).toBe('abcdef')
  })

  test('a combining accent is folded into its letter, a variation selector is dropped', () => {
    expect(terminalText('é', U)).toBe('é')
    expect(terminalText('✓️', U)).toBe('✓')
  })

  test('a lone surrogate becomes the replacement character', () => {
    expect(terminalText('a\ud800b', U)).toBe('a\u{FFFD}b')
  })

  test('without unicode everything above ~ becomes ?', () => {
    expect(terminalText('café 漢🐕', A)).toBe('caf? ??')
    expect(terminalText('plain', A)).toBe('plain')
  })
})

describe('cellWidth', () => {
  test.each([
    ['abc', 3],
    ['漢字', 4],
    ['🐕', 2],
    ['한', 2],
    ['é', 1],
    ['─', 1],
    ['', 0],
  ])('%j is %i cells', (text, width) => {
    expect(cellWidth(text)).toBe(width)
  })
})

describe('fitCells, padCells, wrapCells', () => {
  test('cuts with an ellipsis, in both character sets', () => {
    expect(fitCells('abcdef', 4, U)).toBe('abc…')
    expect(fitCells('abcdef', 4, A)).toBe('abc~')
    expect(fitCells('abc', 4, U)).toBe('abc')
    expect(fitCells('abcdef', 0, U)).toBe('')
  })

  test('a wide character that does not fit is cut, never half kept', () => {
    const out = fitCells('ab漢', 3, U)
    expect(cellWidth(out)).toBeLessThanOrEqual(3)
    expect(out.endsWith('…')).toBe(true)
  })

  test('hostile strings of any width never come out wider or with a control character', () => {
    const alphabet = ['a', 'Z', ' ', '\x1b', '[', '31m', ']', '\x07', '漢', '字', '🐕', '한', '‮', '​', 'e', '́', '\n', '\ud800', '\x9b', '─', '…']
    let seed = 12345
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return seed
    }
    for (let n = 0; n < 200; n++) {
      let text = ''
      const length = next() % 24
      for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length]
      const width = next() % 31
      for (const opts of [U, A]) {
        const out = fitCells(text, width, opts)
        expect(cellWidth(out)).toBeLessThanOrEqual(width)
        expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
        expect(out).not.toMatch(/\p{Cf}/u)
      }
    }
  })

  test('padCells pads to exactly the width', () => {
    expect(padCells('ab', 5)).toBe('ab   ')
    expect(padCells('漢', 4)).toBe('漢  ')
  })

  test('wrapCells breaks at spaces and cuts a word that is longer than the line', () => {
    expect(wrapCells('one two three', 7, U)).toEqual(['one two', 'three'])
    expect(wrapCells('abcdefghijkl', 5, U)).toEqual(['abcde', 'fghij', 'kl'])
    expect(wrapCells('', 5, U)).toEqual([''])
    expect(wrapCells('x', 0, U)).toEqual([])
  })
})
