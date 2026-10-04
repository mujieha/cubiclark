// How often the terminal may be redrawn (cubiclark-tui): at most ten times a second, and while
// something on screen animates, about four. Pure arithmetic; src/tui/loop.ts owns the timers.

/** The least time between two frames: ten a second at most. */
export const MIN_FRAME_MS = 100
/** While a typing letter or Morty can change, a frame is asked for this often. */
export const ANIMATION_FRAME_MS = 250

/** How long to wait before drawing, given when the last frame was drawn (undefined: none yet). */
export function drawDelay(lastDrawMs: number | undefined, nowMs: number, minMs: number = MIN_FRAME_MS): number {
  if (lastDrawMs === undefined) return 0
  return Math.max(0, lastDrawMs + minMs - nowMs)
}
