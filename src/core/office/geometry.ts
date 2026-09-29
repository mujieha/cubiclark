// The office's fixed numbers (PLAN.md phase 3 §2.2). Everything is in tiles unless a name says px.
// One tile is 16 px; the office is always 36 tiles wide and only ever grows downward.

export const TILE = 16
export const OFFICE_COLS = 36
/** Columns 0-1: the hallway every walk uses. */
export const HALL_COLS = 2
/** Column 2: the outer wall between the hallway and the rooms. */
export const WALL_X = 2
/** One desk cell: cols 0-2 chair, desk and character; col 3 the helper stools. */
export const CELL_COLS = 4
/** Row 0 the character's head, row 1 the desk, row 2 the aisle. */
export const CELL_ROWS = 3
export const STOOLS_PER_DESK = 3

/** The top band, left to right, each 10 tiles wide with walls at columns 13, 24 and 35. */
export const TOP_ROOMS = [
  { id: 'manager', name: "Manager's office", x: 3 },
  { id: 'planning', name: 'Planning room', x: 14 },
  { id: 'review', name: 'Review corner', x: 25 },
] as const
export const TOP_ROOM_COLS = 10
/** Two desk cells per row in a top room, at room.x + 1 and room.x + 5. */
export const TOP_CELLS_PER_ROW = 2
/** Row 0 outer wall, rows 1-2 the wall face (room name, whiteboard, quota meter). */
export const TOP_WALL_ROWS = 3

export const FLOOR_X = 3
export const FLOOR_COLS = 32
/** Three clusters per cluster row, each two cells (8 tiles) wide. */
export const CLUSTER_XS = [4, 14, 24] as const
export const CLUSTER_CELLS_PER_ROW = 2

export const BOARD_X = 5
export const BOARD_COLS = 30

/** A vacated desk stays drawn this long after its owner has left. */
export const DESK_CLEAR_MS = 5000
export const WALK_PX_PER_S = 96
export const WALK_MAX_MS = 4000
/** The middle of the hallway, in px: every route runs down this line. */
export const HALL_X_PX = 8

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function rectContains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function scaleRect(rect: Rect, factor: number): Rect {
  return { x: rect.x * factor, y: rect.y * factor, w: rect.w * factor, h: rect.h * factor }
}
