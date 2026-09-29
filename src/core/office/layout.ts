// layout(world): the pure placement of every agent (PLAN.md phase 3 §2.4). No drawing, no clock:
// a World (and optionally the previous layout, so seats stay put) goes in, rooms, desks and one
// placement per agent come out. Tests check placement here, without a browser.
//
// A desk cell is 4 tiles wide and 3 tall: row 0 is headroom for the speech bubble, row 1 is the
// character, row 2 is the desk; the fourth column holds three helper stools. Seated sprites keep
// their content in the top 16 rows of the 16x24 frame, so a seat point is "24 px below the top of
// the tile the character occupies", and that is what `seat` means throughout.

import type { Agent, World } from '../types.js'
import {
  BOARD_COLS,
  BOARD_X,
  CELL_COLS,
  CELL_ROWS,
  CLUSTER_CELLS_PER_ROW,
  CLUSTER_XS,
  FLOOR_COLS,
  FLOOR_X,
  OFFICE_COLS,
  STOOLS_PER_DESK,
  TILE,
  TOP_CELLS_PER_ROW,
  TOP_ROOMS,
  TOP_ROOM_COLS,
  TOP_WALL_ROWS,
  type Point,
  type Rect,
} from './geometry.js'
import { assignRoom, helperAnchor, type RoomId } from './roles.js'

export type SeatKind = 'desk' | 'stool' | 'bench' | 'board'

export interface RoomBox {
  id: RoomId
  name: string
  /** Tiles. */
  rect: Rect
}

export interface ClusterBox {
  project: string
  /** Tiles. */
  rect: Rect
  signRect: Rect
}

export interface DeskBox {
  id: string
  room: RoomId
  cluster?: string
  /** The whole 4x3-tile cell, in tiles. */
  rect: Rect
  ownerId: string
  /** Where the owner sits, in px. */
  seat: Point
}

export interface Placement {
  agentId: string
  room: RoomId
  kind: SeatKind
  /** A desk seat: its own desk. A stool: the anchor's desk. */
  deskId?: string
  /** A stool or bench seat: the ancestor the agent sits by. */
  anchorId?: string
  /** Index within its desk, stool, bench or board group. */
  slot: number
  /** In px. */
  seat: Point
  /** The hit box, in px: the desk's three columns (bubble headroom included), a stool tile, a bench cell or a board tag. */
  boxPx: Rect
}

export interface LayoutMemo {
  /** agentId -> `${room}|${cluster}|${index}`: the desk slot the agent holds. */
  deskSlots: Record<string, string>
  /** agentId -> `${anchorId}|${stoolIndex}` for a stool, or `bench|${index}` for a bench seat. */
  stoolSlots: Record<string, string>
  clusterOrder: string[]
  boardOrder: string[]
}

export interface OfficeLayout {
  cols: number
  rows: number
  rooms: RoomBox[]
  clusters: ClusterBox[]
  desks: DeskBox[]
  /** Reading order, which is also the overlay's Tab order. Exactly one per agent in the world. */
  placements: Placement[]
  /** Where every arrival enters and every departure leaves, in px. */
  door: Point
  memo: LayoutMemo
}

const BENCH_COLS = FLOOR_COLS - 2
const EMPTY_FLOOR_ROWS = 4
const NO_PROJECT = '—'
const TOP_ROOM_ORDER = ['manager', 'planning', 'review'] as const
type TopRoomId = (typeof TOP_ROOM_ORDER)[number]

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Hands out slot indices: an id keeps its previous index when it still can, everyone else takes
 * the lowest free one in id order. An index past `capacity` comes back undefined (overflow). */
function assignSlots(
  ids: readonly string[],
  previousIndex: (id: string) => number | undefined,
  capacity = Number.POSITIVE_INFINITY
): Map<string, number | undefined> {
  const result = new Map<string, number | undefined>()
  const taken = new Set<number>()
  for (const id of ids) {
    const index = previousIndex(id)
    if (index !== undefined && index < capacity && !taken.has(index)) {
      taken.add(index)
      result.set(id, index)
    }
  }
  for (const id of ids) {
    if (result.has(id)) continue
    let index = 0
    while (taken.has(index)) index++
    if (index >= capacity) {
      result.set(id, undefined)
    } else {
      taken.add(index)
      result.set(id, index)
    }
  }
  return result
}

interface ParsedDeskSlot {
  room: string
  cluster: string
  index: number
}

