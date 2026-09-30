// Morty's state machine: pure and seeded, so every activity is a test and a day can be replayed.
// Time is passed in; the World is a fixture; nothing here touches a clock or a canvas.

import { describe, expect, test } from 'vitest'
import { crowd100World, mascotPlayWorld, roomsWorld, stateWorld } from '../scripts/world-fixture-lib.js'
import { layout as computeLayout } from '../src/core/office/layout.js'
import {
  BAG,
  STAY_MS,
  advanceMascot,
  initialMascot,
  mascotButtonText,
  mascotPose,
  mascotSeed,
  nextRandom,
  parseMascotChoice,
  type MascotActivity,
  type MascotInput,
  type MascotPose,
  type MascotState,
} from '../src/core/office/mascot.js'
import { mascotGrid, roomOf, tileCentre, tileOf, type MascotGrid } from '../src/core/office/mascot-map.js'
import { reconcileActors, type Actor } from '../src/core/office/motion.js'
import { buildTileMap } from '../src/core/office/tilemap.js'
import type { World } from '../src/core/types.js'
import type { OfficeLayout } from '../src/core/office/layout.js'
import type { Point } from '../src/core/office/geometry.js'

const T0 = 5000

interface Scene {
  world: World
  layout: OfficeLayout
  grid: MascotGrid
  actors: ReadonlyMap<string, Actor>
}

function scene(world: World): Scene {
  const layout = computeLayout(world)
  const grid = mascotGrid(world, layout, buildTileMap(layout, { quota: world.quota !== undefined }))
  const actors = reconcileActors(new Map(), undefined, layout, { nowMs: T0, reducedMotion: false, firstSnapshot: true })
  return { world, layout, grid, actors }
}

const input = (s: Scene, nowMs: number, over: Partial<MascotInput> = {}): MascotInput => ({ ...s, nowMs, reducedMotion: false, arrivals: [], ...over })
const endOf = (state: MascotState): number => state.startMs + state.walkMs + state.stayMs
const arrivalOf = (state: MascotState): number => state.startMs + state.walkMs

/** Deals `activity` next: the current stay ends, and the next in the bag is that one. */
function enter(state: MascotState, activity: MascotActivity, s: Scene): MascotState {
  return advanceMascot({ ...state, bag: [activity] }, input(s, endOf(state)))
}

/** Is the point on the path (every segment is along an axis)? */
function onPath(point: Point, path: readonly Point[]): boolean {
  if (path.length === 1) return point.x === path[0]?.x && point.y === path[0]?.y
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    if (point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true
  }
  return false
}

describe('the day begins', () => {
  test('Morty starts in his basket, napping, for a few seconds', () => {
    const s = scene(roomsWorld())
    const state = initialMascot(123, input(s, T0))
    expect(state.activity).toBe('nap')
    expect(state.spot).toEqual(s.grid.spots.basket)
    expect(state.path).toEqual([tileCentre(s.grid.spots.basket)])
    expect(state.walkMs).toBe(0)
    expect(state.stayMs).toBeGreaterThanOrEqual(STAY_MS.first_nap[0])
    expect(state.stayMs).toBeLessThanOrEqual(STAY_MS.first_nap[1])
    expect(state.frozen).toBe(false)
    expect(state.withId).toBeUndefined()
    expect(mascotPose(state, T0)).toMatchObject({ activity: 'nap', walking: false, point: tileCentre(s.grid.spots.basket) })
  })

  test('the same seed plays the same first moments; another seed plays them differently', () => {
    const s = scene(roomsWorld())
    expect(initialMascot(7, input(s, T0))).toEqual(initialMascot(7, input(s, T0)))
    const stays = new Set(Array.from({ length: 20 }, (_, seed) => initialMascot(seed, input(s, T0)).stayMs))
    expect(stays.size).toBeGreaterThan(5)
    const bags = new Set(Array.from({ length: 20 }, (_, seed) => initialMascot(seed, input(s, T0)).bag.join()))
    expect(bags.size).toBeGreaterThan(5)
  })

  test('the bag is a round of everything he can be dealt: the activities of BAG, each as often as BAG has it', () => {
    const s = scene(roomsWorld())
    for (const seed of [1, 2, 3]) expect([...initialMascot(seed, input(s, T0)).bag].sort()).toEqual([...BAG].sort())
    expect(BAG.filter((a) => a === 'wander')).toHaveLength(2)
    expect(BAG).not.toContain('greet')
  })

  test('a new day, a new Morty: the seed follows the World\'s date, and only that', () => {
    expect(mascotSeed('2026-01-15T10:30:00.000Z')).toBe(mascotSeed('2026-01-15T23:59:59.000Z'))
    expect(mascotSeed('2026-01-15T10:30:00.000Z')).not.toBe(mascotSeed('2026-01-16T10:30:00.000Z'))
  })

  test('the generator is deterministic, stays in [0, 1) and moves on', () => {
    const [a, next] = nextRandom(42)
    expect(nextRandom(42)).toEqual([a, next])
    expect(next).not.toBe(42)
    let state = 1
    for (let i = 0; i < 1000; i++) {
      const [value, following] = nextRandom(state)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
      state = following
    }
  })
})

