import { describe, expect, test } from 'vitest'
import { arriveWorlds, departWorlds, worldSessionId as s, worldSubagentId as sub } from '../scripts/world-fixture-lib.js'
import { DESK_CLEAR_MS, HALL_X_PX, WALK_MAX_MS, WALK_PX_PER_S, rectContains, scaleRect, TILE } from '../src/core/office/geometry.js'
import { layout, placementOf, type OfficeLayout } from '../src/core/office/layout.js'
import { durationFor, positionAt, reconcileActors, route, type Actor } from '../src/core/office/motion.js'
import type { Agent, World } from '../src/core/types.js'
import { emptyWorld, ensureAgent, updateAgent } from '../src/core/world.js'

const MOVE = { reducedMotion: false, firstSnapshot: false }
const FIRST = { reducedMotion: false, firstSnapshot: true }

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

const actor = (actors: ReadonlyMap<string, Actor>, id: string): Actor => must(actors.get(id), `actor ${id}`)

/** Everyone in place: the state after the very first snapshot. */
function settle(world: World): { l: OfficeLayout; actors: Map<string, Actor> } {
  const l = layout(world)
  return { l, actors: reconcileActors(new Map(), undefined, l, { nowMs: 0, ...FIRST }) }
}

describe('route and duration', () => {
  test('a route goes down the hallway and has no repeated points', () => {
    const path = route({ x: 32, y: 200 }, { x: 100, y: 60 })
    expect(path).toEqual([
      { x: 32, y: 200 },
      { x: HALL_X_PX, y: 200 },
      { x: HALL_X_PX, y: 60 },
      { x: 100, y: 60 },
    ])
  })

  test('starting or ending in the hallway drops the redundant points', () => {
    expect(route({ x: HALL_X_PX, y: 10 }, { x: 50, y: 10 })).toEqual([
      { x: HALL_X_PX, y: 10 },
      { x: 50, y: 10 },
    ])
  })

  test('going nowhere is not a walk, even from outside the hallway', () => {
    expect(route({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([{ x: 5, y: 5 }])
  })

  test('duration is the length at walking speed, and never more than the cap', () => {
    expect(durationFor([{ x: 0, y: 0 }, { x: WALK_PX_PER_S, y: 0 }])).toBe(1000)
    expect(durationFor([{ x: 0, y: 0 }])).toBe(0)
    expect(durationFor([{ x: 0, y: 0 }, { x: 100_000, y: 0 }])).toBe(WALK_MAX_MS)
  })
})

describe('positionAt', () => {
  const l = layout(arriveWorlds().before)
  const path = route({ x: 32, y: 200 }, { x: 100, y: 60 })
  const walker: Actor = { agentId: s(1), phase: 'arriving', path, startMs: 1000, durationMs: durationFor(path) }

  test('a walker is at the start at startMs and at the end when the time is up', () => {
    expect(positionAt(walker, l, 1000).point).toEqual(path[0])
    const end = positionAt(walker, l, 1000 + walker.durationMs)
    expect(end.point).toEqual(path[path.length - 1])
    expect(end.walking).toBe(false)
    expect(positionAt(walker, l, 999_999).point).toEqual(path[path.length - 1])
  })

  test('the walk moves steadily along the path, in whole px', () => {
    const stepMs = 50
    const maxStep = Math.ceil((WALK_PX_PER_S * stepMs) / 1000) + 2
    let previous = positionAt(walker, l, 1000).point
    let total = 0
    for (let t = stepMs; t <= walker.durationMs; t += stepMs) {
      const { point } = positionAt(walker, l, 1000 + t)
      expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true)
      const step = Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y)
      expect(step).toBeGreaterThan(0)
      expect(step).toBeLessThanOrEqual(maxStep)
      total += step
      previous = point
    }
    // The samples add up to (nearly) the whole path: it neither stalls nor jumps.
    const length = Math.abs(path[1]!.x - path[0]!.x) + Math.abs(path[2]!.y - path[1]!.y) + Math.abs(path[3]!.x - path[2]!.x)
    expect(total).toBeLessThanOrEqual(length)
    expect(total).toBeGreaterThan(length - maxStep * 2)
  })

  test('the character faces the way it is going', () => {
    expect(positionAt(walker, l, 1000).facing).toBe('left')
    const middle = positionAt(walker, l, 1000 + Math.round(walker.durationMs * 0.5))
    expect(['up', 'right', 'left']).toContain(middle.facing)
    expect(positionAt(walker, l, 1000 + walker.durationMs - 10).facing).toBe('right')
  })

  test('someone seated is at the seat of their placement in whatever layout is current', () => {
    const seated: Actor = { agentId: s(1), phase: 'seated', path: [{ x: 1, y: 1 }], startMs: 0, durationMs: 0 }
    expect(positionAt(seated, l, 5).point).toEqual(placementOf(l, s(1))?.seat)
  })
})

describe('the first snapshot', () => {
  test('puts everyone in place, and the departed on the board, and nobody walks', () => {
    const { actors } = settle(departWorlds().after)
    expect(actor(actors, s(1)).phase).toBe('seated')
    expect(actor(actors, s(2)).phase).toBe('departed')
  })
})

describe('arrivals', () => {
  const { before, after } = arriveWorlds()
  const first = settle(before)
  const l2 = layout(after, first.l)
  const actors = reconcileActors(first.actors, first.l, l2, { nowMs: 1000, ...MOVE })

  test('a new builder walks in from the door to its desk', () => {
    const newcomer = actor(actors, s(2))
    expect(newcomer.phase).toBe('arriving')
    expect(newcomer.path[0]).toEqual(l2.door)
    expect(newcomer.path[newcomer.path.length - 1]).toEqual(placementOf(l2, s(2))?.seat)
    expect(positionAt(newcomer, l2, 1000).point).toEqual(l2.door)
    const done = positionAt(newcomer, l2, 1000 + newcomer.durationMs)
    expect(done.point).toEqual(placementOf(l2, s(2))?.seat)
  })

  test('a subagent walks to the stool beside its parent, not to a desk of its own', () => {
    const helper = actor(actors, sub(1))
    const helperPlacement = must(placementOf(l2, sub(1)), 'placement')
    expect(helperPlacement.kind).toBe('stool')
    expect(helper.phase).toBe('arriving')
    expect(helper.path[helper.path.length - 1]).toEqual(helperPlacement.seat)
    const parentDesk = must(l2.desks.find((desk) => desk.ownerId === s(1)), 'parent desk')
    expect(rectContains(scaleRect(parentDesk.rect, TILE), { x: helperPlacement.seat.x, y: helperPlacement.seat.y - 8 })).toBe(true)
  })

  test('the parent, already in place, stays seated (only its pose changes)', () => {
    expect(actor(actors, s(1)).phase).toBe('seated')
    expect(actors.get(s(1))).toBe(first.actors.get(s(1)))
  })

  test('a walker that has arrived is seated on the next update', () => {
    const later = 1000 + actor(actors, s(2)).durationMs + 1
    const again = reconcileActors(actors, l2, l2, { nowMs: later, ...MOVE })
    expect(actor(again, s(2)).phase).toBe('seated')
  })

  test('a walker still on the way keeps walking when nothing else changed', () => {
    const again = reconcileActors(actors, l2, l2, { nowMs: 1100, ...MOVE })
    expect(again.get(s(2))).toBe(actors.get(s(2)))
  })

  test('reduced motion: nobody walks in, everyone is simply there', () => {
    const still = reconcileActors(first.actors, first.l, l2, { nowMs: 1000, reducedMotion: true, firstSnapshot: false })
    for (const a of still.values()) expect(['seated', 'departed']).toContain(a.phase)
    expect(actor(still, s(2)).phase).toBe('seated')
  })
})

describe('departures', () => {
  const { before, after } = departWorlds()
  const first = settle(before)
  const l2 = layout(after, first.l)
  const actors = reconcileActors(first.actors, first.l, l2, { nowMs: 1000, ...MOVE })
  const oldDesk = must(first.l.desks.find((desk) => desk.ownerId === s(2)), 'old desk')

  test('an agent that finished walks out from its desk to the door', () => {
    const leaver = actor(actors, s(2))
    expect(leaver.phase).toBe('leaving')
    expect(leaver.path[0]).toEqual(placementOf(first.l, s(2))?.seat)
    expect(leaver.path[leaver.path.length - 1]).toEqual(first.l.door)
  })

  test('its desk is drawn empty until the walk is over and the clear delay has passed', () => {
    const leaver = actor(actors, s(2))
    expect(leaver.vacatedDesk).toEqual({ rect: oldDesk.rect, untilMs: 1000 + leaver.durationMs + DESK_CLEAR_MS })
  })

  test('after the walk it is departed, on the board, and the desk lingers', () => {
    const leaver = actor(actors, s(2))
    const later = reconcileActors(actors, l2, l2, { nowMs: 1000 + leaver.durationMs + 1, ...MOVE })
    expect(actor(later, s(2)).phase).toBe('departed')
    expect(actor(later, s(2)).vacatedDesk).toBeDefined()
    expect(positionAt(actor(later, s(2)), l2, 0).point).toEqual(placementOf(l2, s(2))?.seat)
  })

  test('the vacated desk is gone once the delay has passed', () => {
    const leaver = actor(actors, s(2))
    const until = must(leaver.vacatedDesk, 'desk').untilMs
    const departed = reconcileActors(actors, l2, l2, { nowMs: 1000 + leaver.durationMs + 1, ...MOVE })
    const cleared = reconcileActors(departed, l2, l2, { nowMs: until + 1, ...MOVE })
    expect(actor(cleared, s(2)).vacatedDesk).toBeUndefined()
    expect(actor(cleared, s(2)).phase).toBe('departed')
  })

  test('the agent that stayed is untouched', () => {
    expect(actors.get(s(1))).toBe(first.actors.get(s(1)))
  })

  test('reduced motion: departed at once, but the empty desk still lingers', () => {
    const still = reconcileActors(first.actors, first.l, l2, { nowMs: 1000, reducedMotion: true, firstSnapshot: false })
    expect(actor(still, s(2)).phase).toBe('departed')
    expect(actor(still, s(2)).vacatedDesk?.untilMs).toBe(1000 + DESK_CLEAR_MS)
  })

  test('an agent that is on the board when first seen does not walk in only to walk out', () => {
    const board = layout(after)
    const fresh = reconcileActors(new Map(), undefined, board, { nowMs: 5, ...MOVE })
    expect(actor(fresh, s(2)).phase).toBe('departed')
    expect(actor(fresh, s(1)).phase).toBe('arriving')
  })

  test('an agent that left and comes back walks in again', () => {
    const later = reconcileActors(actors, l2, l2, { nowMs: 1000 + actor(actors, s(2)).durationMs + 1, ...MOVE })
    const back = layout(before, l2)
    const returning = reconcileActors(later, l2, back, { nowMs: 20_000, ...MOVE })
    expect(actor(returning, s(2)).phase).toBe('arriving')
  })
})

describe('other changes', () => {
  const T = '2026-01-15T10:30:00.000Z'
  function worldOf(...patches: (Partial<Agent> & { id: string })[]): World {
    let world = emptyWorld(T, '/root')
    for (const patch of patches) {
      world = ensureAgent(world, patch.id, T)
      world = updateAgent(world, patch.id, (agent) => ({ ...agent, project: 'demo', state: 'thinking', ...patch }))
    }
    return world
  }

  test('an agent removed from the world is dropped', () => {
    const first = settle(worldOf({ id: 'a' }, { id: 'b' }))
    const l2 = layout(worldOf({ id: 'a' }), first.l)
    const actors = reconcileActors(first.actors, first.l, l2, { nowMs: 10, ...MOVE })
    expect([...actors.keys()]).toEqual(['a'])
  })

  test('an agent that changes room walks to its new seat', () => {
    const first = settle(worldOf({ id: 'a' }))
    const l2 = layout(worldOf({ id: 'a', role: 'reviewer' }), first.l)
    const actors = reconcileActors(first.actors, first.l, l2, { nowMs: 10, ...MOVE })
    const mover = actor(actors, 'a')
    expect(mover.phase).toBe('moving')
    expect(mover.path[0]).toEqual(placementOf(first.l, 'a')?.seat)
    expect(mover.path[mover.path.length - 1]).toEqual(placementOf(l2, 'a')?.seat)
  })

  test('reduced motion: a room change is a jump, not a walk', () => {
    const first = settle(worldOf({ id: 'a' }))
    const l2 = layout(worldOf({ id: 'a', role: 'reviewer' }), first.l)
    const actors = reconcileActors(first.actors, first.l, l2, { nowMs: 10, reducedMotion: true, firstSnapshot: false })
    expect(actor(actors, 'a').phase).toBe('seated')
  })

  test('a whole band shifting down (a top room gaining a row) is not a crowd walk', () => {
    const two = worldOf({ id: 'b' }, { id: 'p1', role: 'planner' }, { id: 'p2', role: 'planner' })
    const three = worldOf({ id: 'b' }, { id: 'p1', role: 'planner' }, { id: 'p2', role: 'planner' }, { id: 'p3', role: 'planner' })
    const first = settle(two)
    const l2 = layout(three, first.l)
    expect(placementOf(l2, 'b')?.seat.y).not.toBe(placementOf(first.l, 'b')?.seat.y)
    const actors = reconcileActors(first.actors, first.l, l2, { nowMs: 10, ...MOVE })
    expect(actor(actors, 'b').phase).toBe('seated')
    expect(positionAt(actor(actors, 'b'), l2, 10).point).toEqual(placementOf(l2, 'b')?.seat)
    expect(actor(actors, 'p3').phase).toBe('arriving')
  })

  test('a walker whose destination moves mid-walk carries on from where it is', () => {
    const first = settle(worldOf({ id: 'a' }))
    const grown = layout(worldOf({ id: 'a' }, { id: 'n', role: 'reviewer' }), first.l)
    const walking = reconcileActors(first.actors, first.l, grown, { nowMs: 0, ...MOVE })
    const walker = actor(walking, 'n')
    expect(walker.phase).toBe('arriving')
    // Meanwhile the newcomer becomes a planner: a different room, a different seat.
    const changed = layout(worldOf({ id: 'a' }, { id: 'n', role: 'planner' }), grown)
    const later = reconcileActors(walking, grown, changed, { nowMs: 300, ...MOVE })
    const rerouted = actor(later, 'n')
    expect(rerouted.phase).toBe('moving')
    expect(rerouted.path[0]).toEqual(positionAt(walker, grown, 300).point)
    expect(rerouted.path[rerouted.path.length - 1]).toEqual(placementOf(changed, 'n')?.seat)
  })
})
