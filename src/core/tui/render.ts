// renderTui (cubiclark-tui): the World, a terminal size and a clock go in; the frame comes out as lines,
// exactly `size.rows` of them, each exactly `size.cols` cells wide. Pure. It applies visibleAgents
// itself, so the office, the list, the log and every count are of the agents the page would show, and
// it builds every line through line(), so no text from the World can reach an escape sequence.

import type { OfficeLayout } from '../office/layout.js'
import { layout as computeLayout } from '../office/layout.js'
import { modelFamily } from '../office/roles.js'
import { agentCard, LEGEND, logRows, statusBar, type LogRow } from '../hud.js'
import { agentRows, emptyScreen, emptyScreenText, setupScreen, shortId, type AgentRow } from '../view.js'
import { hiddenText, visibleAgents, withVisibleAgents } from '../visible.js'
import { MAX_LOG_LINES } from '../world.js'
import type { World } from '../types.js'
import { cellWidth, fitCells, padCells, wrapCells } from './cells.js'
import { ALERT_STATES, FAMILY_LETTERS, agentToken } from './glyphs.js'
import { line, type LineStyle, type Span } from './line.js'
import { officeText, OFFICE_MIN_COLS, TYPING_FLIP_MS, type OfficeText } from './office-text.js'
import type { TuiMorty } from './scene.js'
import type { TuiFocus, TuiUi } from './ui.js'

export interface TuiSize {
  cols: number
  rows: number
}

export interface TuiOptions {
  ui: TuiUi
  color: boolean
  unicode: boolean
  /** Off: the typing letters do not flip. */
  animate: boolean
  animationMs: number
  idleDesks?: number
  /** The scene's layout, so seats stay put; ignored when it is not of the agents in view. */
  layout?: OfficeLayout
  morty?: TuiMorty
}

export interface TuiFrame {
  lines: string[]
  meta: {
    /** visibleAgents(...).ids.size */
    visible: number
    /** The focus as drawn: the office falls back to the list when it is not on screen. */
    focus: TuiFocus
    office?: { shown: number; elided: number; mortyLine?: number }
    /** Why the office is not drawn. */
    officeNote?: string
    /** Every agent in view, in the order the list shows them. */
    listOrder: string[]
    /** Every agent in view, in the office's reading order; empty when the office is not drawn. */
    officeOrder: string[]
    listTop: number
    /** Rows the list can show at once (its page). */
    listRows: number
    /** Lines in the log, and how many it shows at once. */
    logRows: number
    logPage: number
    /** Something on screen changes with the animation clock. */
    animated: boolean
  }
}

/** The office needs at least this many terminal rows. */
export const OFFICE_MIN_TERMINAL_ROWS = 20
const TOO_SMALL_COLS = 20
const TOO_SMALL_ROWS = 5
const SIDE_BY_SIDE_COLS = 100
const SEGMENT_ORDER = ['agents', 'hidden', 'permission', 'quota', 'diagnostics', 'replay', 'sources']

/** HH:MM:SS in the terminal's own time zone, as the page shows it; '' for a time that does not parse. */
function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function layoutMatches(candidate: OfficeLayout | undefined, view: World): candidate is OfficeLayout {
  if (!candidate) return false
  const ids = Object.keys(view.agents)
  return candidate.placements.length === ids.length && candidate.placements.every((placement) => Object.hasOwn(view.agents, placement.agentId))
}