describe('each activity', () => {
  test('nap: he walks to his basket and sleeps in it', () => {
    const s = scene(roomsWorld())
    const out = enter(enter(initialMascot(1, input(s, T0)), 'drink', s), 'nap', s)
    expect(out.activity).toBe('nap')
    expect(out.spot).toEqual(s.grid.spots.basket)
    expect(out.walkMs).toBeGreaterThan(0)
    expect(mascotPose(out, out.startMs + 10).walking).toBe(true)
    const asleep = mascotPose(out, arrivalOf(out) + 100)
    expect(asleep).toMatchObject({ walking: false, point: tileCentre(s.grid.spots.basket) })
    expect(asleep.frame).toMatch(/^sleep_[ab]$/)
    expect(new Set([0, 1300].map((t) => mascotPose(out, arrivalOf(out) + t).frame)).size, 'he breathes').toBe(2)
  })

  test('drink: he goes to his bowl, faces it with his head down, and laps', () => {
    const s = scene(roomsWorld())
    const out = enter(initialMascot(1, input(s, T0)), 'drink', s)
    expect(out.activity).toBe('drink')
    expect(out.spot).toEqual(s.grid.spots.drink)
    expect(out.facing).toBe('up')
    const at = mascotPose(out, arrivalOf(out) + 50)
    expect(at).toMatchObject({ activity: 'drink', walking: false, point: tileCentre(s.grid.spots.drink), mirror: false })
    expect(at.frame).toMatch(/^drink_[ab]$/)
    expect(new Set([0, 300].map((t) => mascotPose(out, arrivalOf(out) + t).frame)).size).toBe(2)
  })

  test('wander: he ends up in a different room, on a tile he may stand on', () => {
    const s = scene(roomsWorld())
    const start = initialMascot(1, input(s, T0))
    expect(roomOf(s.layout, start.spot)).toBe('lobby')
    const out = enter(start, 'wander', s)
    expect(out.activity).toBe('wander')
    const room = roomOf(s.layout, out.spot)
    expect(room).not.toBe('lobby')
    expect(room).not.toBe('hall')
    expect(room).toBeDefined()
    expect(s.grid.walkable[out.spot.y * s.grid.cols + out.spot.x]).toBe(1)
    expect(mascotPose(out, arrivalOf(out) + 10).frame).toBe('sit')
  })

  test('wander goes room to room: over a run he is in several', () => {
    const s = scene(roomsWorld())
    let state = initialMascot(3, input(s, T0))
    const rooms = new Set<string>()
    for (let i = 0; i < 12; i++) {
      state = enter(state, 'wander', s)
      rooms.add(String(roomOf(s.layout, state.spot)))
    }
    expect(rooms.size).toBeGreaterThanOrEqual(3)
  })

  test('sniff: under the whiteboard when the planning room is empty, skipped when a planner is in the way', () => {
    const empty = scene(stateWorld('thinking'))
    const out = enter(initialMascot(1, input(empty, T0)), 'sniff', empty)
    expect(out.activity).toBe('sniff')
    expect(out.spot).toEqual(empty.grid.spots.whiteboard)
    expect(out.facing).toBe('up')
    expect(mascotPose(out, arrivalOf(out) + 10).frame).toMatch(/^sniff_[ab]$/)

    const busy = scene(roomsWorld())
    const skipped = advanceMascot({ ...initialMascot(1, input(busy, T0)), bag: ['sniff', 'nap'] }, input(busy, endOf(initialMascot(1, input(busy, T0)))))
    expect(skipped.activity).toBe('nap')
  })

  test('the stay frames: a dog that has wandered off sits, and only a wagging or a sleeping dog is flipped to face left', () => {
    const s = scene(roomsWorld())
    const out = enter(initialMascot(1, input(s, T0)), 'wander', s)
    const pose = mascotPose(out, arrivalOf(out) + 10)
    expect(pose.mirror).toBe(out.facing === 'left')
  })
})

