// The office in text (cubiclark-tui): rooms as boxes, desks as two-cell tokens with their helpers
// beside them, a floor line, the lobby and Morty. Who sits in which room comes from layout() (the
// page's own placement), not from its pixels. Pure: it returns spans, and render.ts sets them in
// lines. Every World string it adds (a project name, an id) is cut by fitCells first, so the widths
// computed here are the widths of what is drawn.

import { modelFamily, type RoomId } from '../office/roles.js'
import type { OfficeLayout } from '../office/layout.js'
import { AGENT_STATES, type AgentState, type World } from '../types.js'
import { officeStatusLine, shortId, STATE_LABELS } from '../view.js'
import type { HiddenCounts } from '../visible.js'
import { cellWidth, fitCells } from './cells.js'
import { ALERT_STATES, BOX, MORTY_WORDS, STATE_GLYPHS, TYPING_STATES, agentToken, mortyGlyph } from './glyphs.js'
import type { Span } from './line.js'
import type { TuiMorty } from './scene.js'

export const OFFICE_MIN_ROWS = 6
export const OFFICE_MIN_COLS = 60
/** The least width of a cluster's box; narrower terminals get fewer boxes in a row. */
const CLUSTER_MIN_COLS = 24
/** The typing letters flip this often. */
export const TYPING_FLIP_MS = 500

export interface OfficeTextInput {
  /** The World in view (only the agents that are shown). */
  view: World
  layout: OfficeLayout
  hidden: HiddenCounts
  width: number
  maxRows: number
  selectedId?: string
  morty?: TuiMorty
  animate: boolean
  animationMs: number
  unicode: boolean
}

export interface OfficeText {
  rows: Span[][]
  /** Agent tokens drawn. */
  shown: number
  /** Agents in the view that are not drawn because the office was cut to fit. */
  elided: number
  /** Every agent in the view, in the layout's reading order. */
  order: string[]
  /** The index in `rows` of the line Morty is on. */
  mortyRow?: number
  /** A token that types is drawn. */
  typing: boolean
}

/** One thing on a line: a token, a label or Morty. */
interface Elem {
  spans: Span[]
  width: number
  id?: string
  state?: AgentState
  morty?: boolean
}

interface Line {
  spans: Span[]
  width: number
  elems: Elem[]
  morty: boolean
}

interface Row {
  spans: Span[]
  morty: boolean
}

interface Group {
  room: RoomId
  cluster?: string
  items: Elem[]
}

interface BoxSpec {
  title: string
  lines: Line[]
  width: number
}

const TOP_ROOMS: readonly RoomId[] = ['manager', 'planning', 'review']

function newLine(): Line {
  return { spans: [], width: 0, elems: [], morty: false }
}

function addTo(line: Line, elem: Elem): void {
  line.spans.push(...elem.spans)
  line.width += elem.width
  line.elems.push(elem)
  if (elem.morty) line.morty = true
}

/** Groups wrapped into lines of at most `inner` cells: a desk with its helpers stays on one line when it can. */
function flowGroups(groups: readonly Elem[][], inner: number): Line[] {
  const lines: Line[] = []
  let current = newLine()
  const push = (): void => {
    if (current.elems.length > 0) lines.push(current)
    current = newLine()
  }
  for (const group of groups) {
    const total = group.reduce((sum, elem) => sum + elem.width, 0)
    if (group.some((elem) => elem.morty)) push()
    if (current.width + total <= inner) {
      for (const elem of group) addTo(current, elem)
    } else if (total <= inner) {
      push()
      for (const elem of group) addTo(current, elem)
    } else {
      for (const elem of group) {
        if (current.width + elem.width > inner) push()
        addTo(current, elem)
      }
    }
  }
  push()
  return lines
}

/** Widths of `n` boxes side by side that add up to `total`. */
function splitWidth(total: number, n: number): number[] {
  const base = Math.floor(total / n)
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base))
}

