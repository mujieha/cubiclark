// Where each speech bubble goes (phase 5). Pure: a layout and the width of each bubble go in, boxes
// come out. A desk's bubble stays where it always was, in the headroom row of its desk. A helper's
// bubble (icon only) used to sit above its stool, which put it on the cluster's sign row or on the
// head of the helper above; it now tries the right of the stool, then the left, then above, and takes
// the first place that covers no sign, no wall, no other bubble and no neighbouring helper's head.

import { TILE, TOP_WALL_ROWS, scaleRect, type Rect } from './geometry.js'
import type { OfficeLayout, Placement } from './layout.js'

export const BUBBLE_H = 13
/** An icon-only bubble: 4 + 9 + 4. */
export const COMPACT_W = 17
/** The widest a desk's bubble may be: its text is cut to fit the 52 logical px the icon and the padding
 * leave (at the small font's size, src/core/office/text.ts), so the real ones are at most 72. The
 * renderer never draws one wider, which is what lets Morty's map (mascot-map.ts) keep clear of every
 * bubble without knowing the text. */
export const DESK_BUBBLE_MAX_W = 72

export interface BubbleRequest {
  agentId: string
  /** The bubble's width in px: COMPACT_W for a helper, more for a desk bubble that carries text. */
  width: number
}

export interface BubbleBox {
  agentId: string
  rect: Rect
  /** Where the tail touches the bubble's bottom edge, in px. */
  tailX: number
}

const overlap = (a: Rect, b: Rect): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** A desk bubble: inside the desk's headroom row, nudged in from the office's edges. */
function deskRect(p: Placement, width: number, cols: number): Rect {
  const x = Math.max(0, Math.min(cols * TILE - width, p.boxPx.x + 2))
  return { x, y: p.boxPx.y + 1, w: width, h: BUBBLE_H }
}

const clampTail = (rect: Rect, headX: number): number => Math.max(rect.x + 3, Math.min(rect.x + rect.w - 4, headX))

/** The places a helper's bubble may go, best first, each with where its tail points. */
export function helperCandidates(p: Placement, width: number, cols: number): { rect: Rect; tailX: number }[] {
  const box = p.boxPx
  const inside = (x: number): number => Math.max(0, Math.min(cols * TILE - width, x))
  const right: Rect = { x: box.x + box.w + 1, y: box.y + 1, w: width, h: BUBBLE_H }
  const left: Rect = { x: box.x - width - 1, y: box.y + 1, w: width, h: BUBBLE_H }
  const above: Rect = { x: inside(p.seat.x - Math.floor(width / 2)), y: box.y - BUBBLE_H - 2, w: width, h: BUBBLE_H }
  return [
    { rect: right, tailX: right.x + 3 },
    { rect: left, tailX: left.x + left.w - 4 },
    { rect: above, tailX: clampTail(above, p.seat.x) },
  ]
}

/** Where every bubble in `requests` goes. Desk bubbles first (they do not move), then the helpers'
 * in the layout's reading order. Deterministic: the same input gives the same boxes. */
export function placeBubbles(layout: OfficeLayout, requests: readonly BubbleRequest[]): BubbleBox[] {
  const widthOf = new Map(requests.map((request) => [request.agentId, request.width]))
  const cols = layout.cols
  const office: Rect = { x: 0, y: 0, w: cols * TILE, h: layout.rows * TILE }
  const wall: Rect = { x: 0, y: 0, w: cols * TILE, h: TOP_WALL_ROWS * TILE }
  const signs = layout.clusters.map((cluster) => scaleRect(cluster.signRect, TILE))
  const helpers = layout.placements.filter((p) => p.kind !== 'desk')
  // The head of each helper on a stool or the bench: the top half of its tile.
  const heads = new Map(helpers.map((p) => [p.agentId, { x: p.boxPx.x, y: p.boxPx.y, w: p.boxPx.w, h: Math.floor(p.boxPx.h / 2) }]))

  const boxes: BubbleBox[] = []
  const placed: Rect[] = []

  for (const p of layout.placements) {
    const width = widthOf.get(p.agentId)
    if (width === undefined || p.kind !== 'desk') continue
    const rect = deskRect(p, width, cols)
    placed.push(rect)
    boxes.push({ agentId: p.agentId, rect, tailX: clampTail(rect, p.seat.x) })
  }

  for (const p of helpers) {
    const width = widthOf.get(p.agentId)
    if (width === undefined) continue
    const others = [...heads].filter(([id]) => id !== p.agentId).map(([, head]) => head)
    const cost = (rect: Rect): number => {
      // Outside the office is as bad as it gets; covering a sign, the wall, a bubble or a head costs its area.
      const outside = rect.x < office.x || rect.y < office.y || rect.x + rect.w > office.x + office.w || rect.y + rect.h > office.y + office.h
      let total = outside ? 1_000_000 : 0
      for (const obstacle of [wall, ...signs, ...placed, ...others]) total += overlap(rect, obstacle)
      return total
    }
    let best: { rect: Rect; tailX: number } | undefined
    let bestCost = Number.POSITIVE_INFINITY
    for (const candidate of helperCandidates(p, width, cols)) {
      const c = cost(candidate.rect)
      if (c < bestCost) {
        best = candidate
        bestCost = c
        if (c === 0) break
      }
    }
    if (!best) continue
    placed.push(best.rect)
    boxes.push({ agentId: p.agentId, rect: best.rect, tailX: best.tailX })
  }
  return boxes
}
