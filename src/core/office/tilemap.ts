// Which tile goes where (PLAN.md phase 3 §2.2): the static picture of the office, as data. Two
// layers: `floor` (one tile per cell, row-major) and `objects` (desks, chairs, stools, the bench,
// the whiteboard and the plants, drawn on top). Pure, so tests can check what the renderer draws.

import {
  BOARD_COLS,
  BOARD_X,
  FLOOR_COLS,
  FLOOR_X,
  HALL_COLS,
  TILE,
  TOP_ROOMS,
  TOP_ROOM_COLS,
  WALL_X,
  type Rect,
} from './geometry.js'
import type { OfficeLayout } from './layout.js'

export const TILE_IDS = [
  'floor_wood',
  'floor_carpet_manager',
  'floor_carpet_planning',
  'floor_tile_review',
  'floor_lobby',
  'hall',
  'partition',
  'wall_top',
  'wall_face',
  'door_closed',
  'door_open',
  'desk_l',
  'desk_m',
  'desk_r',
  'chair',
  'stool',
  'bench',
  'sign',
  'whiteboard_l',
  'whiteboard_r',
  'meter_frame',
  'plant',
  'board',
] as const

export type TileId = (typeof TILE_IDS)[number]

export interface TileObject {
  /** Tile coordinates. */
  x: number
  y: number
  tile: TileId
}

export interface TileMap {
  cols: number
  rows: number
  /** cols * rows tiles, row-major. */
  floor: TileId[]
  objects: TileObject[]
}

export interface TileMapOptions {
  /** The door is drawn open (only the "no agents" scene). */
  doorOpen?: boolean
  /** The wall meter is drawn: only when the World has quota data. */
  quota?: boolean
}

const CARPET: Record<'manager' | 'planning' | 'review', TileId> = {
  manager: 'floor_carpet_manager',
  planning: 'floor_carpet_planning',
  review: 'floor_tile_review',
}

/** The desk, its chair and nothing else, for a desk cell: also what is drawn for a vacated desk. */
export function deskObjects(cell: Rect): TileObject[] {
  return [
    { x: cell.x + 1, y: cell.y + 1, tile: 'chair' },
    { x: cell.x, y: cell.y + 2, tile: 'desk_l' },
    { x: cell.x + 1, y: cell.y + 2, tile: 'desk_m' },
    { x: cell.x + 2, y: cell.y + 2, tile: 'desk_r' },
  ]
}

/** Where a desk's monitor (8x8) and lamp (6x8) are drawn, in px: on the desk's top edge, three px
 * into the row above it. The renderer draws them here, and Morty's map keeps clear of them. */
export function deskPropRects(cell: Rect): { monitor: Rect; lamp: Rect } {
  const top = (cell.y + 2) * TILE - 3
  return {
    monitor: { x: cell.x * TILE + 4, y: top, w: 8, h: 8 },
    lamp: { x: (cell.x + 2) * TILE + 5, y: top, w: 6, h: 8 },
  }
}

export function buildTileMap(officeLayout: OfficeLayout, opts: TileMapOptions = {}): TileMap {
  const { cols, rows } = officeLayout
  const floor: TileId[] = new Array<TileId>(cols * rows).fill('wall_top')
  const objects: TileObject[] = []
  const set = (x: number, y: number, tile: TileId): void => {
    if (x >= 0 && x < cols && y >= 0 && y < rows) floor[y * cols + x] = tile
  }
  const fill = (rect: Rect, tile: TileId): void => {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) set(x, y, tile)
  }
  const room = (id: string): Rect => (officeLayout.rooms.find((r) => r.id === id) as { rect: Rect }).rect
  const top = room('manager')
  const floorRoom = room('floor')
  const lobby = room('lobby')

  // The hallway runs the whole height; the partition beside it and the wall around the rooms.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < HALL_COLS; x++) set(x, y, 'hall')
    set(WALL_X, y, y < lobby.y ? 'partition' : 'wall_top')
  }

  // The top band: three rooms, each with a wall and a wall face above its floor.
  for (const def of TOP_ROOMS) {
    const rect = room(def.id)
    fill({ x: def.x, y: 0, w: TOP_ROOM_COLS, h: 1 }, 'wall_top')
    fill({ x: def.x, y: 1, w: TOP_ROOM_COLS, h: 2 }, 'wall_face')
    fill({ x: def.x, y: 3, w: TOP_ROOM_COLS, h: rect.h - 3 }, CARPET[def.id])
    for (let y = 0; y < top.h; y++) set(def.x + TOP_ROOM_COLS, y, 'wall_top')
    objects.push({ x: def.x + TOP_ROOM_COLS - 1, y: top.h - 1, tile: 'plant' })
  }
  // The whiteboard hangs in the planning room; the quota meter on the manager's wall.
  const planning = TOP_ROOMS[1]
  objects.push({ x: planning.x + 4, y: 1, tile: 'whiteboard_l' }, { x: planning.x + 5, y: 1, tile: 'whiteboard_r' })
  if (opts.quota) objects.push({ x: TOP_ROOMS[0].x + 7, y: 1, tile: 'meter_frame' })

  // The wall between the top band and the project floor, then the floor itself.
  fill({ x: WALL_X + 1, y: top.h, w: cols - WALL_X - 1, h: 1 }, 'wall_top')
  fill(floorRoom, 'floor_wood')
  for (let y = floorRoom.y; y < floorRoom.y + floorRoom.h; y++) set(FLOOR_X + FLOOR_COLS, y, 'wall_top')
  for (const cluster of officeLayout.clusters) fill(cluster.signRect, 'sign')
  fill({ x: WALL_X + 1, y: floorRoom.y + floorRoom.h, w: cols - WALL_X - 1, h: 1 }, 'wall_top')

  // The lobby: a hall-wide floor with the sign-out board along its top, the door in the bottom wall.
  fill(lobby, 'floor_lobby')
  const boardRows = Math.max(1, Math.ceil(officeLayout.memo.boardOrder.length / BOARD_COLS))
  fill({ x: BOARD_X, y: lobby.y, w: BOARD_COLS, h: boardRows }, 'board')
  objects.push({ x: cols - 1, y: lobby.y + lobby.h - 1, tile: 'plant' })
  fill({ x: 0, y: rows - 1, w: cols, h: 1 }, 'wall_top')
  for (let x = 0; x < HALL_COLS; x++) set(x, rows - 1, opts.doorOpen ? 'door_open' : 'door_closed')

  // Furniture: a desk and chair per occupied desk, a stool per seated helper, the bench.
  for (const desk of officeLayout.desks) objects.push(...deskObjects(desk.rect))
  for (const placement of officeLayout.placements) {
    if (placement.kind === 'stool') {
      objects.push({ x: Math.floor(placement.boxPx.x / 16), y: Math.floor(placement.boxPx.y / 16), tile: 'stool' })
    } else if (placement.kind === 'bench') {
      objects.push({ x: Math.floor(placement.boxPx.x / 16), y: Math.floor(placement.boxPx.y / 16) + 1, tile: 'bench' })
    }
  }

  return { cols, rows, floor, objects }
}
