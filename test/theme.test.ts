// The themes as data, the rules every palette must pass, and the choice logic.

import { describe, expect, test } from 'vitest'
import {
  DAY,
  MASCOT_KEYS,
  NIGHT,
  PALETTE_KEYS,
  THEMES,
  contrastRatio,
  mascotProblems,
  mergePalette,
  nextThemeChoice,
  pageProblems,
  paletteProblems,
  parseThemeChoice,
  resolveThemeId,
  rgbDistance,
} from '../src/core/theme/index.js'
import { PALETTE, toneFor } from '../src/client/office/palette.js'

/** The palette the office was drawn in before themes existed: day must stay exactly this. */
const ORIGINAL_PALETTE = {
  '0': '#16161d',
  '1': '#f2efe6',
  '2': '#a8b0b8',
  '3': '#5b6470',
  '4': '#2b3140',
  '5': '#3e4a5e',
  '6': '#8c5a3a',
  '7': '#c9955f',
  '8': '#f0c9a0',
  '9': '#9a6444',
  a: '#d8483f',
  b: '#f0a830',
  c: '#4caf6e',
  d: '#3d7fd9',
  e: '#8a5cc7',
  f: '#e87fa8',
}

describe('the built-in themes', () => {
  test('day is the palette the office has always been drawn in, so choosing it changes no pixel', () => {
    expect(DAY.palette).toEqual(ORIGINAL_PALETTE)
    expect(PALETTE).toEqual(ORIGINAL_PALETTE)
  })

  test('both have exactly the sixteen keys, and their own ids', () => {
    for (const theme of [DAY, NIGHT]) expect(Object.keys(theme.palette).sort(), theme.id).toEqual([...PALETTE_KEYS].sort())
    expect(THEMES.day).toBe(DAY)
    expect(THEMES.night).toBe(NIGHT)
    expect([DAY.colorScheme, NIGHT.colorScheme]).toEqual(['light', 'dark'])
  })

  test('both pass the palette rules and the page rules', () => {
    for (const theme of [DAY, NIGHT]) {
      expect(paletteProblems(theme.palette), theme.id).toEqual([])
      expect(pageProblems(theme.page), theme.id).toEqual([])
    }
  })

  test('night differs from day where it should (walls, wood) and keeps its lamps', () => {
    expect(NIGHT.palette['4']).not.toBe(DAY.palette['4'])
    expect(NIGHT.palette['7']).not.toBe(DAY.palette['7'])
    expect(NIGHT.palette.a).toBe(DAY.palette.a)
  })
})

