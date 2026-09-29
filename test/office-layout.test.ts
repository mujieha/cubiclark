import { describe, expect, test } from 'vitest'
import { WORLD_FIXTURES, roomsWorld, worldSessionId as s, worldSubagentId as sub } from '../scripts/world-fixture-lib.js'
import { TILE, rectContains, rectsOverlap, scaleRect, type Rect } from '../src/core/office/geometry.js'
import { layout, placementOf, type OfficeLayout } from '../src/core/office/layout.js'
import type { Agent, World } from '../src/core/types.js'
import { emptyWorld, ensureAgent, updateAgent } from '../src/core/world.js'

const T = '2026-01-15T10:30:00.000Z'

function worldOf(...patches: (Partial<Agent> & { id: string })[]): World {
  let world = emptyWorld(T, '/root')
  for (const patch of patches) {
    world = ensureAgent(world, patch.id, T)
    world = updateAgent(world, patch.id, (agent) => ({ ...agent, project: 'demo', state: 'thinking', ...patch }))
  }
  return world
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

const placement = (l: OfficeLayout, id: string) => must(placementOf(l, id), `placement of ${id}`)
const seatOf = (l: OfficeLayout, id: string) => placement(l, id).seat

describe('rooms for the rooms world (the acceptance)', () => {
  const world = roomsWorld()
  const l = layout(world)
  const room = (id: string): string => placement(l, id).room
  const kind = (id: string): string => placement(l, id).kind

  test('the orchestrator and the derived orchestrator sit in the manager office', () => {
    expect(room(s(1))).toBe('manager')
    expect(room(s(2))).toBe('manager')
    expect(kind(s(1))).toBe('desk')
  })

  test('the planner, the planning-task agent and a Plan subagent sit in the planning room', () => {
    expect(room(s(4))).toBe('planning')
    expect(room(s(5))).toBe('planning')
    expect(room(sub(6))).toBe('planning')
    expect(kind(sub(6))).toBe('desk')
  })

  test('builders sit at desks on the project floor, one cluster per project', () => {
    for (const id of [s(3), s(6), s(7)]) {
      expect(room(id)).toBe('floor')
      expect(kind(id)).toBe('desk')
    }
    expect(l.clusters.map((c) => c.project)).toEqual(['demo', 'shop'])
    expect(must(l.desks.find((d) => d.ownerId === s(6)), 'desk').cluster).toBe('demo')
    expect(must(l.desks.find((d) => d.ownerId === s(7)), 'desk').cluster).toBe('shop')
    expect(must(l.desks.find((d) => d.ownerId === s(3)), 'desk').cluster).toBe('shop')
  })

  test('a reviewer subagent sits in the review corner, at a desk', () => {
    expect(room(sub(1))).toBe('review')
    expect(kind(sub(1))).toBe('desk')
  })

  test('an Explore subagent is on a stool beside its builder, and so is a nested one and a teammate', () => {
    const builderDesk = must(l.desks.find((d) => d.ownerId === s(6)), 'desk')
    for (const id of [sub(2), sub(3), s(8)]) {
      expect(kind(id)).toBe('stool')
      expect(placement(l, id).deskId).toBe(builderDesk.id)
      expect(placement(l, id).anchorId).toBe(s(6))
      expect(room(id)).toBe('floor')
    }
    expect(new Set([sub(2), sub(3), s(8)].map((id) => placement(l, id).slot))).toEqual(new Set([0, 1, 2]))
  })

  test('an orphan subagent gets a desk of its own on the floor', () => {
    expect(kind(sub(5))).toBe('desk')
    expect(room(sub(5))).toBe('floor')
  })

  test('the fourth and fifth helpers of one builder go to the bench', () => {
    const helpers = [7, 8, 9, 10, 11].map((n) => placement(l, sub(n)))
    expect(helpers.filter((p) => p.kind === 'stool')).toHaveLength(3)
    const benched = helpers.filter((p) => p.kind === 'bench')
    expect(benched).toHaveLength(2)
    for (const p of benched) expect(p.anchorId).toBe(s(7))
    expect(benched.map((p) => p.slot).sort()).toEqual([0, 1])
  })

  test('finished and ended agents are on the lobby board', () => {
    expect(placement(l, s(9))).toMatchObject({ room: 'lobby', kind: 'board' })
    expect(placement(l, s(10))).toMatchObject({ room: 'lobby', kind: 'board' })
  })
})

describe('reading order', () => {
  test('manager, planning, review, floor, bench, board; a stool directly follows its desk', () => {
    const l = layout(roomsWorld())
    const rank = (id: string): number => {
      const p = placement(l, id)
      if (p.kind === 'board') return 5
      if (p.kind === 'bench') return 4
      return { manager: 0, planning: 1, review: 2, floor: 3, lobby: 5 }[p.room]
    }
    const ranks = l.placements.map((p) => rank(p.agentId))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    l.placements.forEach((p, index) => {
      if (p.kind !== 'stool') return
      const before = must(l.placements[index - 1], 'previous placement')
      expect(before.deskId === p.deskId).toBe(true)
    })
  })

  test('it holds one placement per agent, and no agent twice', () => {
    const world = roomsWorld()
    const l = layout(world)
    expect(l.placements.map((p) => p.agentId).sort()).toEqual(Object.keys(world.agents).sort())
  })
})

describe('the layout invariants, on every fixture world', () => {
  for (const [name, build] of Object.entries(WORLD_FIXTURES)) {
    const world = build()
    const l = layout(world)

    test(`${name}: one placement per agent`, () => {
      expect(l.placements).toHaveLength(Object.keys(world.agents).length)
      expect(new Set(l.placements.map((p) => p.agentId)).size).toBe(l.placements.length)
    })

    test(`${name}: no shared seat, no overlapping hit boxes`, () => {
      const seats = new Set(l.placements.map((p) => `${p.seat.x},${p.seat.y}`))
      expect(seats.size).toBe(l.placements.length)
      for (let i = 0; i < l.placements.length; i++) {
        for (let j = i + 1; j < l.placements.length; j++) {
          const a = must(l.placements[i], 'a')
          const b = must(l.placements[j], 'b')
          expect(rectsOverlap(a.boxPx, b.boxPx), `${a.agentId} overlaps ${b.agentId}`).toBe(false)
        }
      }
    })

    // A seat point is where the character's feet would be, which for a seated sprite is below the
    // tile it occupies; the hit box is the area the character and its bubble actually cover.
    test(`${name}: hit boxes are inside their rooms and stools inside the desk cell`, () => {
      const inside = (outer: Rect, box: Rect): boolean =>
        box.x >= outer.x && box.y >= outer.y && box.x + box.w <= outer.x + outer.w && box.y + box.h <= outer.y + outer.h
      for (const p of l.placements) {
        const roomBox = must(l.rooms.find((r) => r.id === p.room), `room ${p.room}`)
        expect(inside(scaleRect(roomBox.rect, TILE), p.boxPx), `${p.agentId} box in ${p.room}`).toBe(true)
        if (p.kind === 'desk') expect(rectContains(scaleRect(roomBox.rect, TILE), p.seat), `${p.agentId} desk seat`).toBe(true)
        if (p.kind === 'stool') {
          const desk = must(l.desks.find((d) => d.id === p.deskId), 'desk')
          expect(inside(scaleRect(desk.rect, TILE), p.boxPx)).toBe(true)
        }
      }
    })

    test(`${name}: rooms do not overlap, the height is the sum of the bands, the door is in the bottom wall`, () => {
      for (let i = 0; i < l.rooms.length; i++) {
        for (let j = i + 1; j < l.rooms.length; j++) {
          expect(rectsOverlap(must(l.rooms[i], 'a').rect, must(l.rooms[j], 'b').rect)).toBe(false)
        }
      }
      expect(l.cols).toBe(36)
      const top = must(l.rooms.find((r) => r.id === 'manager'), 'manager').rect
      const floor = must(l.rooms.find((r) => r.id === 'floor'), 'floor').rect
      const lobby = must(l.rooms.find((r) => r.id === 'lobby'), 'lobby').rect
      expect(floor.y).toBe(top.h + 1)
      expect(lobby.y).toBe(floor.y + floor.h + 1)
      expect(l.rows).toBe(lobby.y + lobby.h + 1)
      expect(l.door.y).toBeGreaterThanOrEqual((l.rows - 1) * TILE)
      expect(l.door.y).toBeLessThan(l.rows * TILE)
      expect(l.door.x).toBeLessThanOrEqual(2 * TILE)
    })

    test(`${name}: layout is deterministic and stable when fed its own output`, () => {
      expect(layout(world)).toEqual(l)
      expect(layout(world, l)).toEqual(l)
    })
  }
})

describe('the office grows with its crowd', () => {
  test('a third planner adds a row to the top band', () => {
    const two = layout(worldOf({ id: 'p1', role: 'planner' }, { id: 'p2', role: 'planner' }))
    const three = layout(worldOf({ id: 'p1', role: 'planner' }, { id: 'p2', role: 'planner' }, { id: 'p3', role: 'planner' }))
    const height = (l: OfficeLayout): number => must(l.rooms.find((r) => r.id === 'manager'), 'manager').rect.h
    expect(height(three) - height(two)).toBe(3)
    expect(three.rows - two.rows).toBe(3)
  })

  test('an empty world still has every room, one empty floor and a lobby', () => {
    const l = layout(emptyWorld(T, '/root'))
    expect(l.placements).toEqual([])
    expect(l.rooms.map((r) => r.id)).toEqual(['manager', 'planning', 'review', 'floor', 'lobby'])
    expect(l.rows).toBeGreaterThan(10)
  })

  test('crowd-50 places 50 agents', () => {
    expect(layout(must(WORLD_FIXTURES['crowd-50'], 'crowd')()).placements).toHaveLength(50)
  })

  test('the lobby board wraps to a second row after 30 tags', () => {
    const departed = Array.from({ length: 31 }, (_, i) => ({ id: `d${String(i).padStart(2, '0')}`, state: 'finished' as const }))
    const l = layout(worldOf(...departed))
    const lobby = must(l.rooms.find((r) => r.id === 'lobby'), 'lobby').rect
    expect(lobby.h).toBe(3)
    expect(placement(l, 'd30').seat.y).toBeGreaterThan(placement(l, 'd00').seat.y)
  })
})

describe('seats stay put across updates', () => {
  const base = worldOf({ id: 'b' }, { id: 'c' })
  const baseLayout = layout(base)

  test('an agent whose id sorts first moves nobody else', () => {
    const grown = worldOf({ id: 'a' }, { id: 'b' }, { id: 'c' })
    const l = layout(grown, baseLayout)
    expect(seatOf(l, 'b')).toEqual(seatOf(baseLayout, 'b'))
    expect(seatOf(l, 'c')).toEqual(seatOf(baseLayout, 'c'))
    expect(seatOf(l, 'a')).not.toEqual(seatOf(baseLayout, 'b'))
    // Without the previous layout the newcomer would have taken slot 0 and pushed everyone along.
    expect(seatOf(layout(grown), 'b')).not.toEqual(seatOf(baseLayout, 'b'))
  })

  test('removing the agent in slot 0 leaves a hole and moves nobody; the next newcomer fills it', () => {
    const shrunk = layout(worldOf({ id: 'c' }), baseLayout)
    expect(seatOf(shrunk, 'c')).toEqual(seatOf(baseLayout, 'c'))
    const refilled = layout(worldOf({ id: 'c' }, { id: 'd' }), shrunk)
    expect(seatOf(refilled, 'c')).toEqual(seatOf(baseLayout, 'c'))
    expect(seatOf(refilled, 'd')).toEqual(seatOf(baseLayout, 'b'))
  })

  test('a hole never makes a row vanish under a seated agent', () => {
    const four = layout(worldOf({ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }))
    const two = layout(worldOf({ id: 'c' }, { id: 'd' }), four)
    expect(seatOf(two, 'd')).toEqual(seatOf(four, 'd'))
    expect(two.clusters[0]?.rect.h).toBe(four.clusters[0]?.rect.h)
  })

  test('a new project gets a cluster after the existing ones, not before', () => {
    const grown = worldOf({ id: 'b' }, { id: 'c' }, { id: 'z1', project: 'zeta' }, { id: 'a1', project: 'alpha' })
    expect(layout(grown).clusters.map((c) => c.project)).toEqual(['alpha', 'demo', 'zeta'])
    const sticky = layout(grown, baseLayout)
    expect(sticky.clusters.map((c) => c.project)).toEqual(['demo', 'alpha', 'zeta'])
    expect(seatOf(sticky, 'b')).toEqual(seatOf(baseLayout, 'b'))
  })

  test('a departure is appended to the board after earlier ones', () => {
    const first = layout(worldOf({ id: 'x', state: 'finished' }, { id: 'y' }))
    const second = layout(worldOf({ id: 'x', state: 'finished' }, { id: 'a', state: 'ended' }, { id: 'y' }), first)
    expect(placement(second, 'x').slot).toBe(0)
    expect(placement(second, 'a').slot).toBe(1)
    expect(placement(layout(worldOf({ id: 'x', state: 'finished' }, { id: 'a', state: 'ended' })), 'a').slot).toBe(0)
  })

  test('an agent that changes room gets a new slot there and frees its old one', () => {
    const before = layout(worldOf({ id: 'a' }, { id: 'b' }))
    const after = layout(worldOf({ id: 'a', role: 'reviewer' }, { id: 'b' }), before)
    expect(placement(after, 'a').room).toBe('review')
    expect(placement(after, 'a').slot).toBe(0)
    expect(seatOf(after, 'b')).toEqual(seatOf(before, 'b'))
  })

  test('helpers keep their stools too', () => {
    const family = (...ids: string[]): World =>
      worldOf({ id: 'p' }, ...ids.map((id) => ({ id, kind: 'subagent' as const, parentId: 'p', role: 'explorer' as const })))
    const first = layout(family('h2', 'h3'))
    const second = layout(family('h1', 'h2', 'h3'), first)
    expect(seatOf(second, 'h2')).toEqual(seatOf(first, 'h2'))
    expect(seatOf(second, 'h3')).toEqual(seatOf(first, 'h3'))
    expect(placement(second, 'h1').kind).toBe('stool')
  })
})
