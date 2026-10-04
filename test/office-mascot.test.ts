// Morty's state machine: pure and seeded, so every activity is a test and a day can be replayed.
// Time is passed in; the World is a fixture; nothing here touches a clock or a canvas.

import { describe, expect, test } from 'vitest'
import { crowd100World, mascotPlayWorld, roomsWorld, stateWorld, worldSessionId, worldSubagentId } from '../scripts/world-fixture-lib.js'
import { layout as computeLayout, placementOf } from '../src/core/office/layout.js'
import {
  BAG,
  GREET_GAP_MS,
  MAX_CATCH_UP_MS,
  PLAY_IDLE_MS,
  PLAY_MAX_TILES,
  PLAY_PERIOD_MS,
  SIT_BY_MAX_TILES,
  STAY_MS,
  WORKING_STATES,
  advanceMascot,
  initialMascot,
  mascotButtonText,
  mascotPose,
  mascotSeed,
  nextRandom,
  parseMascotChoice,
  playPhase,
  type MascotActivity,
  type MascotInput,
  type MascotPose,
  type MascotState,
} from '../src/core/office/mascot.js'
import {
  bubbleObstacles,
  distanceToCell,
  findPath,
  isWalkable,
  mascotGrid,
  roomOf,
  staticObstacles,
  tileCentre,
  tileOf,
  tileRect,
  type MascotGrid,
  type Tile,
} from '../src/core/office/mascot-map.js'
import { reconcileActors, type Actor } from '../src/core/office/motion.js'
import { buildTileMap } from '../src/core/office/tilemap.js'
import type { Agent, World } from '../src/core/types.js'
import type { OfficeLayout } from '../src/core/office/layout.js'
import { rectsOverlap, type Point, type Rect } from '../src/core/office/geometry.js'

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

