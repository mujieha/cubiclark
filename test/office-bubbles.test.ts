// Where the bubbles go: desk bubbles stay exactly where they were, and helper bubbles no longer land
// on a cluster's sign or on the head of the helper beside them, in the two crowded fixture worlds.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { BUBBLE_H, COMPACT_W, placeBubbles, type BubbleBox, type BubbleRequest } from '../src/core/office/bubbles.js'
import { TILE, TOP_WALL_ROWS, scaleRect, type Rect } from '../src/core/office/geometry.js'
import { layout as computeLayout, type OfficeLayout } from '../src/core/office/layout.js'
import { resolveBubble } from '../src/core/office/visual.js'
import type { World } from '../src/core/types.js'

function world(name: string): World {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/worlds/${name}.json`, import.meta.url)), 'utf8')) as World
}

/** The bubbles a world wants: every seated agent whose state has one. A desk's carries text, so it is wider. */
function requestsFor(w: World, l: OfficeLayout): BubbleRequest[] {
  const out: BubbleRequest[] = []
  for (const p of l.placements) {
    const agent = w.agents[p.agentId]
    if (!agent || p.kind === 'board') continue
    const bubble = resolveBubble(agent, w, l, false)
    if (!bubble) continue
    const text = p.kind === 'desk' ? bubble.text : undefined
    out.push({ agentId: p.agentId, width: 4 + 9 + (text ? 3 + Math.ceil(text.length * 3.6) : 0) + 4 })
  }
  return out
}

const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Today's placement, as the renderer computed it before phase 5. */
function oldRect(l: OfficeLayout, agentId: string, width: number): Rect {
  const p = l.placements.find((placement) => placement.agentId === agentId) as OfficeLayout['placements'][number]
  const left = p.kind === 'desk' ? p.boxPx.x + 2 : p.seat.x - Math.floor(width / 2)
  return {
    x: clamp(left, 0, l.cols * TILE - width),
    y: p.kind === 'desk' ? p.boxPx.y + 1 : p.boxPx.y - BUBBLE_H - 2,
    w: width,
    h: BUBBLE_H,
  }
}

function pairs(rects: Rect[]): number {
  let count = 0
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i] as Rect, rects[j] as Rect)) count++
  return count
}

for (const name of ['crowd-50', 'crowd-100', 'rooms', 'all-states']) {
  describe(`bubbles in ${name}`, () => {
    const w = world(name)
    const l = computeLayout(w)
    const requests = requestsFor(w, l)
    const boxes = placeBubbles(l, requests)
    const byId = new Map(boxes.map((box) => [box.agentId, box]))
    const kindOf = (id: string): string => (l.placements.find((p) => p.agentId === id) as { kind: string }).kind
    const helperBoxes = boxes.filter((box) => kindOf(box.agentId) !== 'desk')
    const signs = l.clusters.map((cluster) => scaleRect(cluster.signRect, TILE))
    const wall: Rect = { x: 0, y: 0, w: l.cols * TILE, h: TOP_WALL_ROWS * TILE }

    test('every requested bubble gets exactly one box of the requested width, inside the office', () => {
      expect(boxes).toHaveLength(requests.length)
      for (const request of requests) {
        const box = byId.get(request.agentId) as BubbleBox
        expect(box.rect.w).toBe(request.width)
        expect(box.rect.h).toBe(BUBBLE_H)
        expect(box.rect.x).toBeGreaterThanOrEqual(0)
        expect(box.rect.x + box.rect.w).toBeLessThanOrEqual(l.cols * TILE)
        expect(box.rect.y).toBeGreaterThanOrEqual(0)
      }
    })

    test('desk bubbles are exactly where they always were, tail included', () => {
      for (const request of requests) {
        if (kindOf(request.agentId) !== 'desk') continue
        const box = byId.get(request.agentId) as BubbleBox
        expect(box.rect).toEqual(oldRect(l, request.agentId, request.width))
        const p = l.placements.find((placement) => placement.agentId === request.agentId)
        expect(box.tailX).toBe(clamp(p?.seat.x ?? 0, box.rect.x + 3, box.rect.x + box.rect.w - 4))
      }
    })

    test('no helper bubble covers a cluster sign or the wall, and none covers another helper\'s head', () => {
      for (const box of helperBoxes) {
        for (const sign of signs) expect(overlap(box.rect, sign), `${box.agentId} on a sign`).toBe(false)
        expect(overlap(box.rect, wall), `${box.agentId} on the wall`).toBe(false)
        for (const p of l.placements) {
          if (p.kind === 'desk' || p.kind === 'board' || p.agentId === box.agentId) continue
          const head: Rect = { x: p.boxPx.x, y: p.boxPx.y, w: p.boxPx.w, h: Math.floor(p.boxPx.h / 2) }
          expect(overlap(box.rect, head), `${box.agentId} on the head of ${p.agentId}`).toBe(false)
        }
      }
    })

    test('no two helper bubbles overlap', () => {
      expect(pairs(helperBoxes.map((box) => box.rect))).toBe(0)
    })

    test('what a person would call a crowded bubble (on a sign, the wall, another bubble or a helper\'s head) is rarer than before', () => {
      const crowded = (rects: { id: string; rect: Rect }[]): number => {
        let count = pairs(rects.map((r) => r.rect))
        for (const { id, rect } of rects) {
          if (kindOf(id) === 'desk') continue
          if (signs.some((sign) => overlap(rect, sign)) || overlap(rect, wall)) count++
          for (const p of l.placements) {
            if (p.kind === 'desk' || p.kind === 'board' || p.agentId === id) continue
            if (overlap(rect, { x: p.boxPx.x, y: p.boxPx.y, w: p.boxPx.w, h: Math.floor(p.boxPx.h / 2) })) count++
          }
        }
        return count
      }
      const now = crowded(boxes.map((box) => ({ id: box.agentId, rect: box.rect })))
      const before = crowded(requests.map((request) => ({ id: request.agentId, rect: oldRect(l, request.agentId, request.width) })))
      if (before > 0) expect(now).toBeLessThan(before)
      expect(now).toBeLessThanOrEqual(before)
    })

    test('the same input gives the same boxes', () => {
      expect(placeBubbles(l, requests)).toEqual(boxes)
    })
  })
}

describe('placeBubbles on small inputs', () => {
  test('no requests, no boxes; an agent with no request has no box', () => {
    const l = computeLayout(world('rooms'))
    expect(placeBubbles(l, [])).toEqual([])
    const one = l.placements[0]?.agentId as string
    expect(placeBubbles(l, [{ agentId: one, width: COMPACT_W }]).map((box) => box.agentId)).toEqual([one])
  })
})
