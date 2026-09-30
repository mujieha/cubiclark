// Morty, the office corgi, drawn in code (cubiclark-morty §2.2): our own drawing, string grids over
// the office palette plus his three colours. Every frame is 16x12 and fits inside one floor tile.
//   g coat  h cream  i nose  0 outline  1 paper (the ball)  3 grey  d blue  6 7 wood
// The side frames face right; the renderer mirrors them for left.

import type { MortyFrame } from '../../../core/office/mascot.js'
import type { Point } from '../../../core/office/geometry.js'
import type { SpriteDef } from '../sprite.js'

const W = 16
const H = 12
const BLANK = '.'.repeat(W)

const frame = (rows: readonly string[]): SpriteDef => ({ w: W, h: H, rows })
const blank = (n: number): string[] => Array.from({ length: n }, () => BLANK)

/** Sets single pixels on a copy of the rows: [x, y, char]. */
function paint(rows: readonly string[], pixels: readonly (readonly [number, number, string])[]): string[] {
  const out = [...rows]
  for (const [x, y, char] of pixels) {
    const row = out[y] ?? BLANK
    out[y] = row.slice(0, x) + char + row.slice(x + 1)
  }
  return out
}

/** Every row moved `dx` columns right, what falls off the edge dropped. */
const shiftRight = (rows: readonly string[], dx: number): string[] => rows.map((row) => '.'.repeat(dx) + row.slice(0, W - dx))

// --- Walking, seen from the side: long body, short legs, big ears, cream chest -----------------

const SIDE_BODY = [
  '................',
  '..........0..0..',
  '.........0g00g0.',
  '.........0gggg0.',
  '.00.....0ggg0gh0',
  '0gg000000gghhhhi',
  '0ggggggg0hhhhhh0',
  '.0ggggggghhhhh0.',
  '.0hhhhhhhhhhh0..',
]

const walkSide = (legs: readonly string[]): SpriteDef => frame([...SIDE_BODY, ...legs, BLANK])

// --- Seen from the front and from behind ------------------------------------------------------

const FRONT_TOP = [
  '....00....00....',
  '...0gg0..0gg0...',
  '...0gggggggg0...',
  '...0g0gggg0g0...',
  '...0ghhhhhhg0...',
  '....0hhiihh0....',
  '.....0hhhh0.....',
  '..0ggghhhhggg0..',
  '..0gggghhgggg0..',
  '..0gggggggggg0..',
]

const BACK_TOP = [
  '....00....00....',
  '...0gg0..0gg0...',
  '...0gggggggg0...',
  '...0gggggggg0...',
  '...0gggggggg0...',
  '....0gggggg0....',
  '.....0gggg0.....',
  '..0gggggggggg0..',
  '..0gggggggggg0..',
  '..0gggghhgggg0..',
]

/** The back of a dog with its head down: `plain` rows of shoulders and back, then the cream rump. */
const DRINK_BODY = (plain: number): string[] => [...Array.from({ length: plain }, () => '..0gggggggggg0..'), '..0gggghhgggg0..']

const BOTH_LEGS = ['..0hh0....0hh0..', '..0000....0000..']
const ONE_LEG_UP = ['..0hh0....0000..', '..0000..........']

// --- Sitting ----------------------------------------------------------------------------------

const SIT = [
  '..........0..0..',
  '.........0g00g0.',
  '.........0gggg0.',
  '........0ggg0gh0',
  '........0gghhhhi',
  '......000hhhh00.',
  '.....0gggghhh0..',
  '....0gggggghh0..',
  '...0ggggggghhh0.',
  '..0gggggggg0hh0.',
  '..0hhhhhhh0hh0..',
  '..0000000000000.',
]

// --- Asleep: lying down, the head on the paws with the ears up and the eye shut, the back rises and falls

const SLEEP_LOW = [
  '..........0..0..',
  '.........0g00g0.',
  '.........0gggg0.',
  '..0000000gg00gh0',
  '.0gggggg0gghhhhi',
  '0ggggggg0hhhhhh0',
  '.0ggggggghhhhhh0',
  '.0hhhhhhhhhhhhh0',
  '..00000000000000',
]

