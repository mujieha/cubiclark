// Morty and the seats, for the terminal (cubiclark-tui): the page's own calls into layout() and the
// mascot machine, without any drawing. Pure, like the rest of core/: the animation clock is passed in.

import type { MascotActivity } from '../office/mascot.js'
import type { RoomId } from '../office/roles.js'

/** Where Morty is and what he is doing, in the words the terminal can show. */
export interface TuiMorty {
  activity: MascotActivity
  walking: boolean
  /** The room his feet are in; `hall` is the gap between rooms, undefined when he is nowhere known. */
  room: RoomId | 'hall' | undefined
  /** The agent he is sitting by or playing with. */
  withId?: string
}
