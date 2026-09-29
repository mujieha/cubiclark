// The character, drawn in code (design §7): every frame is 16x24, assembled from a few shared
// parts (a head, a torso, legs) so a frame differs from its neighbour by exactly what moves.
//   S shirt  K skin  H hair  0 outline  4 trousers  3 shoes  1 paper
// A seated frame keeps its content in the top 16 rows and leaves the bottom 8 clear: the tile row
// the character sits in is 16 px tall, the desk is drawn over the rest (PLAN.md phase 3 §2.4).

import type { SpriteDef } from '../sprite.js'

const W = 16
const H = 24
const BLANK = '.'.repeat(W)

// --- Heads: 7 rows, drawn from the top outline down to the chin ------------------------------

const HEAD_FRONT = [
  '....00000000....',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '...0HKKKKKKH0...',
  '...0K0KKKK0K0...',
  '...0KKKKKKKK0...',
  '....0KKKKKK0....',
]

const HEAD_LOOK_RIGHT = [
  '....00000000....',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '...0HKKKKKKH0...',
  '...0KKK0KK0K0...',
  '...0KKKKKKKK0...',
  '....0KKKKKK0....',
]

const HEAD_BACK = [
  '....00000000....',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '....0HHHHHH0....',
]

const HEAD_SIDE = [
  '....00000000....',
  '...0HHHHHHHH0...',
  '...0HHHHHKKK0...',
  '...0HHHHKK0K0...',
  '...0HHHHKKKK0...',
  '...0HHHHKKKK0...',
  '....0HHKKKK0....',
]

const HEAD_ASLEEP = [
  '....00000000....',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '...0HKKKKKKH0...',
  '...0K00KK00K0...',
  '...0KKKKKKKK0...',
  '....0KKKKKK0....',
]

const HEAD_SLUMPED = [
  '....00000000....',
  '...0HHHHHHHH0...',
  '...0HHHHHHHH0...',
  '...0HKKKKKKH0...',
  '...0K0KKKK0K0...',
  '...0KKK00KKK0...',
  '....0KKKKKK0....',
]

/** Hands behind the head: the "leaning back" pose. */
const HEAD_HANDS_UP = [
  '....00000000....',
  '...0HHHHHHHH0...',
  '.KK0HHHHHHHH0KK.',
  '.KK0HKKKKKKH0KK.',
  '..K0K0KKKK0K0K..',
  '...0KKKKKKKK0...',
  '....0KKKKKK0....',
]

// --- Torsos ----------------------------------------------------------------------------------

const SHOULDERS = '..000SSSSSS000..'
const BOTTOM = '.00SSSSSSSSSS00.'
const torsoRow = (interior: string): string => `.0${interior}0.`
const S12 = 'SSSSSSSSSSSS'
const HANDS_LEFT = 'SSKKSSSSSSSS'
const HANDS_RIGHT = 'SSSSSSSSKKSS'
const HANDS_BOTH = 'SSKKSSSSKKSS'

/** Shoulders, four plain rows, two rows for the hands, the hem: 8 rows (rows 8-15 of a seated frame). */
const torso = (row13: string, row14: string): string[] => [
  SHOULDERS,
  ...Array.from({ length: 4 }, () => torsoRow(S12)),
  torsoRow(row13),
  torsoRow(row14),
  BOTTOM,
]

/** The same, one row shorter, for a leaning-forward frame whose head sits 2 rows lower. */
const torsoShort = (hands: string): string[] => [SHOULDERS, torsoRow(S12), torsoRow(S12), torsoRow(S12), torsoRow(hands), BOTTOM]

// --- Standing bodies: 16 rows (rows 8-23) ------------------------------------------------------

const legsStanding = [
  '...0444444440...',
  '...0444004440...',
  '...0444004440...',
  '...0444004440...',
  '...0444004440...',
  '...0444004440...',
  '...0333003330...',
  '..033330033330..',
  '..000000000000..',
]

const legsStride = [
  '...0444444440...',
  '...0444004440...',
  '...0444004440...',
  '...0444004440...',
  '..04440..04440..',
  '..04440..04440..',
  '..03330..03330..',
  '.033330..033330.',
  '.000000..000000.',
]

const standingBody = (arms: string, legs: readonly string[]): string[] => [
  SHOULDERS,
  ...Array.from({ length: 4 }, () => torsoRow(S12)),
  torsoRow(arms),
  BOTTOM,
  ...legs,
]

// --- Assembly --------------------------------------------------------------------------------

interface Built {
  rows: string[]
  headTop: number
}

function frameOf({ rows, headTop }: Built): SpriteDef {
  const padded = [...rows, ...Array.from({ length: Math.max(0, H - rows.length) }, () => BLANK)]
  return { w: W, h: H, rows: padded, anchors: { head: { x: 8, y: headTop }, chest: { x: 8, y: headTop + 9 } } }
}

const blank = (n: number): string[] => Array.from({ length: n }, () => BLANK)

/** Shifts every row `dx` columns right (left when negative), dropping what falls off the edge. */
function shift(rows: readonly string[], dx: number): string[] {
  return rows.map((row) => (dx >= 0 ? '.'.repeat(dx) + row.slice(0, W - dx) : row.slice(-dx) + '.'.repeat(-dx)))
}

