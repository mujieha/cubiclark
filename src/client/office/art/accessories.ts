// One accessory per role (design §7): a tie for the orchestrator, a clipboard for the planner, a
// magnifier for the reviewer, headphones for the builder, a cap for the explorer. Each is drawn on
// top of a character frame, offset from that frame's `head` or `chest` anchor.

import type { Accessory } from '../../../core/office/roles.js'
import type { SpriteDef } from '../sprite.js'

export interface AccessoryArt {
  sprite: SpriteDef
  /** Which anchor of the character frame it hangs from. */
  anchor: 'head' | 'chest'
  /** Where the sprite's top-left corner sits relative to that anchor, in px. */
  dx: number
  dy: number
}

const art = (rows: string[]): SpriteDef => ({ w: rows[0]?.length ?? 0, h: rows.length, rows })

export const ACCESSORIES: Record<Exclude<Accessory, 'none'>, AccessoryArt> = {
  tie: {
    sprite: art(['0aa0', '.aa.', '.aa.', '0aa0', '.aa.', '..0.']),
    anchor: 'chest',
    dx: -2,
    dy: -2,
  },
  clipboard: {
    sprite: art(['.0660.', '011110', '013310', '011110', '013310', '011110', '.0000.']),
    anchor: 'chest',
    dx: 2,
    dy: -2,
  },
  magnifier: {
    sprite: art(['.0000..', '011110.', '011110.', '011110.', '.0000..', '....60.', '.....60']),
    anchor: 'chest',
    dx: 1,
    dy: -3,
  },
  headphones: {
    sprite: art([
      '.....0000.....',
      '...00....00...',
      '..0........0..',
      '..0........0..',
      '.022......220.',
      '.022......220.',
      '..00......00..',
    ]),
    anchor: 'head',
    dx: -7,
    dy: -1,
  },
  cap: {
    sprite: art(['...000000...', '..0bbbbbb0..', '.0bbbbbbbb0.', '0bbbbbbbbb00']),
    anchor: 'head',
    dx: -6,
    dy: 0,
  },
}