function parseDeskSlot(text: string | undefined): ParsedDeskSlot | undefined {
  if (text === undefined) return undefined
  const first = text.indexOf('|')
  const last = text.lastIndexOf('|')
  if (first < 0 || last <= first) return undefined
  const index = Number(text.slice(last + 1))
  return Number.isInteger(index) ? { room: text.slice(0, first), cluster: text.slice(first + 1, last), index } : undefined
}

function parseStoolSlot(text: string | undefined): { anchor: string; index: number } | undefined {
  if (text === undefined) return undefined
  const cut = text.lastIndexOf('|')
  if (cut < 0) return undefined
  const index = Number(text.slice(cut + 1))
  return Number.isInteger(index) ? { anchor: text.slice(0, cut), index } : undefined
}

const slotRows = (slots: number): number => Math.max(1, Math.ceil(slots / CLUSTER_CELLS_PER_ROW))
const slotCount = (indices: Iterable<number | undefined>): number => {
  let max = -1
  for (const index of indices) if (index !== undefined && index > max) max = index
  return max + 1
}

function cellRect(cx: number, cy: number): Rect {
  return { x: cx, y: cy, w: CELL_COLS, h: CELL_ROWS }
}

function deskSeat(cx: number, cy: number): Point {
  return { x: (cx + 1) * TILE + TILE / 2, y: (cy + CELL_ROWS - 1) * TILE + TILE / 2 }
}

function deskBoxPx(cx: number, cy: number): Rect {
  return { x: cx * TILE, y: cy * TILE, w: (CELL_COLS - 1) * TILE, h: CELL_ROWS * TILE }
}

function stoolSeat(cx: number, cy: number, index: number): Point {
  return { x: (cx + CELL_COLS - 1) * TILE + TILE / 2, y: (cy + index) * TILE + 24 }
}

function stoolBoxPx(cx: number, cy: number, index: number): Rect {
  return { x: (cx + CELL_COLS - 1) * TILE, y: (cy + index) * TILE, w: TILE, h: TILE }
}