export function renderTui(world: World, size: TuiSize, nowMs: number, options: TuiOptions): TuiFrame {
  const { cols, rows } = size
  const { ui, unicode } = options
  const style: LineStyle = { color: options.color, unicode }
  const ln = (spans: readonly Span[], width = cols): string => line(spans, width, style)
  const fit = (text: string, width: number): string => fitCells(text, width, style)
  const cell = (text: string, width: number): string => padCells(fit(text, width), width)
  const dot = unicode ? '\u{00b7}' : '-'
  const bar = unicode ? '\u{2502}' : '|'

  const visible = visibleAgents(world, nowMs, { idleDesks: options.idleDesks })
  const view = withVisibleAgents(world, visible)
  const empty = emptyScreen(view)
  const listData = empty === null ? agentRows(view, nowMs) : []
  const listOrder = listData.map((row) => row.id)
  const typingFrame = options.animate && Math.floor(options.animationMs / TYPING_FLIP_MS) % 2 === 1

  const meta: TuiFrame['meta'] = {
    visible: visible.ids.size,
    focus: ui.focus === 'office' ? 'list' : ui.focus,
    listOrder,
    officeOrder: [],
    listTop: 0,
    listRows: 0,
    logRows: 0,
    logPage: 0,
    animated: false,
  }

  if (cols < TOO_SMALL_COLS || rows < TOO_SMALL_ROWS) {
    const lines = Array.from({ length: rows }, (_, i) => ln(i === 0 ? [{ text: 'Cubiclark: terminal too small' }] : []))
    return { lines, meta: { ...meta, officeNote: 'terminal too small' } }
  }

  const bodyRows = rows - 3
  const blank = (): string => ln([])
  const body: string[] = []

  const selectedId = ui.selectedId !== undefined && Object.hasOwn(view.agents, ui.selectedId) ? ui.selectedId : undefined

  let office: OfficeText | undefined
  let officeNote: string | undefined

  if (empty !== null) {
    // One of the four empty screens: what it says, and for a first run how to begin.
    const text = [emptyScreenText(empty, world, visible.hidden)]
    if (empty === 'no-collector') {
      const setup = setupScreen(world)
      text.push('', setup.title, setup.intro)
      for (const mode of setup.modes) text.push('', mode.title, ...(mode.command === undefined ? [] : [`    ${mode.command}`]), mode.body)
      text.push('', setup.footer)
    }
    for (const paragraph of text) {
      if (paragraph === '') body.push(blank())
      else for (const wrapped of wrapCells(paragraph, cols - 2, style)) body.push(ln([{ text: ` ${wrapped}` }]))
    }
    officeNote = 'nothing to show'
  } else {
    // --- The office -------------------------------------------------------------------------------
    if (!ui.officeOn) officeNote = 'office off (l)'
    else if (cols < OFFICE_MIN_COLS || rows < OFFICE_MIN_TERMINAL_ROWS) officeNote = `office hidden: needs ${OFFICE_MIN_COLS}${unicode ? '\u{00d7}' : 'x'}${OFFICE_MIN_TERMINAL_ROWS}`
    else {
      const placed = layoutMatches(options.layout, view) ? options.layout : computeLayout(view)
      office = officeText({
        view,
        layout: placed,
        hidden: visible.hidden,
        width: cols,
        maxRows: Math.floor(bodyRows / 2),
        selectedId,
        morty: options.morty,
        animate: options.animate,
        animationMs: options.animationMs,
        unicode,
      })
      if (!office) officeNote = 'office hidden: no room'
    }
    if (office) {
      for (const row of office.rows) body.push(ln(row))
      meta.officeOrder = office.order
      meta.office = { shown: office.shown, elided: office.elided, ...(office.mortyRow === undefined ? {} : { mortyLine: 3 + office.mortyRow }) }
    }
    const officeDrawn = office !== undefined
    meta.focus = ui.focus === 'office' && !officeDrawn ? 'list' : ui.focus

    // --- The list and the log -----------------------------------------------------------------------
    const rest = Math.max(0, bodyRows - body.length)
    const side = cols >= SIDE_BY_SIDE_COLS
    const listW = side ? Math.floor((cols - 1) * 0.6) : cols
    const logW = side ? cols - 1 - listW : cols
    const listH = side ? rest : rest === 0 ? 0 : Math.ceil(rest * 0.6)
    const logH = side ? rest : rest - listH

    const title = (text: string, focused: boolean): Span[] => [{ text: focused ? `[${text}]` : ` ${text} `, bold: focused }]

    // The list.
    const hiddenNote = hiddenText(visible.hidden)
    const listTitle = `Agents ${listData.length}${hiddenNote === undefined ? '' : ` ${dot} ${hiddenNote}`}`
    const card = selectedId === undefined ? undefined : agentCard(view, selectedId, nowMs)
    const listBodyH = Math.max(0, listH - 1 - (card ? 1 : 0))
    const selectedIndex = selectedId === undefined ? -1 : listOrder.indexOf(selectedId)
    const listTop = selectedIndex < 0 ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(listBodyH / 2), listData.length - listBodyH))
    const widest = listData.reduce((most, row) => Math.max(most, cellWidth(fit(row.stateLabel, 40))), 0)
    const stateW = Math.max(8, Math.min(listW >= 70 ? 34 : 16, widest))
    const listLine = (row: AgentRow): Span[] => {
      const family = modelFamily(row.model)
      const text = agentToken(row.state, family, typingFrame)
      const alert = ALERT_STATES.has(row.state)
      const selected = row.id === selectedId
      return [
        { text: selected ? '>' : ' ', bold: selected },
        { text: ' '.repeat(Math.min(row.depth, 4) * 2) },
        { text: text.slice(0, 1), tone: alert ? 'alert' : family, bold: alert, inverse: selected },
        { text: text.slice(1), tone: family, inverse: selected },
        { text: ` ${cell(shortId(row.id), 8)}` },
        { text: ` ${cell(row.stateLabel, stateW)}` },
        { text: ` ${cell(row.since, 8)}` },
        { text: ` ${cell(row.project, 14)}` },
        ...(listW >= 90 ? [{ text: ` ${cell(row.model ?? '', 12)}` }] : []),
        { text: ` ${row.currentTool ?? ''}` },
      ]
    }
    const listLines: Span[][] = []
    if (listH > 0) {
      listLines.push(title(listTitle, meta.focus === 'list'))
      for (const row of listData.slice(listTop, listTop + listBodyH)) listLines.push(listLine(row))
      if (card && listH >= 2) {
        const field = (label: string): string => card.fields.find((f) => f.label === label)?.value ?? ''
        listLines.push([{ text: `${unicode ? '\u{203a}' : '->'} ${card.title} ${dot} ${field('State')} ${dot} ${field('Model')} ${dot} ${field('Task')}`, tone: 'muted' }])
      }
    }
    meta.listTop = listTop
    meta.listRows = listBodyH

    // The log: the newest line at the bottom, scrolled back by ui.logScroll.
    const logData = empty === null ? logRows(view, {}, MAX_LOG_LINES) : []
    const logPage = Math.max(0, logH - 1)
    const scroll = Math.min(Math.max(0, ui.logScroll), Math.max(0, logData.length - logPage))
    const logEnd = logData.length - scroll
    const logLine = (row: LogRow): Span[] => [
      { text: `${cell(clockOf(row.ts), 8)} `, tone: 'muted' },
      { text: `${cell(row.agent, 20)} ` },
      ...(logW >= 60 ? [{ text: `${cell(row.event, 12)} `, tone: 'muted' as const }] : []),
      { text: row.result },
    ]
    const logLines: Span[][] = []
    if (logH > 0) {
      logLines.push(title(`Log ${logData.length}${scroll > 0 ? ` ${dot} ${scroll} back` : ''}`, meta.focus === 'log'))
      for (const row of logData.slice(Math.max(0, logEnd - logPage), logEnd)) logLines.push(logLine(row))
    }
    meta.logRows = logData.length
    meta.logPage = logPage

    if (side) {
      const separator = ln([{ text: bar, tone: 'muted' }], 1)
      for (let i = 0; i < rest; i++) body.push(ln(listLines[i] ?? [], listW) + separator + ln(logLines[i] ?? [], logW))
    } else {
      for (let i = 0; i < listH; i++) body.push(ln(listLines[i] ?? []))
      for (let i = 0; i < logH; i++) body.push(ln(logLines[i] ?? []))
    }
  }
  if (office === undefined && empty !== null) meta.focus = 'list'

  while (body.length < bodyRows) body.push(blank())
  body.length = bodyRows

  // --- The three lines above the body --------------------------------------------------------------
  const tab = (name: string, id: TuiFocus): Span => {
    const available = id !== 'office' || office !== undefined
    if (meta.focus === id) return { text: `[${name}]`, bold: true }
    return available ? { text: ` ${name} ` } : { text: ` ${name} `, tone: 'muted' }
  }
  const headerLine = ln([
    { text: 'Cubiclark ', bold: true },
    { text: clockOf(world.clock) },
    { text: ` ${bar} `, tone: 'muted' },
    tab('Office', 'office'),
    tab('List', 'list'),
    tab('Log', 'log'),
    { text: ` ${bar} `, tone: 'muted' },
    { text: unicode ? 'q quit \u{00b7} Tab focus \u{00b7} \u{2191}\u{2193} select \u{00b7} l office' : 'q quit | Tab focus | up/down select | l office', tone: 'muted' },
  ])

  const segments = [...statusBar(view, visible.hidden)].sort((a, b) => SEGMENT_ORDER.indexOf(a.id) - SEGMENT_ORDER.indexOf(b.id))
  const statusSpans: Span[] = []
  segments.forEach((segment, i) => {
    if (i > 0) statusSpans.push({ text: ` ${bar} `, tone: 'muted' })
    statusSpans.push({ text: segment.text, ...(segment.id === 'permission' && segment.text !== 'permission 0' ? { tone: 'alert' as const, bold: true } : {}) })
  })

  const legend: Span[] = []
  for (const { family, label } of LEGEND.models) {
    if (legend.length > 0) legend.push({ text: '  ' })
    legend.push({ text: FAMILY_LETTERS[family], tone: family, bold: true }, { text: ` ${label}` })
  }
  if (officeNote !== undefined) {
    // The note is the part a narrow terminal must not lose: when both do not fit, it goes first.
    const legendWidth = legend.reduce((sum, span) => sum + cellWidth(span.text), 0)
    const note: Span = { text: officeNote, tone: 'muted' }
    const joint: Span = { text: ` ${dot} `, tone: 'muted' }
    if (legendWidth + 3 + cellWidth(officeNote) <= cols) legend.push(joint, note)
    else legend.unshift(note, joint)
  }
  meta.officeNote = officeNote

  meta.animated = options.animate && ((office?.typing ?? false) || (office !== undefined && options.morty !== undefined))

  return { lines: [headerLine, ln(statusSpans), ln(legend), ...body], meta }
}
