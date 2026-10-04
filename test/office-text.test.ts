// The words on the office (cubiclark-readable): how big, in which font, cut where, on which plate and
// in which colours. All pure; the renderer only measures and draws.

import { describe, expect, test } from 'vitest'
import { TILE } from '../src/core/office/geometry.js'
import { layout } from '../src/core/office/layout.js'
import {
  BUBBLE_STYLES,
  CANVAS_TEXT_PAIRS,
  SIGN_MAX_PX,
  SIGN_MIN_PX,
  SMALL_MAX_PX,
  SMALL_MIN_PX,
  fitText,
  fontFor,
  labelBoxes,
  textMetrics,
} from '../src/core/office/text.js'
import type { Agent, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

/** A fixed-width font: every character is 0.6 of the size wide. */
const mono = (text: string, px = 10): number => [...text].length * px * 0.6

function agent(id: string, project: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    kind: 'session',
    project,
    cwd: project,
    state: 'thinking',
    stateSince: 't0',
    lastActivity: 't0',
    counters: { prompts: 0, tools: 0, compactions: 0, subagents: 0 },
    openTools: [],
    ...patch,
  }
}

function worldOf(...agents: Agent[]): World {
  return { ...emptyWorld('t0', '/r'), agents: Object.fromEntries(agents.map((a) => [a.id, a])) }
}

describe('textMetrics', () => {
  test('never below 12 px for names and signs, nor 10 px for bubble text, however small the office', () => {
    for (const scale of [0.5, 1, 1.125, 1.4375, 1.75]) {
      const { signPx, smallPx } = textMetrics(scale)
      expect(signPx, `scale ${scale}`).toBeGreaterThanOrEqual(SIGN_MIN_PX)
      expect(smallPx, `scale ${scale}`).toBeGreaterThanOrEqual(SMALL_MIN_PX)
    }
    expect(SIGN_MIN_PX).toBe(12)
    expect(SMALL_MIN_PX).toBe(10)
  })

  test('grows with the office, to a limit', () => {
    expect(textMetrics(1.4375)).toEqual({ signPx: 12, smallPx: 10 })
    expect(textMetrics(1.75)).toEqual({ signPx: 12, smallPx: 11 })
    expect(textMetrics(2)).toEqual({ signPx: 14, smallPx: 12 })
    expect(textMetrics(2.5625)).toEqual({ signPx: 18, smallPx: 15 })
    expect(textMetrics(3.5)).toEqual({ signPx: 20, smallPx: 16 })
    expect(textMetrics(10)).toEqual({ signPx: SIGN_MAX_PX, smallPx: SMALL_MAX_PX })
  })

  test('nonsense is the size at scale 1', () => {
    expect(textMetrics(Number.NaN)).toEqual(textMetrics(1))
    expect(textMetrics(0)).toEqual(textMetrics(1))
    expect(textMetrics(-2)).toEqual(textMetrics(1))
  })
})

describe('fontFor', () => {
  test('is the size in CSS px in the system monospace stack, bold when asked', () => {
    expect(fontFor(12, true)).toBe("bold 12px ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace")
    expect(fontFor(10)).toBe("10px ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace")
    expect(fontFor(10)).not.toContain('bold')
  })
})