describe('walking', () => {
  test('takes the length of the path at 80 px a second, and every point is on the path', () => {
    const s = scene(roomsWorld())
    const out = enter(enter(initialMascot(2, input(s, T0)), 'drink', s), 'nap', s)
    let length = 0
    for (let i = 1; i < out.path.length; i++) {
      const a = out.path[i - 1] as Point
      const b = out.path[i] as Point
      length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    }
    expect(out.walkMs).toBe(Math.round((length / 80) * 1000))
    for (let t = 0; t <= out.walkMs; t += 37) {
      const pose = mascotPose(out, out.startMs + t)
      expect(Number.isInteger(pose.point.x) && Number.isInteger(pose.point.y), 'whole px').toBe(true)
      expect(onPath(pose.point, out.path), `at ${t} ms`).toBe(true)
    }
    expect(mascotPose(out, out.startMs)).toMatchObject({ walking: true, point: out.path[0] })
  })

  test('the legs change every 150 ms, and he faces the way he goes', () => {
    const s = scene(roomsWorld())
    const out = enter(enter(initialMascot(2, input(s, T0)), 'drink', s), 'nap', s)
    const a = mascotPose(out, out.startMs + 10)
    const b = mascotPose(out, out.startMs + 160)
    expect(a.frame.slice(0, -1)).toBe(b.frame.slice(0, -1))
    expect(a.frame).not.toBe(b.frame)
    const faces = new Set<string>()
    for (let t = 0; t < out.walkMs; t += 25) faces.add(mascotPose(out, out.startMs + t).frame.replace(/_[ab]$/, ''))
    for (const face of faces) expect(['walk_side', 'walk_up', 'walk_down']).toContain(face)
    expect(faces.has('walk_side'), 'the way to the lobby ends along a row').toBe(true)
  })
})

describe('a day, step by step and in one jump', () => {
  for (const [name, make] of [
    ['mascot-play', mascotPlayWorld],
    ['rooms', roomsWorld],
  ] as const) {
    test(`ten minutes of 33 ms frames equal one jump to the same time: ${name}`, () => {
      const s = scene(make())
      const start = initialMascot(11, input(s, T0))
      const last = T0 + 10 * 60_000
      let stepped = start
      for (let t = T0 + 33; t <= last; t += 33) stepped = advanceMascot(stepped, input(s, t))
      const finalT = T0 + 33 * Math.floor((last - T0) / 33)
      expect(advanceMascot(start, input(s, finalT))).toEqual(stepped)
    })
  }

  test('a frame where nothing happens hands back the very same object', () => {
    const s = scene(roomsWorld())
    const state = initialMascot(1, input(s, T0))
    expect(advanceMascot(state, input(s, T0 + 1))).toBe(state)
    expect(advanceMascot(state, input(s, T0 + 2))).toBe(state)
  })
})

