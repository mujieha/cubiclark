// Bubble icons and lobby-board tags (design §6: "a distinct icon shape, not colour alone"). Icons
// are 9x9 with two placeholders: S is the icon's ink (dark on a plain bubble, white on an alert
// one, grey on a muted one) and K an accent. Every silhouette is different, so removing colour
// never makes two states look alike; test/office-sprites.test.ts compares the alpha masks.

import type { Tag, BubbleIcon } from '../../../core/office/visual.js'
import type { SpriteDef } from '../sprite.js'

const icon = (rows: string[]): SpriteDef => ({ w: 9, h: 9, rows })

export const ICONS: Record<BubbleIcon, SpriteDef> = {
  // starting: a sparkle
  spark: icon([
    '....S....',
    '....S....',
    '..S.S.S..',
    '...SSS...',
    'SSSSSSSSS',
    '...SSS...',
    '..S.S.S..',
    '....S....',
    '....S....',
  ]),
  // thinking: an ellipsis
  dots: icon([
    '.........',
    '.........',
    '.........',
    '.........',
    '.SS.SS.SS',
    '.SS.SS.SS',
    '.........',
    '.........',
    '.........',
  ]),
  // reading: an open book
  book: icon([
    '.........',
    'SSSSSSSSS',
    'SKKKSKKKS',
    'SKKKSKKKS',
    'SKKKSKKKS',
    'SKKKSKKKS',
    'SSSSSSSSS',
    '.........',
    '.........',
  ]),
  // searching: a magnifying glass
  magnifier: icon([
    '.SSSSS...',
    'S.....S..',
    'S.....S..',
    'S.....S..',
    'S.....S..',
    '.SSSSS.S.',
    '.......SS',
    '.........',
    '.........',
  ]),
  // browsing: a globe
  globe: icon([
    '.........',
    '..SSSSS..',
    '.S..S..S.',
    'S...S...S',
    'SSSSSSSSS',
    'S...S...S',
    '.S..S..S.',
    '..SSSSS..',
    '.........',
  ]),
  // editing: a pencil
  pencil: icon([
    '......SS.',
    '.....SKKS',
    '....SKKS.',
    '...SKKS..',
    '..SKKS...',
    '.SKKS....',
    '.SSS.....',
    'SS.......',
    '.........',
  ]),
  // running: a prompt, >_
  prompt: icon([
    '.........',
    'SS.......',
    '.SS......',
    '..SS.....',
    '.SS......',
    'SS..SSSS.',
    '.........',
    '.........',
    '.........',
  ]),
  // delegating: an arrow, drawn pointing right and turned with rotate90
  arrow: icon([
    '....S....',
    '.....S...',
    '......S..',
    'SSSSSSSS.',
    'SSSSSSSSS',
    'SSSSSSSS.',
    '......S..',
    '.....S...',
    '....S....',
  ]),
  // waiting for permission: a question mark
  question: icon([
    '..SSSSS..',
    '.SS...SS.',
    '.SS...SS.',
    '......SS.',
    '.....SS..',
    '....SS...',
    '....SS...',
    '.........',
    '....SS...',
  ]),
  // compacting: a stack of papers
  stack: icon([
    '.........',
    '..SSSSSSS',
    '..SKKKKKS',
    '.SSSSSSSS',
    '.SKKKKKS.',
    'SSSSSSSS.',
    'SKKKKKS..',
    'SSSSSSS..',
    '.........',
  ]),
  // stuck: an exclamation mark
  bang: icon([
    '...SSS...',
    '...SSS...',
    '...SSS...',
    '...SSS...',
    '...SSS...',
    '....S....',
    '.........',
    '...SSS...',
    '...SSS...',
  ]),
  // rate limited: zzz
  zzz: icon([
    'SSSSS....',
    '...S.....',
    '..S......',
    '.S.SSSS..',
    'SSSS..S..',
    '.....S...',
    '....SSSS.',
    '.........',
    '.........',
  ]),
  // failed: a cross
  cross: icon([
    'S.......S',
    '.S.....S.',
    '..S...S..',
    '...S.S...',
    '....S....',
    '...S.S...',
    '..S...S..',
    '.S.....S.',
    'S.......S',
  ]),
}

// --- Board tags: 14x14 badges. The check is a round disc and the exit an arched door plate, so the
// two differ in outline as well as in glyph and colour -------------------------------------------

const TAG = 14

type Shape = (x: number, y: number) => 'out' | 'edge' | 'in'

const DISC: Shape = (x, y) => {
  const d = Math.hypot(x - (TAG - 1) / 2, y - (TAG - 1) / 2)
  return d > 6.6 ? 'out' : d > 5.6 ? 'edge' : 'in'
}

// A door: 10 wide, 14 tall, the top corners cut into an arch.
const DOOR: Shape = (x, y) => {
  const arch = (y === 0 && (x < 4 || x > 9)) || (y === 1 && (x < 3 || x > 10))
  if (x < 2 || x > 11 || arch) return 'out'
  return x === 2 || x === 11 || y === 0 || y === TAG - 1 ? 'edge' : 'in'
}

function badge(shape: Shape, fill: string, glyph: readonly (readonly [number, number])[]): SpriteDef {
  const marks = new Set(glyph.map(([x, y]) => `${x},${y}`))
  const rows = Array.from({ length: TAG }, (_, y) =>
    Array.from({ length: TAG }, (_, x) => {
      const part = shape(x, y)
      if (part === 'out') return '.'
      if (part === 'edge') return '0'
      return marks.has(`${x},${y}`) ? '1' : fill
    }).join('')
  )
  return { w: TAG, h: TAG, rows }
}

const CHECK: [number, number][] = [
  [3, 7], [4, 8], [5, 9], [6, 8], [7, 7], [8, 6], [9, 5], [10, 4],
  [3, 6], [4, 7], [5, 8], [6, 7], [7, 6], [8, 5], [9, 4],
]

// An arrow pointing right, going out through the door.
const EXIT: [number, number][] = [
  [4, 6], [5, 6], [6, 6], [7, 6], [8, 6], [4, 7], [5, 7], [6, 7], [7, 7], [8, 7],
  [7, 4], [8, 5], [9, 6], [9, 7], [8, 8], [7, 9],
]

export const TAGS: Record<Tag, SpriteDef> = {
  check: badge(DISC, 'c', CHECK),
  exit: badge(DOOR, '3', EXIT),
}
