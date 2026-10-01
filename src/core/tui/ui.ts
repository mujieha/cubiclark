// The little state the terminal keeps beside the World (cubiclark-tui): which view has the focus, which
// agent is selected, whether the office is shown and how far the log is scrolled back. The reducer
// over keys is added with the keys themselves; renderTui only reads these.

export type TuiFocus = 'office' | 'list' | 'log'

export interface TuiUi {
  focus: TuiFocus
  /** The selected agent's id; undefined when none is. */
  selectedId?: string
  /** `l` turns the office off, to give the list and the log its rows. */
  officeOn: boolean
  /** Lines the log is scrolled back from its newest line. */
  logScroll: number
}

export const INITIAL_UI: TuiUi = { focus: 'list', officeOn: true, logScroll: 0 }