export function layout(world: World, prev?: OfficeLayout): OfficeLayout {
  const memo = prev?.memo
  const ids = Object.keys(world.agents).sort(byId)
  const agentOf = (id: string): Agent => world.agents[id] as Agent

  // 1. Who belongs where.
  const topMembers: Record<TopRoomId, string[]> = { manager: [], planning: [], review: [] }
  const floorByProject = new Map<string, string[]>()
  const helpers: { id: string; anchor: string }[] = []
  const boardIds: string[] = []
  for (const id of ids) {
    const agent = agentOf(id)
    const assignment = assignRoom(agent, world)
    if (assignment === 'manager' || assignment === 'planning' || assignment === 'review') {
      topMembers[assignment].push(id)
    } else if (assignment === 'floor') {
      const key = agent.project === '' ? NO_PROJECT : agent.project
      floorByProject.set(key, [...(floorByProject.get(key) ?? []), id])
    } else if (assignment === 'helper') {
      helpers.push({ id, anchor: helperAnchor(agent, world) as string })
    } else {
      boardIds.push(id)
    }
  }

  // 2. Slots: desks by room and cluster, then stools, the bench and the board.
  const deskSlots: Record<string, string> = {}
  const previousDeskIndex = (id: string, room: string, cluster: string): number | undefined => {
    const parsed = parseDeskSlot(memo?.deskSlots[id])
    return parsed && parsed.room === room && parsed.cluster === cluster ? parsed.index : undefined
  }
  const slotsFor = (members: readonly string[], room: string, cluster: string): Map<string, number | undefined> => {
    const slots = assignSlots(members, (id) => previousDeskIndex(id, room, cluster))
    for (const [id, index] of slots) deskSlots[id] = `${room}|${cluster}|${index as number}`
    return slots
  }

  const topSlots = {} as Record<TopRoomId, Map<string, number | undefined>>
  for (const room of TOP_ROOM_ORDER) topSlots[room] = slotsFor(topMembers[room], room, '')

  const liveProjects = [...floorByProject.keys()].sort(byId)
  const clusterOrder = [
    ...(memo?.clusterOrder ?? []).filter((project) => floorByProject.has(project)),
    ...liveProjects.filter((project) => !(memo?.clusterOrder ?? []).includes(project)),
  ]
  const clusterSlots = new Map<string, Map<string, number | undefined>>()
  for (const project of clusterOrder) clusterSlots.set(project, slotsFor(floorByProject.get(project) ?? [], 'floor', project))

  const stoolSlots: Record<string, string> = {}
  const stoolIndexOf = new Map<string, number>()
  const anchoredTo = new Map<string, string[]>()
  for (const helper of helpers) anchoredTo.set(helper.anchor, [...(anchoredTo.get(helper.anchor) ?? []), helper.id])
  const benchCandidates: string[] = []
  for (const [anchor, members] of anchoredTo) {
    const slots = assignSlots(
      members,
      (id) => {
        const parsed = parseStoolSlot(memo?.stoolSlots[id])
        return parsed && parsed.anchor === anchor ? parsed.index : undefined
      },
      STOOLS_PER_DESK
    )
    for (const [id, index] of slots) {
      if (index === undefined) {
        benchCandidates.push(id)
      } else {
        stoolIndexOf.set(id, index)
        stoolSlots[id] = `${anchor}|${index}`
      }
    }
  }
  benchCandidates.sort(byId)
  const benchSlots = assignSlots(benchCandidates, (id) => {
    const parsed = parseStoolSlot(memo?.stoolSlots[id])
    return parsed && parsed.anchor === 'bench' ? parsed.index : undefined
  })
  for (const [id, index] of benchSlots) stoolSlots[id] = `bench|${index as number}`
  const benchCount = slotCount(benchSlots.values())

  const boardOrder = [
    ...(memo?.boardOrder ?? []).filter((id) => boardIds.includes(id)),
    ...boardIds.filter((id) => !(memo?.boardOrder ?? []).includes(id)),
  ]

  // 3. Geometry, top to bottom.
  const topRows = Math.max(1, ...TOP_ROOM_ORDER.map((room) => slotRows(slotCount(topSlots[room].values()))))
  const topHeight = TOP_WALL_ROWS + CELL_ROWS * topRows
  const floorTop = topHeight + 1

  const desks: DeskBox[] = []
  const deskOf = new Map<string, DeskBox>()
  const placements = new Map<string, Placement>()
  const addDesk = (ownerId: string, room: RoomId, cluster: string | undefined, index: number, cx: number, cy: number): void => {
    const desk: DeskBox = { id: `desk:${ownerId}`, room, cluster, rect: cellRect(cx, cy), ownerId, seat: deskSeat(cx, cy) }
    desks.push(desk)
    deskOf.set(ownerId, desk)
    placements.set(ownerId, {
      agentId: ownerId,
      room,
      kind: 'desk',
      deskId: desk.id,
      slot: index,
      seat: desk.seat,
      boxPx: deskBoxPx(cx, cy),
    })
  }

  const rooms: RoomBox[] = []
  for (const room of TOP_ROOMS) {
    rooms.push({ id: room.id, name: room.name, rect: { x: room.x, y: 0, w: TOP_ROOM_COLS, h: topHeight } })
    for (const [id, index] of topSlots[room.id]) {
      const slot = index as number
      addDesk(
        id,
        room.id,
        undefined,
        slot,
        room.x + 1 + (slot % TOP_CELLS_PER_ROW) * CELL_COLS,
        TOP_WALL_ROWS + Math.floor(slot / TOP_CELLS_PER_ROW) * CELL_ROWS
      )
    }
  }

  const clusters: ClusterBox[] = []
  let cursor = floorTop
  const perRow = CLUSTER_XS.length
  for (let start = 0; start < clusterOrder.length; start += perRow) {
    const chunk = clusterOrder.slice(start, start + perRow)
    const rowsOf = (project: string): number => slotRows(slotCount(clusterSlots.get(project)?.values() ?? []))
    const chunkRows = Math.max(...chunk.map(rowsOf))
    chunk.forEach((project, column) => {
      const x = CLUSTER_XS[column] as number
      clusters.push({
        project,
        rect: { x, y: cursor, w: CLUSTER_CELLS_PER_ROW * CELL_COLS, h: 1 + CELL_ROWS * rowsOf(project) },
        signRect: { x, y: cursor, w: CLUSTER_CELLS_PER_ROW * CELL_COLS, h: 1 },
      })
      for (const [id, index] of clusterSlots.get(project) ?? []) {
        const slot = index as number
        addDesk(
          id,
          'floor',
          project,
          slot,
          x + (slot % CLUSTER_CELLS_PER_ROW) * CELL_COLS,
          cursor + 1 + Math.floor(slot / CLUSTER_CELLS_PER_ROW) * CELL_ROWS
        )
      }
    })
    cursor += 1 + CELL_ROWS * chunkRows + 1
  }
  if (clusterOrder.length === 0) cursor += EMPTY_FLOOR_ROWS

  const benchTop = cursor
  const benchRows = benchCount === 0 ? 0 : 2 * Math.ceil(benchCount / BENCH_COLS)
  const floorHeight = benchTop + benchRows - floorTop
  rooms.push({ id: 'floor', name: 'Project floor', rect: { x: FLOOR_X, y: floorTop, w: FLOOR_COLS, h: floorHeight } })

  const lobbyTop = floorTop + floorHeight + 1
  const boardRows = Math.max(1, Math.ceil(boardOrder.length / BOARD_COLS))
  const lobbyHeight = boardRows + 1
  rooms.push({ id: 'lobby', name: 'Lobby', rect: { x: 0, y: lobbyTop, w: OFFICE_COLS, h: lobbyHeight } })
  const rows = lobbyTop + lobbyHeight + 1
  const door: Point = { x: 2 * TILE, y: (rows - 1) * TILE + TILE / 2 }

  // 4. Helpers, bench and board go where their desk (or the lobby) already is.
  for (const helper of helpers) {
    const anchorDesk = deskOf.get(helper.anchor) as DeskBox
    const cx = anchorDesk.rect.x
    const cy = anchorDesk.rect.y
    const stool = stoolIndexOf.get(helper.id)
    if (stool !== undefined) {
      placements.set(helper.id, {
        agentId: helper.id,
        room: anchorDesk.room,
        kind: 'stool',
        deskId: anchorDesk.id,
        anchorId: helper.anchor,
        slot: stool,
        seat: stoolSeat(cx, cy, stool),
        boxPx: stoolBoxPx(cx, cy, stool),
      })
    } else {
      const slot = benchSlots.get(helper.id) as number
      const band = Math.floor(slot / BENCH_COLS)
      const column = slot % BENCH_COLS
      const headroomRow = benchTop + 2 * band
      placements.set(helper.id, {
        agentId: helper.id,
        room: 'floor',
        kind: 'bench',
        anchorId: helper.anchor,
        slot,
        seat: { x: (FLOOR_X + 1 + column) * TILE + TILE / 2, y: (headroomRow + 1) * TILE + 24 },
        boxPx: { x: (FLOOR_X + 1 + column) * TILE, y: headroomRow * TILE, w: TILE, h: 2 * TILE },
      })
    }
  }
  boardOrder.forEach((id, index) => {
    const column = index % BOARD_COLS
    const row = lobbyTop + Math.floor(index / BOARD_COLS)
    placements.set(id, {
      agentId: id,
      room: 'lobby',
      kind: 'board',
      slot: index,
      seat: { x: (BOARD_X + column) * TILE + TILE / 2, y: row * TILE + TILE / 2 },
      boxPx: { x: (BOARD_X + column) * TILE, y: row * TILE, w: TILE, h: TILE },
    })
  })

  // 5. Reading order: each room's desks in slot order, every desk followed by its stools, then the
  // bench, then the board.
  const ordered: Placement[] = []
  const bySlot = (a: Placement, b: Placement): number => a.slot - b.slot
  const stoolsOf = (deskId: string): Placement[] =>
    [...placements.values()].filter((p) => p.kind === 'stool' && p.deskId === deskId).sort(bySlot)
  const pushDeskGroup = (desk: DeskBox): void => {
    ordered.push(placements.get(desk.ownerId) as Placement, ...stoolsOf(desk.id))
  }
  const desksInSlotOrder = (room: RoomId, cluster?: string): DeskBox[] =>
    desks
      .filter((desk) => desk.room === room && desk.cluster === cluster)
      .sort((a, b) => (placements.get(a.ownerId) as Placement).slot - (placements.get(b.ownerId) as Placement).slot)
  for (const room of TOP_ROOM_ORDER) desksInSlotOrder(room).forEach(pushDeskGroup)
  for (const cluster of clusters) desksInSlotOrder('floor', cluster.project).forEach(pushDeskGroup)
  ordered.push(...[...placements.values()].filter((p) => p.kind === 'bench').sort(bySlot))
  ordered.push(...[...placements.values()].filter((p) => p.kind === 'board').sort(bySlot))

  return {
    cols: OFFICE_COLS,
    rows,
    rooms,
    clusters,
    desks,
    placements: ordered,
    door,
    memo: { deskSlots, stoolSlots, clusterOrder, boardOrder },
  }
}

export function placementOf(officeLayout: OfficeLayout, agentId: string): Placement | undefined {
  return officeLayout.placements.find((placement) => placement.agentId === agentId)
}