describe('after a tab was hidden', () => {
  const MIN = 60_000

  /** The input with its grid counted: every step of the machine reads it, so reads measure the work. */
  function counted(i: MascotInput): { input: MascotInput; reads: () => number } {
    let reads = 0
    const { grid, ...rest } = i
    const wrapped = { ...rest } as MascotInput
    Object.defineProperty(wrapped, 'grid', {
      get() {
        reads += 1
        return grid
      },
      enumerable: true,
    })
    return { input: wrapped, reads: () => reads }
  }

  test('MAX_CATCH_UP_MS is one minute', () => {
    expect(MAX_CATCH_UP_MS).toBe(MIN)
  })

  test('a gap over a minute starts afresh from now; without the gap it is replayed stay by stay', () => {
    const s = scene(mascotPlayWorld())
    const start = initialMascot(11, input(s, T0))
    const far = T0 + 5 * MIN
    const capped = advanceMascot(start, input(s, far, { lastFrameMs: T0 }))
    const replayed = advanceMascot(start, input(s, far))
    expect(capped.startMs).toBe(far)
    expect(endOf(capped)).toBeGreaterThan(far)
    expect(replayed.startMs).toBeLessThan(far)
    expect(mascotPose(capped, far)).toBeDefined()
  })

  test('a 30-minute jump costs one bounded step, not dozens', () => {
    const s = scene(mascotPlayWorld())
    const start = initialMascot(11, input(s, T0))
    const far = T0 + 30 * MIN
    const capped = counted(input(s, far, { lastFrameMs: T0 }))
    const replayed = counted(input(s, far))
    const after = advanceMascot(start, capped.input)
    advanceMascot(start, replayed.input)
    expect(after.startMs).toBe(far)
    expect(capped.reads()).toBeLessThan(40)
    expect(replayed.reads()).toBeGreaterThan(capped.reads() * 10)
  })

  test('a gap of 30 s is not capped: it equals the same jump without the gap', () => {
    const s = scene(roomsWorld())
    const start = initialMascot(4, input(s, T0))
    const at = T0 + 30_000
    expect(advanceMascot(start, input(s, at, { lastFrameMs: T0 }))).toEqual(advanceMascot(start, input(s, at)))
  })

  test('a long gap while a stay is still going changes nothing', () => {
    const s = scene(roomsWorld())
    const state = initialMascot(1, input(s, T0))
    expect(advanceMascot(state, input(s, T0 + 1, { lastFrameMs: T0 - 10 * MIN }))).toBe(state)
  })

  test('reduced motion is not affected: he is asleep in his basket either way', () => {
    const s = scene(mascotPlayWorld())
    const start = initialMascot(11, input(s, T0))
    const far = T0 + 30 * MIN
    expect(advanceMascot(start, input(s, far, { reducedMotion: true, lastFrameMs: T0 }))).toEqual(advanceMascot(start, input(s, far, { reducedMotion: true })))
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

// --- Company: greeting, sitting by, playing ---------------------------------------------------

const S1 = worldSessionId(1)
const S2 = worldSessionId(2)
const S3 = worldSessionId(3)
const S4 = worldSessionId(4)

function changeAgent(world: World, id: string, patch: Partial<Agent>): World {
  return { ...world, agents: { ...world.agents, [id]: { ...(world.agents[id] as Agent), ...patch } } }
}

const deskOf = (s: Scene, id: string): Rect => (s.layout.desks.find((d) => d.ownerId === id) as { rect: Rect }).rect

describe('greeting', () => {
  test('an arrival cuts a nap short: he goes to the door and wags', () => {
    const s = scene(mascotPlayWorld())
    const napping = initialMascot(1, input(s, T0))
    const greeting = advanceMascot(napping, input(s, T0 + 1000, { arrivals: [S1] }))
    expect(greeting.activity).toBe('greet')
    expect(greeting.startMs).toBe(T0 + 1000)
    expect(greeting.lastGreetMs).toBe(T0 + 1000)
    expect(greeting.spot).toEqual(s.grid.spots.door)
    expect(greeting.facing).toBe('left')
    const wagging = mascotPose(greeting, arrivalOf(greeting) + 10)
    expect(wagging.frame).toMatch(/^wag_[ab]$/)
    expect(wagging.mirror).toBe(true)
    expect(new Set([0, 130].map((t) => mascotPose(greeting, arrivalOf(greeting) + t).frame)).size).toBe(2)
    expect(greeting.stayMs).toBe(3000)
  })

  test('a second arrival soon after does not start another greeting; one after 20 s does', () => {
    const s = scene(mascotPlayWorld())
    const greeting = advanceMascot(initialMascot(1, input(s, T0)), input(s, T0 + 1000, { arrivals: [S1] }))
    const soon = advanceMascot(greeting, input(s, T0 + 6000, { arrivals: [S2] }))
    expect(soon.lastGreetMs).toBe(T0 + 1000)
    const later = advanceMascot(soon, input(s, T0 + 1000 + GREET_GAP_MS + 1, { arrivals: [S2] }))
    expect(later.lastGreetMs).toBe(T0 + 1000 + GREET_GAP_MS + 1)
    expect(later.activity).toBe('greet')
  })

  test('a burst of ten arrivals is one greeting', () => {
    const s = scene(mascotPlayWorld())
    const ids = Array.from({ length: 10 }, (_, i) => worldSessionId(50 + i))
    const greeting = advanceMascot(initialMascot(1, input(s, T0)), input(s, T0 + 1000, { arrivals: ids }))
    expect(greeting.activity).toBe('greet')
    expect(greeting.lastGreetMs).toBe(T0 + 1000)
  })

  test('with no arrival he does not greet, and with reduced motion he does not either', () => {
    const s = scene(mascotPlayWorld())
    const state = initialMascot(1, input(s, T0))
    expect(advanceMascot(state, input(s, T0 + 1000)).activity).toBe('nap')
    const still = advanceMascot(state, input(s, T0 + 1000, { arrivals: [S1], reducedMotion: true }))
    expect(still.frozen).toBe(true)
    expect(still.activity).toBe('nap')
  })

  test('it ends a game of ball: the agent sits down and he goes to the door', () => {
    const s = scene(mascotPlayWorld())
    const playing = enter(initialMascot(1, input(s, T0)), 'play', s)
    const during = arrivalOf(playing) + 500
    expect(mascotPose(advanceMascot(playing, input(s, during)), during).play).toBeDefined()
    const greeting = advanceMascot(playing, input(s, during, { arrivals: [S2] }))
    expect(greeting.activity).toBe('greet')
    const pose = mascotPose(greeting, during)
    expect(pose.play).toBeUndefined()
    expect(pose.withId).toBeUndefined()
  })
})

describe('sitting by a working agent', () => {
  test('he sits within two tiles of a desk whose agent is at work, facing it, and only once he is there is he "with" it', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = scene(mascotPlayWorld())
      const out = enter(initialMascot(seed, input(s, T0)), 'sit_by', s)
      expect(out.activity, `seed ${seed}`).toBe('sit_by')
      expect([S3, S4], `seed ${seed}: only agents at work`).toContain(out.withId)
      expect(WORKING_STATES.has(s.world.agents[out.withId as string]?.state ?? 'ended')).toBe(true)
      const distance = distanceToCell(deskOf(s, out.withId as string), out.spot)
      expect(distance).toBeGreaterThanOrEqual(1)
      expect(distance).toBeLessThanOrEqual(SIT_BY_MAX_TILES)
      const seat = (placementOf(s.layout, out.withId as string) as { seat: Point }).seat
      expect(out.facing).toBe(tileCentre(out.spot).x < seat.x ? 'right' : 'left')
      expect(mascotPose(out, out.startMs + 1).withId).toBeUndefined()
      expect(mascotPose(out, arrivalOf(out) + 1)).toMatchObject({ activity: 'sit_by', frame: 'sit', walking: false, withId: out.withId })
    }
  })

  test('nobody is at work, nobody to sit by: he does the next thing instead', () => {
    const s = scene(stateWorld('waiting_user'))
    const start = initialMascot(1, input(s, T0))
    const out = advanceMascot({ ...start, bag: ['sit_by', 'nap'] }, input(s, endOf(start)))
    expect(out.activity).toBe('nap')
  })

  test('a helper on a stool is never company: only its parent at its desk is', () => {
    const base = roomsWorld()
    let world: World = base
    for (const id of Object.keys(base.agents)) world = changeAgent(world, id, { state: 'finished' })
    // The builder s(6) and its helper on the stool both work; the helper is not somebody to sit by.
    world = changeAgent(world, worldSessionId(6), { state: 'thinking' })
    world = changeAgent(world, worldSubagentId(2), { state: 'editing' })
    const s = scene(world)
    expect(placementOf(s.layout, worldSubagentId(2))?.kind).toBe('stool')
    expect(placementOf(s.layout, worldSessionId(6))?.kind).toBe('desk')
    for (let seed = 1; seed <= 10; seed++) {
      const out = enter(initialMascot(seed, input(s, T0)), 'sit_by', s)
      expect(out.activity, `seed ${seed}`).toBe('sit_by')
      expect(out.withId, `seed ${seed}`).toBe(worldSessionId(6))
    }
  })

  test('it ends when the agent stops working', () => {
    const s = scene(mascotPlayWorld())
    const out = enter(initialMascot(1, input(s, T0)), 'sit_by', s)
    const at = arrivalOf(out) + 500
    const done = scene(changeAgent(mascotPlayWorld(), out.withId as string, { state: 'waiting_permission' }))
    const next = advanceMascot(out, input(done, at))
    expect(next.startMs).toBe(at)
    expect(next.withId === out.withId && next.activity === 'sit_by').toBe(false)
  })
})

describe('playing ball with an idle agent', () => {
  test('he plays with the one agent that has waited for you for a minute, and with nobody else, whatever the seed', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = scene(mascotPlayWorld())
      const out = enter(initialMascot(seed, input(s, T0)), 'play', s)
      expect(out.activity, `seed ${seed}`).toBe('play')
      expect(out.withId, `seed ${seed}: not the permission wait, not the editor, not the planner`).toBe(S1)
    }
  })

  test('he stands within three tiles of its desk, never inside it; he is "with" it only when he has arrived', () => {
    const s = scene(mascotPlayWorld())
    const out = enter(initialMascot(2, input(s, T0)), 'play', s)
    const distance = distanceToCell(deskOf(s, S1), out.spot)
    expect(distance).toBeGreaterThanOrEqual(1)
    expect(distance).toBeLessThanOrEqual(PLAY_MAX_TILES)
    expect(mascotPose(out, out.startMs + 1).play).toBeUndefined()
    expect(mascotPose(out, out.startMs + 1).withId).toBeUndefined()
    const at = mascotPose(out, arrivalOf(out) + 100)
    expect(at.withId).toBe(S1)
    expect(at.play).toBeDefined()
    const seat = (placementOf(s.layout, S1) as { seat: Point }).seat
    expect(at.play?.playerSide).toBe(tileCentre(out.spot).x < seat.x ? 'left' : 'right')
  })

  test('an agent that has waited only thirty seconds is not played with', () => {
    const world = changeAgent(mascotPlayWorld(), S1, { stateSince: new Date(Date.parse(mascotPlayWorld().clock) - (PLAY_IDLE_MS - 30_000)).toISOString() })
    const s = scene(world)
    const start = initialMascot(1, input(s, T0))
    expect(advanceMascot({ ...start, bag: ['play', 'nap'] }, input(s, endOf(start))).activity).toBe('nap')
  })

  test('nor is an agent asking for permission, however long it has waited', () => {
    const s = scene(changeAgent(mascotPlayWorld(), S1, { state: 'waiting_permission' }))
    const start = initialMascot(1, input(s, T0))
    expect(advanceMascot({ ...start, bag: ['play', 'nap'] }, input(s, endOf(start))).activity).toBe('nap')
  })

  test('nor a stuck, rate limited or failed one, nor a helper that waits', () => {
    for (const state of ['stuck', 'rate_limited', 'failed'] as const) {
      const s = scene(changeAgent(mascotPlayWorld(), S1, { state }))
      const start = initialMascot(1, input(s, T0))
      expect(advanceMascot({ ...start, bag: ['play', 'nap'] }, input(s, endOf(start))).activity, state).toBe('nap')
    }
    const base = roomsWorld()
    let world: World = base
    for (const id of Object.keys(base.agents)) world = changeAgent(world, id, { state: 'thinking' })
    world = changeAgent(world, worldSubagentId(2), { state: 'waiting_user', stateSince: new Date(Date.parse(base.clock) - 600_000).toISOString() })
    const s = scene(world)
    expect(placementOf(s.layout, worldSubagentId(2))?.kind).toBe('stool')
    const start = initialMascot(1, input(s, T0))
    expect(advanceMascot({ ...start, bag: ['play', 'nap'] }, input(s, endOf(start))).activity).toBe('nap')
  })

  test('the game has four turns: hold it, throw it, fetch it, bring it back, and starts over', () => {
    expect(playPhase(0)).toMatchObject({ player: 'throw_a', morty: 'wag_a' })
    expect(playPhase(0).ball).toBeUndefined()
    expect(playPhase(200).morty).toBe('wag_b')
    const thrown = playPhase(800)
    expect(thrown).toMatchObject({ player: 'throw_b', morty: 'sit', ball: { fromMorty: false } })
    expect(thrown.ball?.f).toBeCloseTo(0.2, 5)
    expect(playPhase(1500)).toMatchObject({ player: 'throw_b', morty: 'carry_ball' })
    expect(playPhase(1500).ball).toBeUndefined()
    const back = playPhase(2200)
    expect(back).toMatchObject({ player: 'throw_b', morty: 'sit', ball: { fromMorty: true } })
    expect(back.ball?.f).toBeCloseTo(0.5, 5)
    for (const t of [0, 150, 700, 1199, 1200, 1999, 2000, 2399]) expect(playPhase(t + PLAY_PERIOD_MS)).toEqual(playPhase(t))
    for (let t = 700; t < 1200; t += 10) expect(playPhase(t).ball?.f).toBeGreaterThanOrEqual(0)
    for (let t = 700; t < 1200; t += 10) expect(playPhase(t).ball?.f).toBeLessThan(1)
  })

  test('the ball never flies while he is still on his way', () => {
    const s = scene(mascotPlayWorld())
    const out = enter(initialMascot(2, input(s, T0)), 'play', s)
    for (let t = out.startMs; t < arrivalOf(out); t += 40) expect(mascotPose(out, t).play).toBeUndefined()
  })

  test('the game is over the moment the agent\'s state changes: no play, nobody "with" him, at that very time', () => {
    for (const state of ['thinking', 'waiting_permission', 'running', 'stuck', 'finished'] as const) {
      const s = scene(mascotPlayWorld())
      const out = enter(initialMascot(2, input(s, T0)), 'play', s)
      const at = arrivalOf(out) + 700
      const changed = scene(changeAgent(mascotPlayWorld(), S1, { state }))
      const next = advanceMascot(out, input(changed, at))
      expect(next.startMs, state).toBe(at)
      expect(next.activity === 'play' && next.withId === S1, state).toBe(false)
      const pose = mascotPose(next, at)
      expect(pose.play, state).toBeUndefined()
      expect(pose.withId === S1 && pose.activity === 'play', state).toBe(false)
    }
  })

  test('while the agent keeps waiting, the game goes on to the end', () => {
    const s = scene(mascotPlayWorld())
    const out = enter(initialMascot(2, input(s, T0)), 'play', s)
    for (let t = arrivalOf(out); t < endOf(out); t += 100) {
      const now = advanceMascot(out, input(s, t))
      expect(now.activity).toBe('play')
      expect(mascotPose(now, t).play).toBeDefined()
    }
    expect(advanceMascot(out, input(s, endOf(out))).activity).not.toBe(undefined)
  })
})

