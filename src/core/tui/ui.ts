// The little state the terminal keeps beside the World (cubiclark-tui): which view has the focus, which
// agent is selected, whether the office is shown and how far the log is scrolled back. renderTui only
// reads it; keys change it through reduceKey, a pure function over key names, so every key is a test.

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

export type TuiKey =
  | 'quit'
  | 'tab'
  | 'backtab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pageup'
  | 'pagedown'
  | 'home'
  | 'end'
  | 'office'
  | 'escape'

const NAMED: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'escape'])

/** What readline's `keypress` event gives (the string typed and the key it parsed) as one of our keys. */
export function keyOf(str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined): TuiKey | undefined {
  const name = key?.name
  if (key?.ctrl === true) return name === 'c' || name === 'd' ? 'quit' : undefined
  if (name === 'q' || str === 'q' || str === 'Q') return 'quit'
  if (name === 'tab') return key?.shift === true ? 'backtab' : 'tab'
  if (name === 'l' || str === 'l' || str === 'L') return 'office'
  if (name !== undefined && NAMED.has(name)) return name as TuiKey
  return undefined
}

export interface KeyContext {
  /** The agents in the office's reading order, and in the list's. */
  officeOrder: readonly string[]
  listOrder: readonly string[]
  officeShown: boolean
  /** Lines in the log, and how many it shows at once. */
  logRows: number
  logPage: number
  /** How many rows PageUp and PageDown move in the list or the office. */
  listPage: number
}

const FOCUS_ORDER: readonly TuiFocus[] = ['office', 'list', 'log']

function moveSelection(ui: TuiUi, key: TuiKey, order: readonly string[], page: number): TuiUi {
  const n = order.length
  if (n === 0) return ui
  const at = ui.selectedId === undefined ? -1 : order.indexOf(ui.selectedId)
  const step = Math.max(1, page)
  const target = (): number => {
    switch (key) {
      case 'up':
      case 'left':
        return at < 0 ? n - 1 : Math.max(0, at - 1)
      case 'down':
      case 'right':
        return at < 0 ? 0 : Math.min(n - 1, at + 1)
      case 'pageup':
        return at < 0 ? n - 1 : Math.max(0, at - step)
      case 'pagedown':
        return at < 0 ? 0 : Math.min(n - 1, at + step)
      case 'home':
        return 0
      default:
        return n - 1
    }
  }
  const id = order[target()] as string
  return id === ui.selectedId ? ui : { ...ui, selectedId: id }
}

function scrollLog(ui: TuiUi, key: TuiKey, ctx: KeyContext): TuiUi {
  const max = Math.max(0, ctx.logRows - ctx.logPage)
  const page = Math.max(1, ctx.logPage)
  let next: number
  switch (key) {
    case 'up':
      next = ui.logScroll + 1
      break
    case 'down':
      next = ui.logScroll - 1
      break
    case 'pageup':
      next = ui.logScroll + page
      break
    case 'pagedown':
      next = ui.logScroll - page
      break
    case 'home':
      next = max
      break
    case 'end':
      next = 0
      break
    default:
      return ui
  }
  next = Math.min(max, Math.max(0, next))
  return next === ui.logScroll ? ui : { ...ui, logScroll: next }
}

export function reduceKey(ui: TuiUi, key: TuiKey, ctx: KeyContext): { ui: TuiUi; quit: boolean } {
  const done = (next: TuiUi): { ui: TuiUi; quit: boolean } => ({ ui: next, quit: false })
  switch (key) {
    case 'quit':
      return { ui, quit: true }
    case 'tab':
    case 'backtab': {
      const cycle = ctx.officeShown ? FOCUS_ORDER : FOCUS_ORDER.filter((focus) => focus !== 'office')
      const at = Math.max(0, cycle.indexOf(ui.focus))
      const next = cycle[(at + (key === 'tab' ? 1 : cycle.length - 1)) % cycle.length] as TuiFocus
      return done({ ...ui, focus: next })
    }
    case 'office': {
      const officeOn = !ui.officeOn
      return done({ ...ui, officeOn, focus: !officeOn && ui.focus === 'office' ? 'list' : ui.focus })
    }
    case 'escape':
      return done(ui.selectedId === undefined ? ui : { ...ui, selectedId: undefined })
    default:
      if (ui.focus === 'log') return done(scrollLog(ui, key, ctx))
      return done(moveSelection(ui, key, ui.focus === 'office' && ctx.officeShown ? ctx.officeOrder : ctx.listOrder, ctx.listPage))
  }
}

/** After a new World or frame: a selection that is not in view is dropped, and the focus is not left on
 * an office that is not on screen. Returns the same object when nothing changes. */
export function reconcileUi(ui: TuiUi, visibleIds: ReadonlySet<string>, officeShown: boolean): TuiUi {
  const lostSelection = ui.selectedId !== undefined && !visibleIds.has(ui.selectedId)
  const lostFocus = ui.focus === 'office' && !officeShown
  if (!lostSelection && !lostFocus) return ui
  return { ...ui, ...(lostSelection ? { selectedId: undefined } : {}), ...(lostFocus ? { focus: 'list' as const } : {}) }
}
