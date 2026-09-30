// Where Morty, the office corgi, may be (cubiclark-morty §2.3). Pure: a World, its layout and its
// tile map go in; a grid of tiles he may stand on, his fixed spots and a deterministic path finder
// come out.
//
// Morty's frames are 16x12 and he is drawn with his feet on the bottom edge of a tile, so when he
// stands on a tile his picture lies inside it, and when he walks between two neighbouring tiles it
// lies inside the two. The grid takes out every tile that touches a lamp, a monitor, a board tag or a
// place a speech bubble is (or could be) drawn. So "Morty never covers a bubble, a lamp, a monitor or
// a board tag" is a test over rectangles, not a hope.

import { FLOOR_X, OFFICE_COLS, TILE, TOP_ROOMS, TOP_WALL_ROWS, WALL_X, type Point, type Rect } from './geometry.js'
import { BUBBLE_H, COMPACT_W, DESK_BUBBLE_MAX_W, helperCandidates } from './bubbles.js'
import type { OfficeLayout } from './layout.js'
import type { RoomId } from './roles.js'
import { deskPropRects, type TileId, type TileMap } from './tilemap.js'
import { STATE_VISUALS } from './visual.js'
import type { World } from '../types.js'

export interface Tile {
  x: number
  y: number
}

export interface MascotSpots {
  /** His bed, at the right end of the lobby's free row. A destination only: nobody walks across it. */
  basket: Tile
  /** His water bowl, in the top-left corner of the project floor. A destination only, too. */
  bowl: Tile
  /** Where he stands to drink: the tile under the bowl. */
  drink: Tile
  /** Where he greets arrivals: the tile beside the door. */
  door: Tile
  /** Where he sniffs the whiteboard: the tile under it. */
  whiteboard: Tile
}

export interface MascotGrid {
  cols: number
  rows: number
  /** 1 where Morty may stand now: the free floor minus every tile touching a lamp, a monitor, a tag
   * or a place a bubble is (or may be) drawn. */
  walkable: Uint8Array
  /** The same without the bubble places: where he goes when bubbles close every way, walking under
   * them (they are drawn over him). */
  staticWalkable: Uint8Array
  spots: MascotSpots
  /** Changes whenever the grid or his spots change: a replan is due when it does. */
  key: string
}

/** The floors of the rooms and the hallway; everything else (walls, signs, the board, doors) is not his. */
const BASE_WALKABLE: ReadonlySet<TileId> = new Set<TileId>([
  'hall',
  'partition',
  'floor_wood',
  'floor_carpet_manager',
  'floor_carpet_planning',
  'floor_tile_review',
  'floor_lobby',
])

/** FNV-1a over bytes, continuing from `seed`. */
export function fnv1aBytes(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let hash = seed
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** FNV-1a over the UTF-16 code units of a text. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export const tileRect = (t: Tile): Rect => ({ x: t.x * TILE, y: t.y * TILE, w: TILE, h: TILE })
export const tileCentre = (t: Tile): Point => ({ x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 })
export const tileOf = (p: Point): Tile => ({ x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) })

function roomRect(layout: OfficeLayout, id: RoomId): Rect {
  return (layout.rooms.find((room) => room.id === id) as { rect: Rect }).rect
}

export function mascotSpots(layout: OfficeLayout): MascotSpots {
  const lobby = roomRect(layout, 'lobby')
  const floor = roomRect(layout, 'floor')
  const lastRow = lobby.y + lobby.h - 1
  return {
    basket: { x: OFFICE_COLS - 3, y: lastRow },
    door: { x: WALL_X, y: lastRow },
    bowl: { x: FLOOR_X, y: floor.y },
    drink: { x: FLOOR_X, y: floor.y + 1 },
    whiteboard: { x: TOP_ROOMS[1].x + 4, y: TOP_WALL_ROWS },
  }
}

/** What Morty must never stand on, whoever is sitting where: every desk's monitor and lamp, every
 * board tag (with its model stripe). In px. */