describe('when the office changes under him', () => {
  test('a napping Morty moves with his basket when the office grows', () => {
    const small = scene(stateWorld('thinking'))
    const big = scene(roomsWorld())
    expect(big.grid.spots.basket).not.toEqual(small.grid.spots.basket)
    const napping = initialMascot(4, input(small, T0))
    const moved = advanceMascot(napping, input(big, T0 + 10))
    expect(moved.activity).toBe('nap')
    expect(moved.spot).toEqual(big.grid.spots.basket)
    expect(moved.path).toEqual([tileCentre(big.grid.spots.basket)])
    expect(moved.gridKey).toBe(big.grid.key)
    expect(mascotPose(moved, T0 + 10).point).toEqual(tileCentre(big.grid.spots.basket))
    // and he stays put while the grid does not change
    expect(advanceMascot(moved, input(big, T0 + 11))).toBe(moved)
  })

  test('a stay on a tile that is no longer one he may stand on ends at once, somewhere else', () => {
    const s = scene(roomsWorld())
    const out = enter(initialMascot(1, input(s, T0)), 'wander', s)
    const at = arrivalOf(out) + 200
    const walkable = s.grid.walkable.slice()
    walkable[out.spot.y * s.grid.cols + out.spot.x] = 0
    const closed: Scene = { ...s, grid: { ...s.grid, walkable, key: 'closed' } }
    const next = advanceMascot(out, input(closed, at))
    expect(next.startMs).toBe(at)
    expect(next.gridKey).toBe('closed')
    expect(next.activity === 'wander' && next.spot.x === out.spot.x && next.spot.y === out.spot.y).toBe(false)
  })

  test('a bubble in his way while he walks: he goes round, from where he is', () => {
    const s = scene(roomsWorld())
    const out = enter(enter(initialMascot(2, input(s, T0)), 'drink', s), 'nap', s)
    // Early in the walk, while he is still in the two-tile hallway (the lobby row is one tile wide: no way round there).
    const mid = out.startMs + Math.floor(out.walkMs * 0.12)
    const here = tileOf(mascotPose(out, mid).point)
    const goal = s.grid.spots.basket
    // Close one tile of the way at a time until one of them leaves a way round.
    const route: Tile[] = findPath(s.grid, here, goal) as Tile[]
    let rerouted: { blocked: Tile; next: MascotState; closed: Scene } | undefined
    for (const blocked of route.slice(1, -1)) {
      const walkable = s.grid.walkable.slice()
      walkable[blocked.y * s.grid.cols + blocked.x] = 0
      const closed: Scene = { ...s, grid: { ...s.grid, walkable, key: `closed ${blocked.x},${blocked.y}` } }
      const round = findPath(closed.grid, here, goal)
      if (round && !round.some((t) => t.x === blocked.x && t.y === blocked.y)) {
        rerouted = { blocked, next: advanceMascot(out, input(closed, mid)), closed }
        break
      }
    }
    expect(rerouted, 'a tile whose closing leaves a way round').toBeDefined()
    const { blocked, next } = rerouted as NonNullable<typeof rerouted>
    expect(next.activity).toBe('nap')
    expect(next.startMs).toBe(mid)
    expect(next.spot).toEqual(goal)
    const before = mascotPose(out, mid).point
    const after = mascotPose(next, mid).point
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(8)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(8)
    for (let t = mid; t < arrivalOf(next); t += 25) {
      const tile = tileOf(mascotPose(next, t).point)
      expect(tile.x === blocked.x && tile.y === blocked.y, `at ${t - mid} ms`).toBe(false)
    }
  })

  test('when bubbles close every way but the furniture leaves one, he walks under them', () => {
    const s = scene(roomsWorld())
    const out = enter(enter(initialMascot(2, input(s, T0)), 'drink', s), 'nap', s)
    const mid = out.startMs + Math.floor(out.walkMs / 3)
    const closed: Scene = { ...s, grid: { ...s.grid, walkable: new Uint8Array(s.grid.walkable.length), key: 'all bubbles' } }
    const next = advanceMascot(out, input(closed, mid))
    expect(next.activity).toBe('nap')
    expect(next.spot).toEqual(s.grid.spots.basket)
    expect(next.walkMs).toBeGreaterThan(0)
    expect(next.startMs).toBe(mid)
  })

  test('a desk he sits by that moves: he follows it', () => {
    const s = scene(mascotPlayWorld())
    const out = enter(initialMascot(1, input(s, T0)), 'sit_by', s)
    const at = arrivalOf(out) + 100
    // A newcomer takes a desk in the same cluster: a new grid, the same desk. He keeps his place while it still serves.
    const crowded = scene(changeAgent(mascotPlayWorld(), S1, { state: 'editing' }))
    const next = advanceMascot(out, input(crowded, at))
    expect(next.withId === out.withId || next.startMs === at).toBe(true)
    if (next.activity === 'sit_by' && next.withId === out.withId) {
      const distance = distanceToCell(deskOf(crowded, out.withId as string), next.spot)
      expect(distance).toBeGreaterThanOrEqual(1)
      expect(distance).toBeLessThanOrEqual(SIT_BY_MAX_TILES)
    }
  })
})