/** Sets single pixels on a copy of the rows: [x, y, char]. */
function paint(rows: readonly string[], pixels: readonly (readonly [number, number, string])[]): string[] {
  const out = [...rows]
  for (const [x, y, char] of pixels) {
    const row = out[y] ?? BLANK
    out[y] = row.slice(0, x) + char + row.slice(x + 1)
  }
  return out
}

/** A seated frame: a blank row, the head, the torso; the last 8 rows stay clear. */
const seated = (head: readonly string[], torsoRows: readonly string[]): Built => ({ rows: [BLANK, ...head, ...torsoRows], headTop: 1 })

const standing = (head: readonly string[], body: readonly string[]): Built => ({ rows: [BLANK, ...head, ...body], headTop: 1 })

// A waving arm rises on the right: a hand (K) at the top, a sleeve (S) down to the shoulder.
const waving = (handX: number, armX: number): Built => {
  const base = standing(HEAD_FRONT, standingBody('KKSSSSSSSSSS', legsStanding))
  const arm = [
    ...[8, 7, 6, 5, 4, 3].map((y) => [armX, y, 'S'] as const),
    [handX, 1, 'K'] as const,
    [handX + 1, 1, 'K'] as const,
    [handX, 2, 'K'] as const,
    [handX + 1, 2, 'K'] as const,
  ]
  return { ...base, rows: paint(base.rows, arm) }
}

const walking = (head: readonly string[], arms: string, legs: readonly string[]): Built => standing(head, standingBody(arms, legs))

export const CHARACTER_FRAMES: Record<string, SpriteDef> = {
  // Seated, at rest: hands on the desk, looking about.
  sit_idle_a: frameOf(seated(HEAD_FRONT, torso(HANDS_BOTH, HANDS_BOTH))),
  sit_idle_b: frameOf(seated(HEAD_LOOK_RIGHT, torso(HANDS_BOTH, HANDS_BOTH))),
  // Typing: one hand down, then the other.
  sit_type_a: frameOf(seated(HEAD_FRONT, torso(HANDS_LEFT, HANDS_LEFT))),
  sit_type_b: frameOf(seated(HEAD_FRONT, torso(HANDS_RIGHT, HANDS_RIGHT))),
  // Reading, searching, browsing: the head drops and leans toward the screen.
  sit_lean_fwd_a: frameOf({ rows: [...blank(3), ...shift(HEAD_FRONT, 1), ...torsoShort(HANDS_LEFT)], headTop: 3 }),
  sit_lean_fwd_b: frameOf({ rows: [...blank(3), ...shift(HEAD_FRONT, 1), ...torsoShort(HANDS_RIGHT)], headTop: 3 }),
  // Waiting for you: leaning back, hands behind the head.
  sit_lean_back: frameOf({ rows: [BLANK, ...HEAD_HANDS_UP, SHOULDERS, ...Array.from({ length: 6 }, () => torsoRow(S12)), BOTTOM], headTop: 1 }),
  // Delegating: turned toward the helper stool on the right.
  sit_side: frameOf(seated(HEAD_SIDE, torso(HANDS_RIGHT, HANDS_RIGHT))),
  // Compacting: shuffling papers.
  sit_shuffle_a: frameOf(seated(HEAD_FRONT, torso('S1111111SSSS', 'S1111KKSSSSS'))),
  sit_shuffle_b: frameOf(seated(HEAD_FRONT, torso('SSSS1111111S', 'SSSSS1111KKS'))),
  // Rate limited: asleep, head down on folded arms.
  sit_sleep: frameOf({
    rows: [...blank(6), ...HEAD_ASLEEP, torsoRow('KKKKKKKKKKKK'), torsoRow(S12), BOTTOM],
    headTop: 6,
  }),
  // Failed: slumped, chin down, arms hanging out at the sides.
  sit_slump: frameOf({
    rows: [
      ...blank(5),
      ...HEAD_SLUMPED,
      '..0000SSSS0000..',
      torsoRow(S12),
      'KK0SSSSSSSSSS0KK',
      'KK00SSSSSSSS00KK',
    ],
    headTop: 5,
  }),
  // Standing: at the desk, waving for attention.
  stand: frameOf(standing(HEAD_FRONT, standingBody('KKSSSSSSSSKK', legsStanding))),
  stand_wave_a: frameOf(waving(14, 15)),
  stand_wave_b: frameOf(waving(13, 14)),
  // Walking, seen from the front, from behind and from the side (facing right; left is a mirror).
  walk_down_a: frameOf(walking(HEAD_FRONT, 'KKSSSSSSSSSS', legsStride)),
  walk_down_b: frameOf(walking(HEAD_FRONT, 'SSSSSSSSSSKK', legsStanding)),
  walk_up_a: frameOf(walking(HEAD_BACK, 'KKSSSSSSSSSS', legsStride)),
  walk_up_b: frameOf(walking(HEAD_BACK, 'SSSSSSSSSSKK', legsStanding)),
  walk_side_a: frameOf(walking(HEAD_SIDE, 'SSSSKKSSSSSS', legsStride)),
  walk_side_b: frameOf(walking(HEAD_SIDE, 'SSSSSSKKSSSS', legsStanding)),
}
