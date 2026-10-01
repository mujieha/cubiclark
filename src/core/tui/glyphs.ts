// What an agent looks like in the terminal (cubiclark-tui): a glyph for its state and a letter for its
// model family, always two cells, and the words that go with them. Colour is a help here, never the
// only difference: the state is the glyph, and the list always prints the state's word beside it.

import type { MascotActivity } from '../office/mascot.js'
import type { ModelFamily } from '../office/roles.js'
import type { AgentState } from '../types.js'

/** One printable ASCII character per state, pairwise distinct, and none of the separators the office uses. */
export const STATE_GLYPHS: Record<AgentState, string> = {
  starting: '^',
  thinking: '?',
  reading: 'R',
  editing: 'E',
  running: 'X',
  searching: 'S',
  browsing: 'B',
  delegating: 'D',
  waiting_permission: '!',
  waiting_user: 'W',
  compacting: 'C',
  stuck: '#',
  rate_limited: '$',
  failed: 'F',
  finished: '+',
  ended: '-',
}

export const FAMILY_LETTERS: Record<ModelFamily, string> = { opus: 'o', sonnet: 's', haiku: 'h', fable: 'f', other: '.' }

/** The letter on the typing frame: the other case (`.` becomes `*`). */
export const FAMILY_TYPING: Record<ModelFamily, string> = { opus: 'O', sonnet: 'S', haiku: 'H', fable: 'F', other: '*' }

/** The states whose agent types at its desk (the page's type_slow, type_fast and type poses). */
export const TYPING_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['thinking', 'editing', 'running'])

/** The states a person should notice: their glyph is drawn bold and in the alert colour. */
export const ALERT_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['waiting_permission', 'stuck', 'failed', 'rate_limited'])

/** What Morty is doing, in a word. */
export const MORTY_WORDS: Record<MascotActivity, string> = {
  nap: 'napping',
  wander: 'wandering',
  drink: 'drinking',
  greet: 'greeting',
  sit_by: 'sitting by',
  play: 'playing ball',
  sniff: 'sniffing',
}

/** A dog emoji (two cells) where the terminal can show it, else a plain `d`. */
export function mortyGlyph(unicode: boolean): string {
  return unicode ? '\u{1F415}' : 'd'
}

/** The agent as two cells: its state glyph, then its family letter (in the other case on the typing frame). */
export function agentToken(state: AgentState, family: ModelFamily, typingFrame: boolean): string {
  const letter = typingFrame && TYPING_STATES.has(state) ? FAMILY_TYPING[family] : FAMILY_LETTERS[family]
  return `${STATE_GLYPHS[state]}${letter}`
}

export interface BoxChars {
  h: string
  v: string
  tl: string
  tr: string
  bl: string
  br: string
}

export const BOX: { unicode: BoxChars; ascii: BoxChars } = {
  unicode: { h: '\u{2500}', v: '\u{2502}', tl: '\u{250C}', tr: '\u{2510}', bl: '\u{2514}', br: '\u{2518}' },
  ascii: { h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+' },
}
