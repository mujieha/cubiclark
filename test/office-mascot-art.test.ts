// Morty's art and the throw pose: sizes, colours, that each animation really moves, and that the
// throw pose cannot be taken for any state's pose.

import { describe, expect, test } from 'vitest'
import { MORTY_FRAME_NAMES } from '../src/core/office/mascot.js'
import { DAY, NIGHT } from '../src/core/theme/index.js'
import { CHARACTER_FRAMES, PLAY_FRAMES, PLAY_HAND } from '../src/client/office/art/characters.js'
import { MORTY_FRAMES, MORTY_MOUTH, MORTY_PROPS } from '../src/client/office/art/mascot.js'
import { alphaMask, validateSprite } from '../src/client/office/sprite.js'

const dayPalette = { ...DAY.palette, ...DAY.mascot }
const nightPalette = { ...NIGHT.palette, ...NIGHT.mascot }
const pixels = (rows: readonly string[]): string => rows.join('')

describe('Morty\'s frames', () => {
  test('there is a frame for every name, and only those', () => {
    expect(Object.keys(MORTY_FRAMES).sort()).toEqual([...MORTY_FRAME_NAMES].sort())
    expect(MORTY_FRAME_NAMES).toHaveLength(16)
  })

  test('each is 16x12, valid in his palette, and orange', () => {
    for (const [name, def] of Object.entries(MORTY_FRAMES)) {
      expect([def.w, def.h], name).toEqual([16, 12])
      expect(validateSprite(def, name, false, dayPalette), name).toEqual([])
      expect(validateSprite(def, name, false, nightPalette), name).toEqual([])
      expect(pixels(def.rows), `${name} has the coat colour`).toContain('g')
    }
  })

  test('the ordinary office palette alone does not draw him: his three colours are his own', () => {
    expect(validateSprite(MORTY_FRAMES.sit, 'sit', false).length).toBeGreaterThan(0)
  })

  test('every animation moves: its two frames are different pictures', () => {
    for (const [a, b] of [
      ['walk_side_a', 'walk_side_b'],
      ['walk_down_a', 'walk_down_b'],
      ['walk_up_a', 'walk_up_b'],
      ['wag_a', 'wag_b'],
      ['sleep_a', 'sleep_b'],
      ['drink_a', 'drink_b'],
      ['sniff_a', 'sniff_b'],
    ] as const) {
      expect(pixels(MORTY_FRAMES[a].rows), `${a} and ${b}`).not.toBe(pixels(MORTY_FRAMES[b].rows))
    }
  })

  test('the wag is a tail: it differs from sitting still', () => {
    expect(pixels(MORTY_FRAMES.wag_a.rows)).not.toBe(pixels(MORTY_FRAMES.sit.rows))
    expect(pixels(MORTY_FRAMES.wag_b.rows)).not.toBe(pixels(MORTY_FRAMES.sit.rows))
  })

  test('carrying the ball: the ball is in the picture, and nowhere else is paper', () => {
    expect(pixels(MORTY_FRAMES.carry_ball.rows)).toContain('1')
    for (const name of MORTY_FRAME_NAMES) if (name !== 'carry_ball') expect(pixels(MORTY_FRAMES[name].rows), name).not.toContain('1')
  })

  test('the mouth is where the ball is held in the carrying frame', () => {
    const { x, y } = MORTY_MOUTH
    expect(MORTY_FRAMES.carry_ball.rows[y]?.[x]).toBe('1')
  })

  test('a sleeping dog is lower than a standing one: nothing in the top five rows', () => {
    for (const name of ['sleep_a', 'sleep_b'] as const) expect(MORTY_FRAMES[name].rows.slice(0, 5).join('').replace(/\./g, ''), name).toBe('')
  })
})

describe('Morty\'s props', () => {
  test('are small, valid in his palette, and at most 16 px wide', () => {
    for (const [name, def] of Object.entries(MORTY_PROPS)) {
      expect(def.w, name).toBeLessThanOrEqual(16)
      expect(validateSprite(def, name, false, dayPalette), name).toEqual([])
    }
    expect(MORTY_PROPS.basket).toMatchObject({ w: 16, h: 8 })
    expect(MORTY_PROPS.bowl).toMatchObject({ w: 10, h: 5 })
    expect(MORTY_PROPS.ball).toMatchObject({ w: 4, h: 4 })
  })
})

describe('the throw pose', () => {
  test('both frames are 16x24, valid with placeholders, and carry the anchors accessories hang on', () => {
    for (const [name, def] of Object.entries(PLAY_FRAMES)) {
      expect([def.w, def.h], name).toEqual([16, 24])
      expect(validateSprite(def, name), name).toEqual([])
      expect(def.anchors, name).toBeDefined()
    }
  })

  test('the ball is in the first frame and gone from the second', () => {
    expect(pixels(PLAY_FRAMES.throw_a.rows)).toContain('1')
    expect(pixels(PLAY_FRAMES.throw_b.rows)).not.toContain('1')
    expect(alphaMask(PLAY_FRAMES.throw_a)).not.toBe(alphaMask(PLAY_FRAMES.throw_b))
  })

  test('the hand is a hand (skin) in both frames', () => {
    for (const [name, def] of Object.entries(PLAY_FRAMES)) expect(def.rows[PLAY_HAND.y]?.[PLAY_HAND.x], name).toBe('K')
  })

  test('its silhouette is none of the poses it must never be taken for', () => {
    for (const other of ['stand_wave_a', 'stand_wave_b', 'walk_side_a', 'walk_side_b', 'sit_type_a', 'sit_lean_back', 'stand']) {
      const mask = alphaMask(CHARACTER_FRAMES[other] as never)
      for (const [name, def] of Object.entries(PLAY_FRAMES)) expect(alphaMask(def), `${name} vs ${other}`).not.toBe(mask)
    }
  })

  test('the arm is out to the side, not up: nothing rises above the shoulders on the arm side', () => {
    // The waving pose has its hand above the head (rows 0-2); the throw pose has nothing there beyond the head.
    for (const [name, def] of Object.entries(PLAY_FRAMES)) {
      for (const y of [0, 1, 2, 3, 4, 5]) expect(def.rows[y]?.slice(13), `${name} row ${y}`).toBe('...')
    }
  })

  test('it is not in the catalogue of frames a pack may replace', () => {
    expect(Object.keys(CHARACTER_FRAMES)).not.toContain('throw_a')
    expect(Object.keys(CHARACTER_FRAMES)).not.toContain('throw_b')
  })
})