describe('Morty never stands on anything that must stay clear', () => {
  for (const [name, make] of [
    ['mascot-play', mascotPlayWorld],
    ['rooms', roomsWorld],
    ['crowd-100', crowd100World],
  ] as const) {
    test(`over half an hour of his day, sampled every 50 ms: ${name}`, () => {
      const s = scene(make())
      const clear: Rect[] = staticObstacles(s.layout)
      const bubbles: Rect[] = bubbleObstacles(s.world, s.layout)
      const basket = s.grid.spots.basket
      let state = initialMascot(21, input(s, T0))
      let samples = 0
      for (let t = T0; t <= T0 + 30 * 60_000; t += 50) {
        state = advanceMascot(state, input(s, t))
        const { point } = mascotPose(state, t)
        const body: Rect = { x: point.x - 8, y: point.y - 4, w: 16, h: 12 }
        const tiles: Tile[] = []
        for (let y = Math.floor(body.y / 16); y <= Math.floor((body.y + body.h - 1) / 16); y++) {
          for (let x = Math.floor(body.x / 16); x <= Math.floor((body.x + body.w - 1) / 16); x++) tiles.push({ x, y })
        }
        expect(tiles.length, `at ${t}: he is in one tile or two`).toBeLessThanOrEqual(2)
        for (const tile of tiles) {
          const ok = isWalkable(s.grid, tile, true) || (tile.x === basket.x && tile.y === basket.y)
          if (!ok) expect.fail(`at ${t} ms he is on (${tile.x},${tile.y}), which is not floor he may stand on (${state.activity})`)
        }
        for (const rect of clear) if (rectsOverlap(body, rect)) expect.fail(`at ${t} ms he covers a lamp, monitor or tag (${state.activity})`)
        for (const rect of bubbles) if (rectsOverlap(body, rect)) expect.fail(`at ${t} ms he is under a bubble's place (${state.activity}), on (${tiles.map((x) => `${x.x},${x.y}`).join(' ')}) ${JSON.stringify(rect)}`)
        samples++
      }
      expect(samples).toBeGreaterThan(30_000)
      expect(tileRect(basket).w).toBe(16)
    })
  }
})