/** The breath in: the back one row higher, the head where it was. */
const SLEEP_HIGH = [
  ...SLEEP_LOW.slice(0, 2),
  '..000000.0gggg0.',
  '.0gggggg0gg00gh0',
  ...SLEEP_LOW.slice(4),
]

export const MORTY_FRAMES: Record<MortyFrame, SpriteDef> = {
  walk_side_a: walkSide(['..0hh0...0hh0...', '..0000...0000...']),
  walk_side_b: walkSide(['...0hh0.0hh0....', '...0000.0000....']),
  walk_down_a: frame([...FRONT_TOP, ...BOTH_LEGS]),
  walk_down_b: frame([...FRONT_TOP, ...ONE_LEG_UP]),
  walk_up_a: frame([...BACK_TOP, ...BOTH_LEGS]),
  walk_up_b: frame([...BACK_TOP, ...ONE_LEG_UP]),
  sit: frame(SIT),
  // Sitting with the tail up, and with it swept to the side: a wag.
  wag_a: frame(
    paint(SIT, [
      [3, 3, '0'],
      [2, 4, '0'],
      [3, 4, 'g'],
      [4, 4, '0'],
      [2, 5, '0'],
      [3, 5, 'g'],
      [4, 5, '0'],
      [2, 6, '0'],
      [3, 6, 'g'],
      [4, 6, '0'],
    ])
  ),
  wag_b: frame(
    paint(SIT, [
      [2, 6, '0'],
      [3, 6, '0'],
      [4, 6, '0'],
      [1, 7, '0'],
      [2, 7, 'g'],
      [3, 7, 'g'],
      [2, 8, '0'],
    ])
  ),
  sleep_a: frame([...blank(3), ...SLEEP_LOW]),
  sleep_b: frame([...blank(3), ...SLEEP_HIGH]),
  // Drinking, seen from behind with the head down at the bowl (up the page); the second frame dips.
  drink_a: frame([...blank(1), ...BACK_TOP.slice(0, 2), '...0gggggggg0...', ...DRINK_BODY(5), ...BOTH_LEGS]),
  drink_b: frame([...blank(2), ...BACK_TOP.slice(0, 2), '...0gggggggg0...', ...DRINK_BODY(4), ...BOTH_LEGS]),
  // Sniffing the wall: standing, seen from behind, the head nudging from side to side.
  sniff_a: frame([...BACK_TOP, ...BOTH_LEGS]),
  sniff_b: frame([...shiftRight(BACK_TOP.slice(0, 7), 1), ...BACK_TOP.slice(7), ...BOTH_LEGS]),
  // Sitting with the ball in his mouth.
  carry_ball: frame(
    paint(SIT, [
      [13, 5, '0'],
      [14, 5, '1'],
      [15, 5, '1'],
      [13, 6, '0'],
      [14, 6, '1'],
      [15, 6, '1'],
      [13, 7, '0'],
      [14, 7, '0'],
      [15, 7, '0'],
    ])
  ),
}

/** The pixel of the side frames that holds the ball: where it leaves and arrives. */
export const MORTY_MOUTH: Point = { x: 14, y: 5 }

export const MORTY_PROPS = {
  /** His bed: a dark weave and a cream cushion, so that an orange dog asleep in it is seen. */
  basket: {
    w: 16,
    h: 8,
    rows: [
      '..555555555555..',
      '.05hhhhhhhhhh50.',
      '.5hhhhhhhhhhhh5.',
      '0545454545454540',
      '0454545454545450',
      '0545454545454540',
      '0454545454545450',
      '.00000000000000.',
    ],
  },
  /** His water bowl: grey, with water in it. */
  bowl: {
    w: 10,
    h: 5,
    rows: ['.00000000.', '0dddddddd0', '0333333330', '.03333330.', '..000000..'],
  },
  ball: { w: 4, h: 4, rows: ['.00.', '0110', '0110', '.00.'] },
} satisfies Record<string, SpriteDef>
