// Who is walking where, and when (PLAN.md phase 3 §2.7). Pure: every time is passed in as `nowMs`
// (the renderer's clock, or a fixture's), so arrivals, departures and walks to a parent are unit
// tests, and reduced motion is just "nobody ever walks".

import { DESK_CLEAR_MS, HALL_X_PX, WALK_MAX_MS, WALK_PX_PER_S, type Point, type Rect } from './geometry.js'
import type { OfficeLayout } from './layout.js'
import { placementOf } from './layout.js'
import type { Direction } from './visual.js'

export type ActorPhase = 'seated' | 'arriving' | 'moving' | 'leaving' | 'departed'

export interface Actor {
  agentId: string
  phase: ActorPhase
  /** px waypoints of the current walk; the first is where it started. A single point when not walking. */
  path: Point[]
  startMs: number
  durationMs: number
  /** The desk a departed agent left, drawn (empty) until `untilMs`. */
  vacatedDesk?: { rect: Rect; untilMs: number }
}

export interface ActorOptions {
  nowMs: number
  reducedMotion: boolean
  /** The first world the page ever received: everyone is already in place, nobody walks in. */
  firstSnapshot: boolean
}

const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y

/** Down the hallway: from → (hall, from.y) → (hall, to.y) → to, with repeated points removed. */
export function route(from: Point, to: Point): Point[] {
  if (same(from, to)) return [from]
  const points = [from, { x: HALL_X_PX, y: from.y }, { x: HALL_X_PX, y: to.y }, to]
  return points.filter((point, index) => index === 0 || !same(point, points[index - 1] as Point))
}

function pathLength(path: readonly Point[]): number {
  let length = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  }
  return length
}

/** How long a walk takes: its length at walking speed, capped so a tall office never means a slow walk. */
export function durationFor(path: readonly Point[]): number {
  return Math.min(WALK_MAX_MS, Math.round((pathLength(path) / WALK_PX_PER_S) * 1000))
}

function facingOf(from: Point, to: Point): Direction {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx > 0 ? 'right' : 'left'
  if (dy !== 0) return dy > 0 ? 'down' : 'up'
  return 'down'
}

const isWalking = (phase: ActorPhase): boolean => phase === 'arriving' || phase === 'moving' || phase === 'leaving'

/** Where an actor is at `nowMs`, in whole px. A walker is interpolated along its path (linearly, in
 * proportion to segment length); anyone else is at their placement's seat. */
export function positionAt(
  actor: Actor,
  officeLayout: OfficeLayout,
  nowMs: number
): { point: Point; walking: boolean; facing: Direction } {
  const last = actor.path[actor.path.length - 1] as Point
  if (!isWalking(actor.phase)) {
    const seat = placementOf(officeLayout, actor.agentId)?.seat ?? last
    return { point: seat, walking: false, facing: 'down' }
  }
  const elapsed = nowMs - actor.startMs
  if (actor.durationMs <= 0 || elapsed >= actor.durationMs) {
    const before = actor.path[actor.path.length - 2] ?? last
    return { point: last, walking: false, facing: facingOf(before, last) }
  }
  let remaining = Math.max(0, elapsed / actor.durationMs) * pathLength(actor.path)
  for (let i = 1; i < actor.path.length; i++) {
    const a = actor.path[i - 1] as Point
    const b = actor.path[i] as Point
    const segment = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    if (remaining <= segment && segment > 0) {
      const f = remaining / segment
      return {
        point: { x: Math.round(a.x + (b.x - a.x) * f), y: Math.round(a.y + (b.y - a.y) * f) },
        walking: true,
        facing: facingOf(a, b),
      }
    }
    remaining -= segment
  }
  return { point: last, walking: false, facing: 'down' }
}

function walk(agentId: string, phase: 'arriving' | 'moving' | 'leaving', path: Point[], nowMs: number): Actor {
  return { agentId, phase, path, startMs: nowMs, durationMs: durationFor(path) }
}

function standing(agentId: string, phase: 'seated' | 'departed', point: Point): Actor {
  return { agentId, phase, path: [point], startMs: 0, durationMs: 0 }
}

/** The slot an agent holds, as layout() remembers it: a moved room, desk or stool changes the key,
 * a mere shift of a whole band (a top room gaining a row) does not. */
