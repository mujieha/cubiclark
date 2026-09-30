// How many device pixels the office's canvas may have: an office of hundreds of rows at twice the
// density is past what a GPU keeps a canvas in, and every frame then costs many times more.

import { describe, expect, test } from 'vitest'
import { MAX_BACKING_AREA_PX, MAX_BACKING_SIDE_PX, TILE, backingScale } from '../src/core/office/geometry.js'
import { layout, placementOf } from '../src/core/office/layout.js'
import type { Agent, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

describe('backingScale', () => {
  test('an office of ordinary size keeps its full density: scale times the display ratio', () => {
    expect(backingScale(2, 1, 36, 30)).toBe(2)
    expect(backingScale(2, 2, 36, 30)).toBe(4)
    expect(backingScale(1, 3, 36, 44)).toBe(3)
    expect(backingScale(3, 2, 36, 44)).toBe(6)
  })

  test('the rooms world and the baselines are drawn as before: scale 2 at a ratio of 1, up to a hundred rows', () => {
    for (let rows = 20; rows <= 100; rows++) expect(backingScale(2, 1, 36, rows), `${rows} rows`).toBe(2)
  })

  test('a tall office at twice the density is drawn at half of it, not past the limits', () => {
    // 329 rows: the office of the crowd that froze the page. 21056 px tall at 4 device px per px.
    expect(backingScale(2, 2, 36, 329)).toBe(2)
    expect(329 * TILE * 4).toBeGreaterThan(MAX_BACKING_SIDE_PX)
    expect(329 * TILE * 2).toBeLessThanOrEqual(MAX_BACKING_SIDE_PX)
  })

  test('a big scale on a small office is cut by the area, to a divisor: the stretch stays a whole number', () => {
    // 36 x 30 tiles at 8 device px per px is 4608 x 3840 = 17.7 million px, over the area
    expect(backingScale(4, 2, 36, 30)).toBe(4)
    expect(backingScale(3, 2, 36, 200)).toBe(3)
  })

  test('the result is always a divisor of the ideal density and never below 1', () => {
    for (let cssScale = 1; cssScale <= 4; cssScale++) {
      for (let dpr = 1; dpr <= 3; dpr++) {
        for (const rows of [5, 20, 44, 100, 150, 329, 700, 5000]) {
          const ideal = cssScale * dpr
          const scale = backingScale(cssScale, dpr, 36, rows)
          expect(scale, `${cssScale}x, dpr ${dpr}, ${rows} rows`).toBeGreaterThanOrEqual(1)
          expect(ideal % scale, `${cssScale}x, dpr ${dpr}, ${rows} rows: ${scale} divides ${ideal}`).toBe(0)
          if (scale > 1) {
            const width = 36 * TILE * scale
            const height = rows * TILE * scale
            expect(height).toBeLessThanOrEqual(MAX_BACKING_SIDE_PX)
            expect(width * height).toBeLessThanOrEqual(MAX_BACKING_AREA_PX)
          }
        }
      }
    }
  })

  test('a fractional display ratio is rounded as the renderer always did, and nonsense is 1', () => {
    expect(backingScale(2, 1.5, 36, 30)).toBe(4)
    expect(backingScale(2, 0, 36, 30)).toBe(2)
    expect(backingScale(0, 1, 36, 30)).toBe(1)
  })
})

describe('placementOf', () => {
  function agent(id: string, patch: Partial<Agent> = {}): Agent {
    return {
      id,
      kind: 'session',
      project: 'demo',
      cwd: 'demo',
      state: 'thinking',
      stateSince: 't0',
      lastActivity: 't0',
      counters: { prompts: 0, tools: 0, compactions: 0, subagents: 0 },
      openTools: [],
      ...patch,
    }
  }

  test('finds every agent of a layout, and nobody else, as a scan would', () => {
    const agents = Object.fromEntries(
      [
        agent('a'),
        agent('b', { state: 'ended' }),
        agent('c', { kind: 'subagent', parentId: 'a', state: 'searching' }),
        agent('d', { project: 'shop' }),
      ].map((a) => [a.id, a])
    )
    const world: World = { ...emptyWorld('t0', '/r'), agents }
    const office = layout(world)
    expect(office.placements).toHaveLength(4)
    for (const placement of office.placements) expect(placementOf(office, placement.agentId)).toBe(placement)
    expect(placementOf(office, 'nobody')).toBeUndefined()
    // and again, from the index
    expect(placementOf(office, 'c')?.kind).toBe('stool')
    expect(placementOf(office, 'b')?.kind).toBe('board')
  })

  test('an agent named twice is found at its first placement, as a scan would; a copy of the layout has its own index', () => {
    const world: World = { ...emptyWorld('t0', '/r'), agents: { a: agent('a'), b: agent('b') } }
    const office = layout(world)
    const first = office.placements[0]
    const doubled = { ...office, placements: [...office.placements, { ...(first as NonNullable<typeof first>), slot: 99 }] }
    expect(placementOf(doubled, (first as NonNullable<typeof first>).agentId)).toBe(first)
    expect(placementOf(office, 'b')).toBe(office.placements.find((p) => p.agentId === 'b'))
  })
})
