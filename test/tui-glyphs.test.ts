// The terminal's glyphs and words: every state tells itself apart without colour.

import { describe, expect, test } from 'vitest'
import { STATE_VISUALS } from '../src/core/office/visual.js'
import { cellWidth } from '../src/core/tui/cells.js'
import { BOX, FAMILY_LETTERS, FAMILY_TYPING, MORTY_WORDS, STATE_GLYPHS, TYPING_STATES, agentToken, mortyGlyph } from '../src/core/tui/glyphs.js'
import { AGENT_STATES } from '../src/core/types.js'
import { STATE_LABELS } from '../src/core/view.js'

const SEPARATORS = [' ', '(', ')', '>', ':', '|', 'd']

describe('state glyphs', () => {
  test('there is one for each of the 16 states, pairwise distinct', () => {
    expect(AGENT_STATES).toHaveLength(16)
    expect(Object.keys(STATE_GLYPHS).sort()).toEqual([...AGENT_STATES].sort())
    expect(new Set(AGENT_STATES.map((state) => STATE_GLYPHS[state])).size).toBe(16)
  })

  test('each is one printable ASCII character that is not a separator or a lower-case family letter', () => {
    const letters = Object.values(FAMILY_LETTERS)
    for (const state of AGENT_STATES) {
      const glyph = STATE_GLYPHS[state]
      expect(glyph).toMatch(/^[!-~]$/)
      expect(SEPARATORS).not.toContain(glyph)
      expect(letters).not.toContain(glyph)
    }
  })

  test('each has its own word, the page\'s', () => {
    expect(new Set(AGENT_STATES.map((state) => STATE_LABELS[state])).size).toBe(16)
  })
})

describe('family letters', () => {
  test('ten distinct characters across the two cases', () => {
    expect(new Set([...Object.values(FAMILY_LETTERS), ...Object.values(FAMILY_TYPING)]).size).toBe(10)
  })
})

describe('typing', () => {
  test('exactly the states whose pose on the page is a typing pose', () => {
    const typing = AGENT_STATES.filter((state) => ['type_slow', 'type_fast', 'type'].includes(STATE_VISUALS[state].pose))
    expect([...TYPING_STATES].sort()).toEqual([...typing].sort())
    expect([...TYPING_STATES].sort()).toEqual(['editing', 'running', 'thinking'])
  })

  test('the token flips its letter on the typing frame only for those states', () => {
    expect(agentToken('editing', 'opus', false)).toBe('Eo')
    expect(agentToken('editing', 'opus', true)).toBe('EO')
    expect(agentToken('reading', 'opus', true)).toBe('Ro')
    expect(agentToken('thinking', 'other', true)).toBe('?*')
    for (const state of AGENT_STATES) expect(cellWidth(agentToken(state, 'sonnet', true))).toBe(2)
  })
})

describe('Morty', () => {
  test('a word for each of his seven activities, all different', () => {
    expect(Object.keys(MORTY_WORDS).sort()).toEqual(['drink', 'greet', 'nap', 'play', 'sit_by', 'sniff', 'wander'])
    expect(new Set(Object.values(MORTY_WORDS)).size).toBe(7)
  })

  test('a dog emoji of two cells, or a d', () => {
    expect(mortyGlyph(true)).toBe('\u{1F415}')
    expect(cellWidth(mortyGlyph(true))).toBe(2)
    expect(mortyGlyph(false)).toBe('d')
  })
})

describe('box characters', () => {
  test('the ASCII set is printable ASCII', () => {
    for (const char of Object.values(BOX.ascii)) expect(char).toMatch(/^[ -~]$/)
  })
})