export function staticObstacles(layout: OfficeLayout): Rect[] {
  const out: Rect[] = []
  for (const desk of layout.desks) {
    const { monitor, lamp } = deskPropRects(desk.rect)
    out.push(monitor, lamp)
  }
  for (const placement of layout.placements) {
    if (placement.kind === 'board') out.push({ x: placement.seat.x - 7, y: placement.seat.y - 8, w: 14, h: 16 })
  }
  return out
}

/** The places a bubble is or may be drawn, for every agent whose state has one. A desk's bubble is
 * in its headroom row, at most DESK_BUBBLE_MAX_W wide, with its tail one px into the row below; a
 * helper's goes to the right of its stool, else the left, else above, so all three are kept clear
 * (with the tail). In px. */
export function bubbleObstacles(world: World, layout: OfficeLayout): Rect[] {
  const out: Rect[] = []
  for (const placement of layout.placements) {
    const agent = world.agents[placement.agentId]
    if (!agent || !STATE_VISUALS[agent.state].bubble) continue
    if (placement.kind === 'desk') {
      out.push({ x: placement.boxPx.x, y: placement.boxPx.y, w: DESK_BUBBLE_MAX_W + 4, h: BUBBLE_H + 4 })
    } else if (placement.kind === 'stool' || placement.kind === 'bench') {
      for (const candidate of helperCandidates(placement, COMPACT_W, layout.cols)) {
        out.push({ ...candidate.rect, h: candidate.rect.h + 3 })
      }
    }
  }
  return out
}

/** Clears every tile that `rect` (px) overlaps. */
function clearOverlapping(cells: Uint8Array, cols: number, rows: number, rect: Rect): void {
  const x0 = Math.max(0, Math.floor(rect.x / TILE))
  const x1 = Math.min(cols - 1, Math.floor((rect.x + rect.w - 1) / TILE))
  const y0 = Math.max(0, Math.floor(rect.y / TILE))
  const y1 = Math.min(rows - 1, Math.floor((rect.y + rect.h - 1) / TILE))
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * cols + x] = 0
}

export function mascotGrid(world: World, layout: OfficeLayout, tilemap: TileMap): MascotGrid {
  const { cols, rows } = tilemap
  const spots = mascotSpots(layout)

  const base = new Uint8Array(cols * rows)
  tilemap.floor.forEach((id, index) => {
    base[index] = BASE_WALKABLE.has(id) ? 1 : 0
  })
  // The walls between the top rooms are doorways for him: the only way from one top room to the next.
  const band = roomRect(layout, 'manager')
  for (const x of [TOP_ROOMS[1].x - 1, TOP_ROOMS[2].x - 1]) {
    for (let y = TOP_WALL_ROWS; y < band.h; y++) base[y * cols + x] = 1
  }
  for (const object of tilemap.objects) base[object.y * cols + object.x] = 0
  // His basket and his bowl are where he goes, not somewhere to walk across.
  for (const spot of [spots.basket, spots.bowl]) base[spot.y * cols + spot.x] = 0

  const staticWalkable = base.slice()
  for (const rect of staticObstacles(layout)) clearOverlapping(staticWalkable, cols, rows, rect)
  const walkable = staticWalkable.slice()
  for (const rect of bubbleObstacles(world, layout)) clearOverlapping(walkable, cols, rows, rect)

  const key = `${cols}x${rows}:${fnv1aBytes(staticWalkable, fnv1aBytes(walkable)).toString(36)}:${spots.basket.y}:${spots.bowl.y}`
  return { cols, rows, walkable, staticWalkable, spots, key }
}

export function isWalkable(grid: MascotGrid, t: Tile, useStatic = false): boolean {
  if (t.x < 0 || t.x >= grid.cols || t.y < 0 || t.y >= grid.rows) return false
  return (useStatic ? grid.staticWalkable : grid.walkable)[t.y * grid.cols + t.x] === 1
}

/** Neighbours in a fixed order (up, right, down, left), so a path is the same every time. */
const STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/** The shortest 4-connected path over walkable tiles, both ends included. `from` and `to` need not
 * be walkable themselves (the basket is a destination; a tile may just have become reserved under
 * him). Undefined when there is no way. */
