// Morty, the office corgi: what he does (PLAN.md, cubiclark-morty §2.4). Pure, like the rest of
// core: a clock is passed in, never read. This file grows with the plan; for now it names his frames.

/** Every frame Morty is drawn in (src/client/office/art/mascot.ts). The side frames face right. */
export const MORTY_FRAME_NAMES = [
  'walk_side_a',
  'walk_side_b',
  'walk_down_a',
  'walk_down_b',
  'walk_up_a',
  'walk_up_b',
  'sit',
  'wag_a',
  'wag_b',
  'sleep_a',
  'sleep_b',
  'drink_a',
  'drink_b',
  'sniff_a',
  'sniff_b',
  'carry_ball',
] as const

export type MortyFrame = (typeof MORTY_FRAME_NAMES)[number]