function keepLines(lines: readonly Line[], cap: number): Line[] {
  if (lines.length <= cap) return [...lines]
  if (cap <= 0) return []
  const kept = lines.slice(0, cap)
  // Morty is never the thing that is cut: his line takes the place of the last one that fits.
  const morty = lines.find((line) => line.morty)
  if (morty !== undefined && !kept.includes(morty)) kept[cap - 1] = morty
  return kept
}

export function officeText(input: OfficeTextInput): OfficeText | undefined {
  const { view, layout, hidden, width, maxRows, selectedId, morty, unicode } = input
  if (maxRows < OFFICE_MIN_ROWS || width < OFFICE_MIN_COLS) return undefined
  const style = { unicode }
  const ch = unicode ? BOX.unicode : BOX.ascii
  const typingFrame = input.animate && Math.floor(input.animationMs / TYPING_FLIP_MS) % 2 === 1

  // --- Elements ------------------------------------------------------------------------------------
  const token = (id: string, sep: string): Elem | undefined => {
    const agent = view.agents[id]
    if (!agent) return undefined
    const family = modelFamily(agent.model)
    const selected = id === selectedId
    const glyphTone = ALERT_STATES.has(agent.state) ? ('alert' as const) : family
    const text = agentToken(agent.state, family, typingFrame)
    return {
      spans: [
        { text: selected ? '>' : sep, bold: selected },
        { text: text.slice(0, 1), tone: glyphTone, bold: ALERT_STATES.has(agent.state), inverse: selected },
        { text: text.slice(1), tone: family, inverse: selected },
      ],
      width: 3,
      id,
      state: agent.state,
    }
  }
  const label = (text: string, tone?: 'muted'): Elem => {
    const clean = fitCells(text, width, style)
    return { spans: [{ text: clean, ...(tone ? { tone } : {}) }], width: cellWidth(clean) }
  }
  const mortyElem = (sep: string): Elem | undefined => {
    if (!morty) return undefined
    let text = `${mortyGlyph(unicode)} ${MORTY_WORDS[morty.activity]}`
    if (morty.withId !== undefined && (morty.activity === 'sit_by' || morty.activity === 'play')) text += ` ${fitCells(shortId(morty.withId), 8, style)}`
    if (morty.walking) text += ' (walking)'
    return { spans: [{ text: sep }, { text, tone: 'morty' }], width: cellWidth(sep) + cellWidth(text), morty: true }
  }

  // --- Who sits where, from the layout --------------------------------------------------------------
  const order: string[] = []
  const deskById = new Map(layout.desks.map((desk) => [desk.id, desk]))
  const groups: Group[] = []
  const groupOfDesk = new Map<string, Group>()
  const bench: Elem[] = []
  const board: Elem[] = []
  for (const placement of layout.placements) {
    if (!view.agents[placement.agentId]) continue
    order.push(placement.agentId)
    if (placement.kind === 'desk') {
      const item = token(placement.agentId, ' ')
      if (!item) continue
      const group: Group = { room: placement.room, cluster: placement.deskId === undefined ? undefined : deskById.get(placement.deskId)?.cluster, items: [item] }
      groups.push(group)
      if (placement.deskId !== undefined) groupOfDesk.set(placement.deskId, group)
    } else if (placement.kind === 'stool') {
      const group = placement.deskId === undefined ? undefined : groupOfDesk.get(placement.deskId)
      const item = token(placement.agentId, group ? ':' : ' ')
      if (item) (group ? group.items : bench).push(item)
    } else if (placement.kind === 'bench') {
      const item = token(placement.agentId, ' ')
      if (item) bench.push(item)
    } else {
      const item = token(placement.agentId, ' ')
      if (item) board.push(item)
    }
  }
  const total = Object.keys(view.agents).length

  // --- Boxes -----------------------------------------------------------------------------------------
  const boxLines = (members: readonly Group[], boxWidth: number, withMorty: Elem | undefined): Line[] => {
    const flows: Elem[][] = members.map((group) => group.items)
    if (withMorty) flows.push([withMorty])
    return flowGroups(flows, Math.max(1, boxWidth - 4))
  }
  const roomName = (id: RoomId): string => layout.rooms.find((room) => room.id === id)?.name ?? id

  const topWidths = splitWidth(width, TOP_ROOMS.length)
  const top: BoxSpec[] = TOP_ROOMS.map((id, i) => ({
    title: roomName(id),
    width: topWidths[i] as number,
    lines: boxLines(
      groups.filter((group) => group.room === id),
      topWidths[i] as number,
      morty?.room === id ? mortyElem(' ') : undefined
    ),
  }))

  const perRow = Math.max(1, Math.min(layout.clusters.length, Math.floor(width / CLUSTER_MIN_COLS)))
  const clusterBlocks: BoxSpec[][] = []
  for (let start = 0; start < layout.clusters.length; start += perRow) {
    const chunk = layout.clusters.slice(start, start + perRow)
    const widths = splitWidth(width, chunk.length)
    clusterBlocks.push(
      chunk.map((cluster, i) => ({
        title: cluster.project,
        width: widths[i] as number,
        lines: boxLines(
          groups.filter((group) => group.room === 'floor' && group.cluster === cluster.project),
          widths[i] as number,
          undefined
        ),
      }))
    )
  }

  const heightOf = (block: readonly BoxSpec[]): number => 2 + Math.max(1, ...block.map((box) => box.lines.length))

  /** The boxes of one block as rows, cut to `cap` content lines each when asked. */
  const renderBlock = (block: readonly BoxSpec[], cap: number | undefined): Row[] => {
    const cut = block.map((box) => ({ ...box, lines: cap === undefined ? box.lines : keepLines(box.lines, cap) }))
    const contentLines = Math.max(1, ...cut.map((box) => box.lines.length))
    const border = (text: string): Span => ({ text, tone: 'muted' })
    const rows: Row[] = []
    const topRow: Span[] = []
    const bottomRow: Span[] = []
    for (const box of cut) {
      const title = fitCells(box.title, Math.max(0, box.width - 5), style)
      topRow.push(border(`${ch.tl}${ch.h} `), { text: title, bold: true }, border(` ${ch.h.repeat(Math.max(0, box.width - 5 - cellWidth(title)))}${ch.tr}`))
      bottomRow.push(border(`${ch.bl}${ch.h.repeat(box.width - 2)}${ch.br}`))
    }
    rows.push({ spans: topRow, morty: false })
    for (let i = 0; i < contentLines; i++) {
      const spans: Span[] = []
      let isMorty = false
      for (const box of cut) {
        const content = box.lines[i]
        const inner = box.width - 4
        spans.push(border(`${ch.v} `), ...(content?.spans ?? []), { text: ' '.repeat(Math.max(0, inner - (content?.width ?? 0))) }, border(` ${ch.v}`))
        if (content?.morty) isMorty = true
      }
      rows.push({ spans, morty: isMorty })
    }
    rows.push({ spans: bottomRow, morty: false })
    return rows
  }

  // --- Flow lines: the floor and the lobby ----------------------------------------------------------
  const flow = (prefix: string, elems: readonly Elem[]): Line[] => {
    const lines: Line[] = []
    let current = newLine()
    addTo(current, label(prefix, 'muted'))
    let placed = 0
    for (const elem of elems) {
      if (current.width + elem.width > width && placed > 0) {
        lines.push(current)
        current = newLine()
        addTo(current, label('  '))
        placed = 0
      }
      addTo(current, elem)
      placed += 1
    }
    lines.push(current)
    return lines
  }
  const dot = unicode ? '\u{00b7}' : '-'

  const floorElems: Elem[] = []
  const mortyOnFloor = morty !== undefined && (morty.room === 'floor' || morty.room === 'hall')
  if (mortyOnFloor) floorElems.push(mortyElem(' ') as Elem)
  if (bench.length > 0) floorElems.push(label(' bench'), ...bench)
  const floorLines = floorElems.length > 0 ? flow('Project floor:', floorElems) : []

  const lobbyElems: Elem[] = [label(' door')]
  const mortyInLobby = morty !== undefined && !mortyOnFloor && !TOP_ROOMS.includes(morty.room as RoomId)
  if (mortyInLobby) lobbyElems.push(label(` ${dot}`), mortyElem(' ') as Elem)
  if (board.length > 0) lobbyElems.push(label(` ${dot}`), ...board)
  const lobbyLines = flow('Lobby:', lobbyElems)

  // --- Fit to the rows ------------------------------------------------------------------------------
  const headerText = `Office ${dot} ${officeStatusLine(view, hidden)}`
  const header: Row = { spans: [{ text: headerText, bold: true }], morty: false }

  const clusterHeight = clusterBlocks.reduce((sum, block) => sum + heightOf(block), 0)
  const full = 1 + heightOf(top) + clusterHeight + floorLines.length + lobbyLines.length
  const rows: Row[] = [header]
  const drawn: Elem[] = []
  const collect = (lines: readonly Line[]): void => {
    for (const line of lines) drawn.push(...line.elems)
  }
  const lineRows = (lines: readonly Line[]): Row[] => lines.map((line) => ({ spans: line.spans, morty: line.morty }))
  // what a block puts on screen, to count its tokens: the cut lines, as renderBlock keeps them
  const collectBlock = (block: readonly BoxSpec[], cap: number | undefined): void => {
    for (const box of block) collect(cap === undefined ? box.lines : keepLines(box.lines, cap))
  }

  let withKey = false
  if (full <= maxRows) {
    rows.push(...renderBlock(top, undefined))
    collectBlock(top, undefined)
    for (const block of clusterBlocks) {
      rows.push(...renderBlock(block, undefined))
      collectBlock(block, undefined)
    }
    rows.push(...lineRows(floorLines), ...lineRows(lobbyLines))
    collect(floorLines)
    collect(lobbyLines)
    withKey = full + 1 <= maxRows
  } else {
    // Cut: the header, the lobby's first line and the "more" line stay; the rest shares what is left.
    let budget = maxRows - 3
    const fitBlock = (block: readonly BoxSpec[]): boolean => {
      const height = heightOf(block)
      if (height <= budget) {
        rows.push(...renderBlock(block, undefined))
        collectBlock(block, undefined)
        budget -= height
        return true
      }
      if (budget >= 3) {
        rows.push(...renderBlock(block, budget - 2))
        collectBlock(block, budget - 2)
        budget = 0
      }
      return false
    }
    if (fitBlock(top)) {
      for (const block of clusterBlocks) if (!fitBlock(block)) break
    }
    const floorTaken = floorLines.slice(0, Math.max(0, budget))
    rows.push(...lineRows(floorTaken))
    collect(floorTaken)
    budget -= floorTaken.length
    const lobbyTaken = lobbyLines.slice(0, 1 + Math.max(0, budget))
    rows.push(...lineRows(lobbyTaken))
    collect(lobbyTaken)
  }

  const tokens = drawn.filter((elem) => elem.id !== undefined)
  const elided = total - tokens.length
  if (full > maxRows && elided > 0) {
    rows.push({ spans: [{ text: `${unicode ? '\u{2026}' : '...'} ${elided} more ${elided === 1 ? 'agent' : 'agents'}: see the list (Tab)`, tone: 'muted' }], morty: false })
  }
  if (withKey) {
    const present = new Set(tokens.map((elem) => elem.state as AgentState))
    const states = AGENT_STATES.filter((state) => present.has(state))
    if (states.length > 0) {
      const text = `Key: ${states.map((state) => `${STATE_GLYPHS[state]} ${STATE_LABELS[state]}`).join('  ')}`
      rows.push({ spans: [{ text: fitCells(text, width, style), tone: 'muted' }], morty: false })
    }
  }

  const mortyIndex = rows.findIndex((row) => row.morty)
  return {
    rows: rows.map((row) => row.spans),
    shown: tokens.length,
    elided,
    order,
    ...(mortyIndex >= 0 ? { mortyRow: mortyIndex } : {}),
    typing: tokens.some((elem) => TYPING_STATES.has(elem.state as AgentState)),
  }
}
