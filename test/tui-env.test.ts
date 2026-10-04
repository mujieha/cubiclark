// What the environment and the terminal decide for `cubiclark tui`.

import { describe, expect, test } from 'vitest'
import { drawDelay } from '../src/core/tui/gate.js'
import { animationOn, colorOn, frameSize, parseSize, tuiMode, unicodeOn } from '../src/tui/env.js'

describe('colorOn', () => {
  test('a terminal gets colour, a pipe does not', () => {
    expect(colorOn(true, {}, true)).toBe(true)
    expect(colorOn(true, {}, false)).toBe(false)
  })

  test('FORCE_COLOR turns it on for a pipe, FORCE_COLOR=0 off for a terminal', () => {
    expect(colorOn(true, { FORCE_COLOR: '1' }, false)).toBe(true)
    expect(colorOn(true, { FORCE_COLOR: '0' }, true)).toBe(false)
  })

  test('NO_COLOR beats FORCE_COLOR and a terminal, but an empty one is ignored', () => {
    expect(colorOn(true, { NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false)
    expect(colorOn(true, { NO_COLOR: '1' }, true)).toBe(false)
    expect(colorOn(true, { NO_COLOR: '' }, true)).toBe(true)
  })

  test('--no-color beats everything', () => {
    expect(colorOn(false, { FORCE_COLOR: '1' }, true)).toBe(false)
  })
})

describe('unicodeOn', () => {
  test('UTF-8 locales, the first variable that is set deciding', () => {
    expect(unicodeOn(false, { LANG: 'en_US.UTF-8' })).toBe(true)
    expect(unicodeOn(false, { LANG: 'en_US.utf8' })).toBe(true)
    expect(unicodeOn(false, { LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe(false)
    expect(unicodeOn(false, { LC_ALL: '', LANG: 'en_US.UTF-8' })).toBe(true)
    expect(unicodeOn(false, { LC_CTYPE: 'de_DE.UTF-8' })).toBe(true)
    expect(unicodeOn(false, {})).toBe(false)
  })

  test('--ascii turns it off', () => {
    expect(unicodeOn(true, { LANG: 'en_US.UTF-8' })).toBe(false)
  })
})

describe('animationOn', () => {
  test('on unless asked off', () => {
    expect(animationOn(true, {})).toBe(true)
    expect(animationOn(false, {})).toBe(false)
  })

  test('CUBICLARK_REDUCED_MOTION and a dumb terminal stop it', () => {
    expect(animationOn(true, { CUBICLARK_REDUCED_MOTION: '1' })).toBe(false)
    expect(animationOn(true, { CUBICLARK_REDUCED_MOTION: '0' })).toBe(true)
    expect(animationOn(true, { CUBICLARK_REDUCED_MOTION: '' })).toBe(true)
    expect(animationOn(true, { TERM: 'dumb' })).toBe(false)
    expect(animationOn(true, { TERM: 'xterm-256color' })).toBe(true)
  })
})

describe('tuiMode', () => {
  test('--once and --frames print', () => {
    expect(tuiMode({ once: true }, true, true)).toEqual({ kind: 'print', frames: 1 })
    expect(tuiMode({ once: false, frames: 3 }, true, true)).toEqual({ kind: 'print', frames: 3 })
  })

  test('a terminal on both ends is interactive, anything else prints one frame', () => {
    expect(tuiMode({ once: false }, true, true)).toEqual({ kind: 'interactive' })
    expect(tuiMode({ once: false }, true, false)).toEqual({ kind: 'print', frames: 1 })
    expect(tuiMode({ once: false }, false, true)).toEqual({ kind: 'print', frames: 1 })
  })
})

describe('parseSize and frameSize', () => {
  test('parseSize', () => {
    expect(parseSize('120x40')).toEqual({ cols: 120, rows: 40 })
    for (const bad of ['0x5', '1001x5', '80x501', '80X24', '80x', 'x24', '80x24x1', '', '-1x5']) expect(parseSize(bad), bad).toBeUndefined()
  })

  test('the flag wins; a terminal is its own size; a pipe is 80x24', () => {
    const tty = { isTTY: true, columns: 100, rows: 30 }
    expect(frameSize({ cols: 10, rows: 10 }, tty, 'interactive')).toEqual({ cols: 10, rows: 10 })
    expect(frameSize(undefined, tty, 'interactive')).toEqual({ cols: 100, rows: 30 })
    expect(frameSize(undefined, tty, 'print')).toEqual({ cols: 100, rows: 29 })
    expect(frameSize(undefined, {}, 'print')).toEqual({ cols: 80, rows: 24 })
    expect(frameSize(undefined, { isTTY: false, columns: 100, rows: 30 }, 'print')).toEqual({ cols: 80, rows: 24 })
  })
})

describe('drawDelay', () => {
  test('waits out the rest of the interval', () => {
    expect(drawDelay(undefined, 1000)).toBe(0)
    expect(drawDelay(1000, 1030)).toBe(70)
    expect(drawDelay(1000, 1150)).toBe(0)
    expect(drawDelay(1000, 1030, 50)).toBe(20)
  })
})