describe('one thing at a time', () => {
  test('over half an hour every picture is one activity, and only company has a name beside it', () => {
    const s = scene(mascotPlayWorld())
    let state = initialMascot(5, input(s, T0))
    const seen = new Set<MascotActivity>()
    const company = new Set<MascotActivity>(['sit_by', 'play'])
    for (let t = T0; t <= T0 + 30 * 60_000; t += 50) {
      state = advanceMascot(state, input(s, t))
      const pose: MascotPose = mascotPose(state, t)
      seen.add(pose.activity)
      expect(BAG.concat(['greet']), pose.activity).toContain(pose.activity)
      if (pose.withId !== undefined) expect(company.has(pose.activity), `${pose.activity} with ${pose.withId}`).toBe(true)
      if (pose.play) expect(pose.activity).toBe('play')
      if (pose.walking) expect(pose.withId, 'nobody is with him while he is on his way').toBeUndefined()
    }
    expect(seen.size).toBeGreaterThan(3)
  })

  test('every stay is as long as the seed makes it within its range', () => {
    for (const make of [mascotPlayWorld, roomsWorld, crowd100World]) {
      const s = scene(make())
      let state = initialMascot(9, input(s, T0))
      let changes = 0
      // Every state seen here came after the first nap (whose range is tested with `initialMascot`).
      for (let t = T0; t <= T0 + 30 * 60_000; t += 500) {
        const next = advanceMascot(state, input(s, t))
        if (next !== state) {
          changes++
          const [min, max] = STAY_MS[next.activity]
          expect(next.stayMs, `${next.activity}`).toBeGreaterThanOrEqual(min)
          expect(next.stayMs, `${next.activity}`).toBeLessThanOrEqual(max)
        }
        state = next
      }
      expect(changes).toBeGreaterThan(20)
    }
  })
})

describe('reduced motion', () => {
  test('he is asleep in his basket and nothing moves, now or ten minutes on', () => {
    const s = scene(mascotPlayWorld())
    const moving = initialMascot(4, input(s, T0))
    const still = advanceMascot(moving, input(s, T0 + 100, { reducedMotion: true }))
    expect(still.frozen).toBe(true)
    expect(still.activity).toBe('nap')
    expect(still.spot).toEqual(s.grid.spots.basket)
    const now = mascotPose(still, T0 + 100)
    const later = mascotPose(still, T0 + 100 + 10 * 60_000)
    expect(now).toEqual(later)
    expect(now).toMatchObject({ activity: 'nap', walking: false, frame: 'sleep_a', mirror: false, point: tileCentre(s.grid.spots.basket) })
    expect(now.withId).toBeUndefined()
    expect(now.play).toBeUndefined()
    expect(advanceMascot(still, input(s, T0 + 10 * 60_000, { reducedMotion: true }))).toBe(still)
  })

  test('switched on in the middle of a walk or a game, he is asleep at once', () => {
    const s = scene(mascotPlayWorld())
    const walking = enter(enter(initialMascot(2, input(s, T0)), 'drink', s), 'nap', s)
    const mid = walking.startMs + Math.floor(walking.walkMs / 2)
    expect(mascotPose(walking, mid).walking).toBe(true)
    const frozen = advanceMascot(walking, input(s, mid, { reducedMotion: true }))
    expect(mascotPose(frozen, mid)).toMatchObject({ walking: false, frame: 'sleep_a' })
  })

  test('with motion back on he wakes and gets on with his day from then', () => {
    const s = scene(roomsWorld())
    const frozen = advanceMascot(initialMascot(4, input(s, T0)), input(s, T0 + 10, { reducedMotion: true }))
    const awake = advanceMascot(frozen, input(s, T0 + 5000))
    expect(awake.frozen).toBe(false)
    expect(awake.startMs).toBe(T0 + 5000)
    expect(Number.isFinite(awake.stayMs)).toBe(true)
  })

  test('a frozen Morty follows his basket when the office grows', () => {
    const small = scene(stateWorld('thinking'))
    const big = scene(roomsWorld())
    const frozen = advanceMascot(initialMascot(4, input(small, T0)), input(small, T0 + 10, { reducedMotion: true }))
    const moved = advanceMascot(frozen, input(big, T0 + 20, { reducedMotion: true }))
    expect(moved.spot).toEqual(big.grid.spots.basket)
    expect(tileOf(moved.path[0] as Point)).toEqual(big.grid.spots.basket)
  })
})

describe('his header button and what is remembered', () => {
  test('only "off" turns him off', () => {
    expect(parseMascotChoice('off')).toBe(false)
    for (const raw of ['on', null, undefined, '', 'x', 42, {}, 'OFF']) expect(parseMascotChoice(raw), String(raw)).toBe(true)
  })

  test('the button says what he is now', () => {
    expect(mascotButtonText(true)).toBe('Morty: on')
    expect(mascotButtonText(false)).toBe('Morty: off')
  })
})