export function findPath(grid: MascotGrid, from: Tile, to: Tile, useStatic = false): Tile[] | undefined {
  const { cols, rows } = grid
  const cells = useStatic ? grid.staticWalkable : grid.walkable
  const inside = (t: Tile): boolean => t.x >= 0 && t.x < cols && t.y >= 0 && t.y < rows
  if (!inside(from) || !inside(to)) return undefined
  const start = from.y * cols + from.x
  const goal = to.y * cols + to.x
  if (start === goal) return [from]

  const previous = new Int32Array(cols * rows).fill(-2)
  previous[start] = -1
  // A queue that grows while it is read: for-of on an array visits what is pushed meanwhile.
  const queue = [start]
  for (const current of queue) {
    const cx = current % cols
    const cy = (current - cx) / cols
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
      const next = ny * cols + nx
      if (previous[next] !== -2) continue
      if (next !== goal && cells[next] !== 1) continue
      previous[next] = current
      if (next === goal) {
        const path: Tile[] = []
        for (let at = goal; at !== -1; at = previous[at] as number) path.push({ x: at % cols, y: Math.floor(at / cols) })
        return path.reverse()
      }
      queue.push(next)
    }
  }
  return undefined
}

/** A tile path as px corner points: tile centres, with the points in the middle of a straight run
 * removed. A one-tile path is one point. */
export function cornerPoints(path: readonly Tile[]): Point[] {
  const points = path.map(tileCentre)
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true
    const before = points[index - 1] as Point
    const after = points[index + 1] as Point
    return !((point.x - before.x === after.x - point.x) && (point.y - before.y === after.y - point.y))
  })
}

/** The walkable tiles he can reach from `from` (which need not be walkable), in reading order. */
export function reachableTiles(grid: MascotGrid, from: Tile): Tile[] {
  const { cols, rows, walkable } = grid
  if (from.x < 0 || from.x >= cols || from.y < 0 || from.y >= rows) return []
  const seen = new Uint8Array(cols * rows)
  const start = from.y * cols + from.x
  seen[start] = 1
  const queue = [start]
  for (const current of queue) {
    const cx = current % cols
    const cy = (current - cx) / cols
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
      const next = ny * cols + nx
      if (seen[next] === 1 || walkable[next] !== 1) continue
      seen[next] = 1
      queue.push(next)
    }
  }
  const tiles: Tile[] = []
  for (let index = 0; index < seen.length; index++) {
    if (seen[index] === 1 && walkable[index] === 1) tiles.push({ x: index % cols, y: Math.floor(index / cols) })
  }
  return tiles
}

/** The reachable walkable tile nearest a desk cell (in tiles), not inside it and at most `maxDist`
 * tiles away (Chebyshev); ties go to the tile level with the cell's middle row, then reading order. */
export function spotNearCell(grid: MascotGrid, cell: Rect, maxDist: number, from: Tile): Tile | undefined {
  const middle = cell.y + Math.floor(cell.h / 2)
  const distanceTo = (t: Tile): number => {
    const dx = Math.max(cell.x - t.x, 0, t.x - (cell.x + cell.w - 1))
    const dy = Math.max(cell.y - t.y, 0, t.y - (cell.y + cell.h - 1))
    return Math.max(dx, dy)
  }
  return reachableTiles(grid, from)
    .map((tile) => ({ tile, distance: distanceTo(tile) }))
    .filter(({ distance }) => distance >= 1 && distance <= maxDist)
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        Math.abs(a.tile.y - middle) - Math.abs(b.tile.y - middle) ||
        a.tile.y - b.tile.y ||
        a.tile.x - b.tile.x
    )[0]?.tile
}

/** The room a tile is in, `hall` for the hallway and its partition, undefined inside a wall. */
export function roomOf(layout: OfficeLayout, t: Tile): RoomId | 'hall' | undefined {
  for (const room of layout.rooms) {
    const r = room.rect
    if (t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h) return room.id
  }
  return t.x <= WALL_X ? 'hall' : undefined
}