describe('what he gets up to in a day', () => {
  function activitiesIn(world: World, minutes: number): Set<MascotActivity> {
    const s = scene(world)
    const seen = new Set<MascotActivity>()
    for (const seed of [1, 2, 3]) {
      let state = initialMascot(seed, input(s, T0))
      for (let t = T0; t <= T0 + minutes * 60_000; t += 500) {
        state = advanceMascot(state, input(s, t))
        seen.add(state.activity)
      }
    }
    return seen
  }

  test('with an idle agent, a working one and a planner: naps, drinks, wanders, sits by, plays (and the planner blocks the whiteboard)', () => {
    const seen = activitiesIn(mascotPlayWorld(), 30)
    for (const activity of ['nap', 'drink', 'wander', 'sit_by', 'play'] as const) expect(seen.has(activity), activity).toBe(true)
    expect(seen.has('sniff'), 'a planner sits under the whiteboard').toBe(false)
  })

  test('in an office with an empty planning room he sniffs the whiteboard, and with nobody idle he never plays', () => {
    const seen = activitiesIn(stateWorld('thinking'), 30)
    for (const activity of ['nap', 'drink', 'wander', 'sit_by', 'sniff'] as const) expect(seen.has(activity), activity).toBe(true)
    expect(seen.has('play')).toBe(false)
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
