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

/** The most device pixels a canvas may have on a side or in all. Past a GPU's texture size (16384 on
 * common ones) a canvas is drawn in software and every frame costs many times more; a tall office
 * (hundreds of rows) at twice the density is over it. */
export const MAX_BACKING_SIDE_PX = 16384
export const MAX_BACKING_AREA_PX = 16 * 1024 * 1024

/** The office's tile, in CSS px: as wide as the column allows, in whole px, from 16 (below that the
 * column scrolls, as it always did) to 56 (so a wide window does not give giant tiles). */
export const MIN_TILE_CSS_PX = 16
export const MAX_TILE_CSS_PX = 56

export interface OfficeSize {
  /** CSS px per tile, a whole number. */
  tileCssPx: number
  /** CSS px per logical px: tileCssPx / TILE. Fractional between whole scales. */
  cssScale: number
  cssWidth: number
  cssHeight: number
  /** Backing px per logical px of the art canvas: a whole number (backingScale). */
  backing: number
  /** Backing px per CSS px of the text canvas: the display's ratio unless the office is very tall (textDensity). */
  textDensity: number
}

const positive = (value: number, fallback: number): number => (Number.isFinite(value) && value > 0 ? value : fallback)

/** How big the office of `cols` by `rows` tiles is drawn in a column `containerWidthCss` wide, on a
 * display of `dpr`. */
export function officeSize(containerWidthCss: number, dpr: number, cols: number, rows: number): OfficeSize {
  const fit = Math.floor(positive(containerWidthCss, 0) / cols)
  const tileCssPx = Math.min(MAX_TILE_CSS_PX, Math.max(MIN_TILE_CSS_PX, fit))
  const cssScale = tileCssPx / TILE
  const ratio = positive(dpr, 1)
  const cssWidth = cols * tileCssPx
  const cssHeight = rows * tileCssPx
  return { tileCssPx, cssScale, cssWidth, cssHeight, backing: backingScale(cssScale, ratio, cols, rows), textDensity: textDensity(cssWidth, cssHeight, ratio) }
}

/** Backing px per logical px of the art for an office of `cols` by `rows` tiles shown at `cssScale` on
 * a display of `dpr`. Ideally round(cssScale × dpr), so the browser's stretch to the device stays
 * within 2/3 and 3/2; when that would pass the limits, the largest smaller whole number that fits.
 * Always a whole number, so no sprite pixel is ever split in the backing store. */
export function backingScale(cssScale: number, dpr: number, cols: number, rows: number): number {
  const ideal = Math.max(1, Math.round(positive(cssScale, 1) * positive(dpr, 1)))
  for (let scale = ideal; scale > 1; scale--) {
    const width = cols * TILE * scale
    const height = rows * TILE * scale
    if (width <= MAX_BACKING_SIDE_PX && height <= MAX_BACKING_SIDE_PX && width * height <= MAX_BACKING_AREA_PX) return scale
  }
  return 1
}

/** Backing px per CSS px of the text canvas: the display's ratio, lowered (to two decimals) only when
 * the canvas would pass the same limits as the art. */
export function textDensity(cssWidth: number, cssHeight: number, dpr: number): number {
  const w = positive(cssWidth, 1)
  const h = positive(cssHeight, 1)
  const limit = Math.min(positive(dpr, 1), MAX_BACKING_SIDE_PX / w, MAX_BACKING_SIDE_PX / h, Math.sqrt(MAX_BACKING_AREA_PX / (w * h)))
  return Math.floor(limit * 100) / 100
}

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