describe('fitText', () => {
  const measure = (text: string): number => mono(text, 10)

  test('text that fits is unchanged', () => {
    expect(fitText('abc', 18, measure)).toBe('abc')
    expect(fitText('abc', 100, measure)).toBe('abc')
  })

  test('text that does not fit is cut to the longest start that fits with an ellipsis', () => {
    // 6 px a character: 36 px holds six characters, so five and the ellipsis
    expect(fitText('abcdefghijklmnop', 36, measure)).toBe('abcde…')
  })

  test('is not given a second ellipsis when it already has one', () => {
    expect(fitText('abcdefghijk…', 36, measure)).toBe('abcde…')
    expect(fitText('abcdefghijk…', 36, measure).match(/…/g)).toHaveLength(1)
  })

  test('nothing fits a width that is not positive', () => {
    expect(fitText('abc', 0, measure)).toBe('')
    expect(fitText('abc', -4, measure)).toBe('')
    expect(fitText('abc', Number.NaN, measure)).toBe('')
    expect(fitText('', 100, measure)).toBe('')
  })

  test('a width that holds only the ellipsis gives the ellipsis, and less gives nothing', () => {
    expect(fitText('abcdef', 6, measure)).toBe('…')
    expect(fitText('abcdef', 5, measure)).toBe('')
  })

  test('never splits a character that is two code units long', () => {
    const cut = fitText('🦊🦊🦊🦊', 18, measure)
    expect(cut).toBe('🦊🦊…')
    for (const char of [...cut]) expect(char === '…' || char === '🦊').toBe(true)
  })
})

describe('labelBoxes', () => {
  const longName = 'a'.repeat(60)
  const world = worldOf(agent('a', 'shop'), agent('b', longName), agent('c', 'api'))
  const office = layout(world)
  const measure = (text: string, px: number): number => mono(text, px)

  test('the three room names are whole, on the second row of the wall, one per top room', () => {
    const rooms = labelBoxes(office, 1.75, measure).filter((label) => label.kind === 'room')
    expect(rooms.map((label) => label.text)).toEqual(["Manager's office", 'Planning room', 'Review corner'])
    for (const label of rooms) {
      expect(label.region.y).toBe(2 * TILE * 1.75)
      expect(label.region.h).toBe(12 * 1.75)
    }
  })

  test('there is a sign for every cluster, and a project too long for it is cut at the smallest scale', () => {
    const projects = labelBoxes(office, 1, measure).filter((label) => label.kind === 'project')
    expect(projects).toHaveLength(office.clusters.length)
    const long = projects.find((label) => label.text.endsWith('…'))
    expect(long, 'the 60-character project is cut').toBeDefined()
    const pad = Math.max(3, Math.round(12 / 3))
    expect(mono((long as { text: string }).text, 12)).toBeLessThanOrEqual((long as { region: { w: number } }).region.w - 2 * pad)
  })

  test.each([1, 1.4375, 2, 3.5])('at scale %f every plate lies in its band and every label is as tall as its size', (scale) => {
    const { signPx } = textMetrics(scale)
    const labels = labelBoxes(office, scale, measure)
    expect(labels.length).toBeGreaterThan(3)
    for (const label of labels) {
      const name = `${label.kind} "${label.text}"`
      expect(label.px, name).toBe(signPx)
      expect(label.plate.x, name).toBeGreaterThanOrEqual(Math.floor(label.region.x))
      expect(label.plate.x + label.plate.w, name).toBeLessThanOrEqual(Math.ceil(label.region.x + label.region.w))
      expect(label.plate.h, name).toBeGreaterThanOrEqual(signPx + 4)
      expect(label.x, name).toBeGreaterThan(label.plate.x)
      expect(label.y, name).toBe(label.plate.y + label.plate.h / 2)
    }
  })

  test('the same input gives the same boxes', () => {
    expect(labelBoxes(office, 1.75, measure)).toEqual(labelBoxes(office, 1.75, measure))
  })
})

describe('the pairs a word is drawn in', () => {
  test('room names, project signs, the whiteboard label, bubble text and a quiet agent\'s bubble text are all listed', () => {
    const names = CANVAS_TEXT_PAIRS.map((pair) => pair.name)
    expect(names).toEqual(['room names', 'project signs', 'the whiteboard label', 'bubble text', "a quiet agent's bubble text"])
    for (const pair of CANVAS_TEXT_PAIRS) expect(pair.ink, pair.name).not.toBe(pair.plate)
  })

  test('muted bubbles are dark on the grey, not grey on grey', () => {
    expect(BUBBLE_STYLES.muted.text).toBe('0')
    expect(BUBBLE_STYLES.plain.text).toBe('0')
  })
})