describe('colour arithmetic', () => {
  test('contrast: black on white is 21, symmetric, and equal colours are 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBe(1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })

  test('distance: zero for equal colours, the cube diagonal for black and white', () => {
    expect(rgbDistance('#123456', '#123456')).toBe(0)
    expect(rgbDistance('#000000', '#ffffff')).toBeCloseTo(441.67, 1)
  })
})

describe('paletteProblems', () => {
  const withKeys = (override: Record<string, string>): Record<string, string> => ({ ...DAY.palette, ...override })

  test('a palette whose amber lamp equals its red one is refused, naming both keys', () => {
    const problems = paletteProblems(withKeys({ b: DAY.palette.a as string }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/keys a and b are too close/)
    expect(problems[0]).toMatch(/lamps/)
  })

  test('ink equal to paper is refused: bubble text', () => {
    const problems = paletteProblems(withKeys({ '0': DAY.palette['1'] as string }))
    expect(problems.some((p) => p.startsWith('keys 0 and 1 have contrast 1.0'))).toBe(true)
  })

  test('paper on red too faint is refused: the alert bubble', () => {
    expect(paletteProblems(withKeys({ a: '#f0e8e0' })).some((p) => p.startsWith('keys 1 and a'))).toBe(true)
  })

  test('two models in the same shirt are refused', () => {
    expect(paletteProblems(withKeys({ e: DAY.palette.d as string })).some((p) => /keys d and e are too close/.test(p))).toBe(true)
  })

  test('a missing key, a short colour, a non-string-looking colour and an unknown key are problems, not throws', () => {
    const missing: Record<string, string> = { ...DAY.palette }
    delete missing.c
    expect(paletteProblems(missing)).toEqual(['key c is missing'])
    expect(paletteProblems(withKeys({ a: '#abc' }))).toEqual(['key a is "#abc", not a #rrggbb colour'])
    expect(paletteProblems(withKeys({ zz: '#000000' }))).toEqual(['unknown palette keys: zz'])
    expect(paletteProblems(withKeys({ a: 'red\u001b[31m' }))[0]).not.toContain('\u001b')
  })
})

describe('Morty\'s colours', () => {
  test('both themes have exactly the three mascot keys, none of them a palette key', () => {
    for (const theme of [DAY, NIGHT]) expect(Object.keys(theme.mascot).sort(), theme.id).toEqual([...MASCOT_KEYS].sort())
    for (const key of MASCOT_KEYS) expect(PALETTE_KEYS as readonly string[]).not.toContain(key)
    expect(PALETTE_KEYS).toHaveLength(16)
  })

  test('both themes pass the mascot rule', () => {
    for (const theme of [DAY, NIGHT]) expect(mascotProblems(theme.mascot, theme.palette), theme.id).toEqual([])
  })

  test('a coat as amber as the amber lamp is refused, naming the coat and the lamp', () => {
    const problems = mascotProblems({ ...DAY.mascot, g: DAY.palette.b as string }, DAY.palette)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/coat \(g\).*amber lamp \(b\)/)
  })

  test('a coat as red as the red lamp is refused', () => {
    const problems = mascotProblems({ ...DAY.mascot, g: DAY.palette.a as string }, DAY.palette)
    expect(problems.some((p) => /red lamp \(a\)/.test(p))).toBe(true)
  })

  test('a missing key, a short colour and an unknown key are problems, not throws', () => {
    const missing: Record<string, string> = { ...DAY.mascot }
    delete missing.h
    expect(mascotProblems(missing, DAY.palette)).toEqual(['mascot key h is missing'])
    expect(mascotProblems({ ...DAY.mascot, i: '#fff' }, DAY.palette)).toEqual(['mascot key i is "#fff", not a #rrggbb colour'])
    expect(mascotProblems({ ...DAY.mascot, zz: '#000000' }, DAY.palette)).toEqual(['unknown mascot keys: zz'])
  })
})

describe('pageProblems', () => {
  test('a text colour too faint on the background is named with its ratio', () => {
    const problems = pageProblems({ ...DAY.page, dim: '#c8c8c8' })
    expect(problems.some((p) => /^dim on bg has contrast \d\.\d, need 4\.5$/.test(p))).toBe(true)
  })

  test('a colour that is not #rrggbb is a problem', () => {
    expect(pageProblems({ ...DAY.page, fg: 'black' })).toEqual(['fg is "black", not a #rrggbb colour'])
  })
})

describe('the choice', () => {
  test('auto follows the operating system, a chosen theme does not', () => {
    expect(resolveThemeId('auto', true)).toBe('night')
    expect(resolveThemeId('auto', false)).toBe('day')
    expect(resolveThemeId('day', true)).toBe('day')
    expect(resolveThemeId('night', false)).toBe('night')
  })

  test('the toggle cycles auto, day, night, auto', () => {
    expect(nextThemeChoice('auto')).toBe('day')
    expect(nextThemeChoice('day')).toBe('night')
    expect(nextThemeChoice('night')).toBe('auto')
  })

  test('anything but the three choices is auto', () => {
    for (const raw of ['x', '', null, undefined, 3, {}, 'DAY', '__proto__']) expect(parseThemeChoice(raw), String(raw)).toBe('auto')
    expect(parseThemeChoice('night')).toBe('night')
  })

  test('mergePalette overrides only the keys it is given and leaves the base alone', () => {
    const merged = mergePalette(DAY.palette, { '7': '#112233' })
    expect(merged['7']).toBe('#112233')
    expect(merged['6']).toBe(DAY.palette['6'])
    expect(DAY.palette['7']).toBe('#c9955f')
    expect(mergePalette(DAY.palette, undefined)).toBe(DAY.palette)
  })
})

describe('toneFor keeps its behaviour, and tones towards the palette it is given', () => {
  test('normal is the colour itself; dim and dark land on the palette greys', () => {
    expect(toneFor('#c9955f', 'normal')).toBe('#c9955f')
    expect(toneFor('#3d7fd9', 'dim')).toBe(DAY.palette['3']) // mid brightness
    expect(toneFor('#16161d', 'dim')).toBe(DAY.palette['4']) // very dark
    expect(toneFor('#f2efe6', 'dim')).toBe(DAY.palette['2']) // light
    expect(toneFor('#f2efe6', 'dark')).toBe(DAY.palette['5'])
    expect(toneFor('#f2efe6', 'dim', NIGHT.palette)).toBe(NIGHT.palette['2'])
    expect(toneFor('#16161d', 'dark', NIGHT.palette)).toBe(NIGHT.palette['0'])
  })
})