function slotKey(officeLayout: OfficeLayout, agentId: string): string {
  const placement = placementOf(officeLayout, agentId)
  const memo = officeLayout.memo
  return `${placement?.kind}|${placement?.room}|${memo.deskSlots[agentId] ?? memo.stoolSlots[agentId] ?? ''}`
}

function keepDesk(actor: Actor, nowMs: number): Actor['vacatedDesk'] {
  return actor.vacatedDesk && actor.vacatedDesk.untilMs > nowMs ? actor.vacatedDesk : undefined
}

/** Brings the actors up to date with a new layout: newcomers walk in from the door, agents that
 * left for the board walk out (their desk is drawn empty for a while), agents whose seat moved walk
 * there, and everyone else stays put. Agents no longer in the world are dropped. */
export function reconcileActors(
  prev: ReadonlyMap<string, Actor>,
  prevLayout: OfficeLayout | undefined,
  next: OfficeLayout,
  opts: ActorOptions
): Map<string, Actor> {
  const { nowMs, reducedMotion, firstSnapshot } = opts
  const result = new Map<string, Actor>()

  for (const placement of next.placements) {
    const id = placement.agentId
    const before = prev.get(id)
    const toBoard = placement.kind === 'board'
    const settled = (): Actor => standing(id, toBoard ? 'departed' : 'seated', placement.seat)

    if (!before || before.phase === 'departed' || (before.phase === 'leaving' && !toBoard)) {
      // A newcomer, or someone who left and came back.
      if (before?.phase === 'departed' && toBoard) {
        result.set(id, { ...before, path: [placement.seat], vacatedDesk: keepDesk(before, nowMs) })
      } else if (toBoard || firstSnapshot || reducedMotion) {
        result.set(id, settled())
      } else {
        result.set(id, walk(id, 'arriving', route(next.door, placement.seat), nowMs))
      }
      continue
    }

    if (toBoard) {
      if (before.phase === 'leaving') {
        const done = reducedMotion || nowMs >= before.startMs + before.durationMs
        result.set(id, done ? { ...before, phase: 'departed', path: [placement.seat], vacatedDesk: keepDesk(before, nowMs) } : { ...before, vacatedDesk: keepDesk(before, nowMs) })
        continue
      }
      // Seated, arriving or moving, and now on the board: walk out from wherever it is.
      const from = prevLayout ? positionAt(before, prevLayout, nowMs).point : placement.seat
      const oldDesk = prevLayout?.desks.find((desk) => desk.ownerId === id)
      const path = route(from, next.door)
      const duration = reducedMotion ? 0 : durationFor(path)
      const vacatedDesk = oldDesk ? { rect: oldDesk.rect, untilMs: nowMs + duration + DESK_CLEAR_MS } : undefined
      result.set(
        id,
        reducedMotion
          ? { ...standing(id, 'departed', placement.seat), vacatedDesk }
          : { ...walk(id, 'leaving', path, nowMs), vacatedDesk }
      )
      continue
    }

    if (isWalking(before.phase)) {
      const end = before.path[before.path.length - 1] as Point
      // Reduced motion (which can be switched on mid-walk) ends every walk where it stands.
      const walkDone = reducedMotion || nowMs >= before.startMs + before.durationMs
      if (same(end, placement.seat)) {
        result.set(id, walkDone ? standing(id, 'seated', placement.seat) : before)
      } else if (reducedMotion) {
        result.set(id, standing(id, 'seated', placement.seat))
      } else {
        // Its destination moved mid-walk: carry on from where it is now.
        const from = prevLayout ? positionAt(before, prevLayout, nowMs).point : end
        result.set(id, walk(id, 'moving', route(from, placement.seat), nowMs))
      }
      continue
    }

    // Seated before, seated now: only a change of slot (a new room, desk or stool) is a walk.
    const oldPlacement = prevLayout ? placementOf(prevLayout, id) : undefined
    const movedSlot = prevLayout !== undefined && slotKey(prevLayout, id) !== slotKey(next, id)
    if (!oldPlacement || !movedSlot || reducedMotion || same(oldPlacement.seat, placement.seat)) {
      result.set(id, same(before.path[0] as Point, placement.seat) ? before : standing(id, 'seated', placement.seat))
    } else {
      result.set(id, walk(id, 'moving', route(oldPlacement.seat, placement.seat), nowMs))
    }
  }

  return result
}
