// Morty, the office corgi: what he does (cubiclark-morty §2.4). Pure, like the rest of core: the
// clock is passed in as `nowMs`, and every "random" choice comes from a seed, so each activity is a
// unit test and a fixture can freeze him in any of them.
//
// He does one thing at a time. Each round a shuffled bag of activities is dealt out: he walks to the
// place for the next one (by the paths of mascot-map.ts), stays there for a while the seed decides,
// and moves on. A new arrival at the door cuts what he is doing short. He is not an agent: nothing
// here reads or changes an agent's state, and "playing" is something he does beside an agent that is
// waiting for you anyway. The moment that agent's state changes, the game is over.

import type { AgentState, World } from '../types.js'
import type { Point } from './geometry.js'
import { placementOf, type OfficeLayout } from './layout.js'
import {
  cornerPoints,
  distanceToCell,
  findPath,
  fnv1a,
  isWalkable,
  reachableTiles,
  roomOf,
  spotNearCell,
  tileCentre,
  tileOf,
  type MascotGrid,
  type Tile,
} from './mascot-map.js'
import type { Actor } from './motion.js'
import type { Direction } from './visual.js'

/** Every frame Morty is drawn in (src/client/office/art/mascot.ts). The side frames face right. */
export const MORTY_FRAME_NAMES = [
  'walk_side_a',
  'walk_side_b',
  'walk_down_a',
  'walk_down_b',
  'walk_up_a',
  'walk_up_b',
  'sit',
  'wag_a',
  'wag_b',
  'sleep_a',
  'sleep_b',
  'drink_a',
  'drink_b',
  'sniff_a',
  'sniff_b',
  'carry_ball',
] as const

export type MortyFrame = (typeof MORTY_FRAME_NAMES)[number]

/** What Morty is called to a pointer and to a screen reader: a mascot, never an agent. */
export const MASCOT_LABEL = 'Morty (mascot)'

/** The remembered choice. Only `off` turns him off: anything else (nothing stored, a value from a
 * hand-edited storage) leaves him on, as he is by default. */
export function parseMascotChoice(raw: unknown): boolean {
  return raw !== 'off'
}

/** The header button's text: what he is now. */
export function mascotButtonText(on: boolean): string {
  return on ? 'Morty: on' : 'Morty: off'
}

// --- The activities ---------------------------------------------------------------------------

export type MascotActivity = 'nap' | 'wander' | 'drink' | 'greet' | 'sit_by' | 'play' | 'sniff'

/** One round: every activity but greeting (which only an arrival starts), wandering twice. */
export const BAG: readonly MascotActivity[] = ['nap', 'drink', 'wander', 'sit_by', 'play', 'sniff', 'wander']

/** [min, max] ms of each stay, drawn from the seed. `first_nap` is the one he starts the day with. */
export const STAY_MS: Record<MascotActivity | 'first_nap', readonly [number, number]> = {
  first_nap: [3000, 8000],
  nap: [12_000, 20_000],
  drink: [4000, 6000],
  wander: [2000, 4000],
  greet: [3000, 3000],
  sit_by: [6000, 10_000],
  play: [10_000, 16_000],
  sniff: [3000, 4000],
}

export const MASCOT_PX_PER_S = 80
/** An agent must have been waiting for you this long before Morty will play with it. */
export const PLAY_IDLE_MS = 60_000
/** He greets at most once in this long, however many arrive. */
export const GREET_GAP_MS = 20_000
export const PLAY_PERIOD_MS = 2400
/** How far from a desk (in tiles) he sits by it, and plays by it. */
export const SIT_BY_MAX_TILES = 2
export const PLAY_MAX_TILES = 3
/** A stay moved along with his furniture lasts at least this long. */
const MIN_MOVED_STAY_MS = 1000
/** The most stays one advance settles before it starts afresh from `nowMs` (a page left asleep for hours). */
const MAX_SETTLED_STAYS = 64

/** The states of an agent that is at work: the ones he sits beside. */
export const WORKING_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'thinking',
  'reading',
  'searching',
  'browsing',
  'editing',
  'running',
  'delegating',
])

// --- State ------------------------------------------------------------------------------------

export interface MascotState {
  seed: number
  /** The generator's state: every choice draws from it, so the same seed plays out the same day. */
  rng: number
  /** What is left of this round. */
  bag: readonly MascotActivity[]
  activity: MascotActivity
  /** The agent he is sitting by or playing with. */
  withId?: string
  /** The tile the stay is on. */
  spot: Tile
  /** px corners of the walk; the first is where he set off. One point when he did not move. */
  path: readonly Point[]
  /** When the walk starts. He arrives at `startMs + walkMs` and leaves at `+ stayMs`. */
  startMs: number
  walkMs: number
  /** Infinity while he is frozen. */
  stayMs: number
  /** Which way he faces during the stay: left or right, or up for the bowl and the whiteboard. */
  facing: Direction
  /** The key of the grid this was planned on: a replan is due when it changes. */
  gridKey: string
  lastGreetMs: number
  /** Reduced motion: asleep in his basket, for as long as it lasts. */
  frozen: boolean
}

export interface MascotInput {
  nowMs: number
  world: World
  layout: OfficeLayout
  grid: MascotGrid
  actors: ReadonlyMap<string, Actor>
  reducedMotion: boolean
  /** Agents that started walking in from the door at this update (none on a frame of the loop). */
  arrivals: readonly string[]
}

/** mulberry32: a fast 32-bit generator with a one-word state, so it fits in MascotState. */
export function nextRandom(rng: number): [value: number, rng: number] {
  const state = (rng + 0x6d2b79f5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return [((t ^ (t >>> 14)) >>> 0) / 4_294_967_296, state]
}

/** A new day, a new Morty: the seed is the World's date. */
export function mascotSeed(clock: string): number {
  return fnv1a(`Morty ${clock.slice(0, 10)}`)
}

function stayFor(key: MascotActivity | 'first_nap', rng: number): [number, number] {
  const [min, max] = STAY_MS[key]
  const [value, next] = nextRandom(rng)
  return [min + Math.round(value * (max - min)), next]
}

/** Fisher-Yates, from the seed. */
function shuffled(items: readonly MascotActivity[], rng: number): [MascotActivity[], number] {
  const out = [...items]
  let state = rng
  for (let i = out.length - 1; i > 0; i--) {
    const [value, next] = nextRandom(state)
    state = next
    const j = Math.floor(value * (i + 1))
    const swap = out[i] as MascotActivity
    out[i] = out[j] as MascotActivity
    out[j] = swap
  }
  return [out, state]
}

// --- Walking ----------------------------------------------------------------------------------

function pathLength(path: readonly Point[]): number {
  let length = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  }
  return length
}

const walkMsOf = (path: readonly Point[]): number => Math.round((pathLength(path) / MASCOT_PX_PER_S) * 1000)

/** The shortest way over the tiles he may stand on now, else (bubbles close every way) under the
 * bubbles: they are drawn over him, and lamps, monitors and tags are still kept clear. */
function planPath(grid: MascotGrid, from: Tile, to: Tile): Tile[] | undefined {
  return findPath(grid, from, to) ?? findPath(grid, from, to, true)
}

function directionOf(a: Point, b: Point): Direction {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx > 0 ? 'right' : 'left'
  if (dy !== 0) return dy > 0 ? 'down' : 'up'
  return 'down'
}

/** Where he is a fraction `f` (0 to 1) of the way along a path, in whole px, and which way he faces. */
function alongPath(path: readonly Point[], f: number): { point: Point; facing: Direction } {
  const last = path[path.length - 1] as Point
  let remaining = Math.max(0, Math.min(1, f)) * pathLength(path)
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const segment = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    if (segment > 0 && remaining <= segment) {
      const along = remaining / segment
      return {
        point: { x: Math.round(a.x + (b.x - a.x) * along), y: Math.round(a.y + (b.y - a.y) * along) },
        facing: directionOf(a, b),
      }
    }
    remaining -= segment
  }
  const before = path[path.length - 2] ?? last
  return { point: last, facing: directionOf(before, last) }
}

function pointAt(state: MascotState, nowMs: number): Point {
  const last = state.path[state.path.length - 1] as Point
  if (state.frozen || nowMs >= state.startMs + state.walkMs || state.walkMs <= 0) return last
  return alongPath(state.path, (nowMs - state.startMs) / state.walkMs).point
}

const currentTile = (state: MascotState, nowMs: number): Tile => tileOf(pointAt(state, nowMs))

// --- Deciding what next -----------------------------------------------------------------------

interface Plan {
  spot: Tile
  tiles: Tile[]
  facing: Direction
  withId?: string
}

function planTo(grid: MascotGrid, from: Tile, spot: Tile, facing: Direction, withId?: string): Plan | undefined {
  const tiles = planPath(grid, from, spot)
  return tiles ? { spot, tiles, facing, ...(withId === undefined ? {} : { withId }) } : undefined
}

/** How long an agent has been in its state, in ms; NaN when its times do not parse. */
function inStateMs(world: World, agentId: string): number {
  const agent = world.agents[agentId]
  return agent ? Date.parse(world.clock) - Date.parse(agent.stateSince) : Number.NaN
}

/** Whether an agent is someone to sit by (working) or to play with (waiting for you, for a while),
 * seated at its own desk. A helper on a stool or the bench is never either. */
function isCompany(activity: 'sit_by' | 'play', agentId: string, input: MascotInput): boolean {
  const agent = input.world.agents[agentId]
  const placement = placementOf(input.layout, agentId)
  if (!agent || placement?.kind !== 'desk' || input.actors.get(agentId)?.phase !== 'seated') return false
  if (activity === 'sit_by') return WORKING_STATES.has(agent.state)
  return agent.state === 'waiting_user' && inStateMs(input.world, agentId) >= PLAY_IDLE_MS
}

function planCompany(activity: 'sit_by' | 'play', from: Tile, input: MascotInput, rng: number): [Plan | undefined, number] {
  const { layout, grid } = input
  const candidates = layout.placements.filter((placement) => placement.kind === 'desk' && isCompany(activity, placement.agentId, input))
  if (candidates.length === 0) return [undefined, rng]
  const [value, next] = nextRandom(rng)
  const start = Math.floor(value * candidates.length)
  for (let i = 0; i < candidates.length; i++) {
    const placement = candidates[(start + i) % candidates.length]
    const desk = layout.desks.find((d) => d.id === placement?.deskId)
    if (!placement || !desk) continue
    const spot = spotNearCell(grid, desk.rect, activity === 'play' ? PLAY_MAX_TILES : SIT_BY_MAX_TILES, from)
    if (!spot) continue
    const plan = planTo(grid, from, spot, tileCentre(spot).x < placement.seat.x ? 'right' : 'left', placement.agentId)
    if (plan) return [plan, next]
  }
  return [undefined, next]
}

function planWander(from: Tile, input: MascotInput, rng: number): [Plan | undefined, number] {
  const { layout, grid } = input
  const reachable = reachableTiles(grid, from)
  const here = roomOf(layout, from)
  const byRoom = new Map<string, Tile[]>()
  for (const tile of reachable) {
    const room = roomOf(layout, tile)
    if (room === undefined || room === 'hall' || room === here) continue
    byRoom.set(room, [...(byRoom.get(room) ?? []), tile])
  }
  const others = reachable.filter((tile) => tile.x !== from.x || tile.y !== from.y)
  const rooms = [...byRoom.values()]
  let state = rng
  let pool: Tile[] | undefined
  if (rooms.length > 0) {
    const [value, next] = nextRandom(state)
    state = next
    pool = rooms[Math.floor(value * rooms.length)]
  } else if (others.length > 0) {
    pool = others
  }
  if (!pool || pool.length === 0) return [undefined, state]
  const [pick, afterPick] = nextRandom(state)
  const [turn, afterTurn] = nextRandom(afterPick)
  const spot = pool[Math.floor(pick * pool.length)] as Tile
  return [planTo(grid, from, spot, turn < 0.5 ? 'left' : 'right'), afterTurn]
}

function planActivity(activity: MascotActivity, from: Tile, input: MascotInput, rng: number): [Plan | undefined, number] {
  const { grid } = input
  switch (activity) {
    case 'nap':
      return [planTo(grid, from, grid.spots.basket, 'right'), rng]
    case 'drink':
      return [isWalkable(grid, grid.spots.drink) ? planTo(grid, from, grid.spots.drink, 'up') : undefined, rng]
    case 'sniff':
      return [isWalkable(grid, grid.spots.whiteboard) ? planTo(grid, from, grid.spots.whiteboard, 'up') : undefined, rng]
    case 'greet':
      return [isWalkable(grid, grid.spots.door) ? planTo(grid, from, grid.spots.door, 'left') : undefined, rng]
    case 'wander':
      return planWander(from, input, rng)
    case 'sit_by':
    case 'play':
      return planCompany(activity, from, input, rng)
  }
}

/** The state that starts `activity` on `plan` at `atMs`. */
function begin(state: MascotState, activity: MascotActivity, plan: Plan, atMs: number, rng: number, bag: readonly MascotActivity[], input: MascotInput): MascotState {
  const path = cornerPoints(plan.tiles)
  const [stayMs, next] = stayFor(activity, rng)
  return {
    ...state,
    rng: next,
    bag,
    activity,
    withId: plan.withId,
    spot: plan.spot,
    path,
    startMs: atMs,
    walkMs: walkMsOf(path),
    stayMs,
    facing: plan.facing,
    gridKey: input.grid.key,
    frozen: false,
  }
}

/** Deals the next activity that can be done now, starting at `atMs` from tile `from`. The first in
 * the bag that has somewhere to go wins; if none has, he naps where he is. */
function chooseNext(state: MascotState, from: Tile, atMs: number, input: MascotInput): MascotState {
  let rng = state.rng
  let bag: MascotActivity[] = [...state.bag]
  for (let tries = 0; tries < 2 * BAG.length; tries++) {
    if (bag.length === 0) [bag, rng] = shuffled(BAG, rng)
    const activity = bag.shift() as MascotActivity
    const [plan, next] = planActivity(activity, from, input, rng)
    rng = next
    if (plan) return begin(state, activity, plan, atMs, rng, bag, input)
  }
  // Nothing is possible (a walled-in office): rest where he stands.
  const here: Plan = { spot: from, tiles: [from], facing: 'right' }
  return begin(state, 'nap', here, atMs, rng, bag, input)
}

// --- The machine ------------------------------------------------------------------------------

function freeze(state: MascotState, input: MascotInput): MascotState {
  const basket = input.grid.spots.basket
  return {
    ...state,
    activity: 'nap',
    withId: undefined,
    spot: basket,
    path: [tileCentre(basket)],
    startMs: input.nowMs,
    walkMs: 0,
    stayMs: Number.POSITIVE_INFINITY,
    facing: 'right',
    gridKey: input.grid.key,
    frozen: true,
  }
}

/** Morty at the start of a day: in his basket, napping. Under reduced motion, asleep there. */
export function initialMascot(seed: number, input: MascotInput): MascotState {
  const [bag, afterBag] = shuffled(BAG, seed)
  const [stayMs, rng] = stayFor('first_nap', afterBag)
  const basket = input.grid.spots.basket
  const state: MascotState = {
    seed,
    rng,
    bag,
    activity: 'nap',
    spot: basket,
    path: [tileCentre(basket)],
    startMs: input.nowMs,
    walkMs: 0,
    stayMs,
    facing: 'right',
    gridKey: input.grid.key,
    lastGreetMs: Number.NEGATIVE_INFINITY,
    frozen: false,
  }
  return input.reducedMotion ? freeze(state, input) : state
}

/** The tile an activity's stay is on now, given where he is: its fixed spot, or (beside an agent)
 * the one he has if it still serves, else the nearest. Undefined when there is none any more. */
function respot(state: MascotState, here: Tile, input: MascotInput): Tile | undefined {
  const { grid, layout } = input
  switch (state.activity) {
    case 'nap':
      return grid.spots.basket
    case 'drink':
      return isWalkable(grid, grid.spots.drink) ? grid.spots.drink : undefined
    case 'sniff':
      return isWalkable(grid, grid.spots.whiteboard) ? grid.spots.whiteboard : undefined
    case 'greet':
      return isWalkable(grid, grid.spots.door) ? grid.spots.door : undefined
    case 'wander':
      return isWalkable(grid, state.spot) ? state.spot : undefined
    case 'sit_by':
    case 'play': {
      const placement = state.withId === undefined ? undefined : placementOf(layout, state.withId)
      const desk = layout.desks.find((d) => d.id === placement?.deskId)
      if (!desk) return undefined
      const reach = state.activity === 'play' ? PLAY_MAX_TILES : SIT_BY_MAX_TILES
      const distance = distanceToCell(desk.rect, state.spot)
      if (isWalkable(grid, state.spot) && distance >= 1 && distance <= reach) return state.spot
      return spotNearCell(grid, desk.rect, reach, here)
    }
  }
}

/** The grid changed (an agent came or went, a bubble appeared): his spot may have moved, or a bubble
 * may now be in his way. He moves with his furniture, walks round, or picks something else. */
function replan(state: MascotState, input: MascotInput): MascotState {
  const { nowMs, grid } = input
  const here = currentTile(state, nowMs)
  const spot = respot(state, here, input)
  if (!spot) return chooseNext(state, here, nowMs, input)
  const arrived = nowMs >= state.startMs + state.walkMs
  if (arrived) {
    if (spot.x === state.spot.x && spot.y === state.spot.y) return { ...state, gridKey: grid.key }
    const end = state.startMs + state.walkMs + state.stayMs
    return { ...state, spot, path: [tileCentre(spot)], startMs: nowMs, walkMs: 0, stayMs: Math.max(MIN_MOVED_STAY_MS, end - nowMs), gridKey: grid.key }
  }
  const tiles = planPath(grid, here, spot)
  if (!tiles) return chooseNext(state, here, nowMs, input)
  const path = cornerPoints(tiles)
  return { ...state, spot, path, startMs: nowMs, walkMs: walkMsOf(path), gridKey: grid.key }
}

/** Playing or sitting by an agent ends the moment the agent stops being that: it changed state, it
 * left its desk, or (for playing) it is not a minute into waiting for you any more. */
function checkCompany(state: MascotState, input: MascotInput): MascotState {
  if (state.activity !== 'play' && state.activity !== 'sit_by') return state
  if (state.withId !== undefined && isCompany(state.activity, state.withId, input)) return state
  return chooseNext(state, currentTile(state, input.nowMs), input.nowMs, input)
}

/** An agent walking in from the door: he goes to the door and wags, at most once in GREET_GAP_MS. */
function greetArrival(state: MascotState, input: MascotInput): MascotState {
  const { nowMs } = input
  if (input.arrivals.length === 0 || state.activity === 'greet' || nowMs - state.lastGreetMs < GREET_GAP_MS) return state
  const [plan, rng] = planActivity('greet', currentTile(state, nowMs), input, state.rng)
  if (!plan) return state
  return { ...begin(state, 'greet', plan, nowMs, rng, state.bag, input), lastGreetMs: nowMs }
}

/** Moves on from every stay that is over by `nowMs`, each starting where the last one ended (so a
 * jump in time and a step by step run arrive at the same place). */
function finishStays(state: MascotState, input: MascotInput): MascotState {
  const { nowMs } = input
  let current = state
  for (let settled = 0; nowMs >= current.startMs + current.walkMs + current.stayMs; settled++) {
    const endedAt = current.startMs + current.walkMs + current.stayMs
    if (settled >= MAX_SETTLED_STAYS) return chooseNext(current, current.spot, nowMs, input)
    current = chooseNext(current, current.spot, endedAt, input)
  }
  return current
}

/** Brings Morty up to `input.nowMs` in a World. Returns the same object when nothing changed. */
export function advanceMascot(state: MascotState, input: MascotInput): MascotState {
  const { nowMs, grid } = input
  if (input.reducedMotion) return state.frozen && state.gridKey === grid.key ? state : freeze(state, input)
  if (state.frozen) return chooseNext(state, grid.spots.basket, nowMs, input)
  // What is over is over first, so that what is judged below (the grid, the company, an arrival) is
  // what he is doing *now*, however long since the last frame.
  let next = finishStays(state, input)
  if (next.gridKey !== grid.key) next = replan(next, input)
  next = checkCompany(next, input)
  return greetArrival(next, input)
}

// --- What to draw -----------------------------------------------------------------------------

/** One turn of the game of ball, over PLAY_PERIOD_MS: the agent holds the ball, throws it, Morty
 * fetches it and brings it back. */
export function playPhase(tMs: number): { player: 'throw_a' | 'throw_b'; morty: MortyFrame; ball?: { fromMorty: boolean; f: number } } {
  const t = ((tMs % PLAY_PERIOD_MS) + PLAY_PERIOD_MS) % PLAY_PERIOD_MS
  if (t < 700) return { player: 'throw_a', morty: Math.floor(t / 175) % 2 === 0 ? 'wag_a' : 'wag_b' }
  if (t < 1200) return { player: 'throw_b', morty: 'sit', ball: { fromMorty: false, f: (t - 700) / 500 } }
  if (t < 2000) return { player: 'throw_b', morty: 'carry_ball' }
  return { player: 'throw_b', morty: 'sit', ball: { fromMorty: true, f: (t - 2000) / 400 } }
}

export interface MascotPose {
  activity: MascotActivity
  walking: boolean
  /** px: the middle of the tile his feet are on, or on the way between two. */
  point: Point
  frame: MortyFrame
  /** The frame is drawn flipped (the side frames face right). */
  mirror: boolean
  /** The agent he is with, once he has arrived: only for sitting by and playing. */
  withId?: string
  /** Only while playing: which pose the agent is in, which side of its desk it stands on, and the ball in the air. */
  play?: { player: 'throw_a' | 'throw_b'; playerSide: 'left' | 'right'; ball?: { fromMorty: boolean; f: number } }
}

const alternate = (t: number, periodMs: number, a: MortyFrame, b: MortyFrame): MortyFrame => (Math.floor(t / periodMs) % 2 === 0 ? a : b)

/** The one picture Morty is at `nowMs`. */
export function mascotPose(state: MascotState, nowMs: number): MascotPose {
  const last = state.path[state.path.length - 1] as Point
  if (state.frozen) return { activity: 'nap', walking: false, point: last, frame: 'sleep_a', mirror: false }

  const arrival = state.startMs + state.walkMs
  if (nowMs < arrival) {
    const { point, facing } = alongPath(state.path, (nowMs - state.startMs) / state.walkMs)
    const step = Math.floor((nowMs - state.startMs) / 150) % 2 === 0 ? 'a' : 'b'
    const frame: MortyFrame =
      facing === 'up' ? `walk_up_${step}` : facing === 'down' ? `walk_down_${step}` : `walk_side_${step}`
    return { activity: state.activity, walking: true, point, frame, mirror: facing === 'left' }
  }

  const t = nowMs - arrival
  const mirror = state.facing === 'left'
  const still = (frame: MortyFrame, withId?: string): MascotPose => ({
    activity: state.activity,
    walking: false,
    point: last,
    frame,
    mirror: frame === 'drink_a' || frame === 'drink_b' || frame === 'sniff_a' || frame === 'sniff_b' ? false : mirror,
    ...(withId === undefined ? {} : { withId }),
  })
  switch (state.activity) {
    case 'nap':
      return still(alternate(t, 1200, 'sleep_a', 'sleep_b'))
    case 'drink':
      return still(alternate(t, 250, 'drink_a', 'drink_b'))
    case 'greet':
      return still(alternate(t, 120, 'wag_a', 'wag_b'))
    case 'sniff':
      return still(alternate(t, 200, 'sniff_a', 'sniff_b'))
    case 'wander':
      return still('sit')
    case 'sit_by':
      return still('sit', state.withId)
    case 'play': {
      const phase = playPhase(t)
      return {
        ...still(phase.morty, state.withId),
        play: {
          player: phase.player,
          // The agent stands on the side of its desk that Morty is on: he faces the desk, so he is on the other side of where he faces.
          playerSide: state.facing === 'right' ? 'left' : 'right',
          ...(phase.ball ? { ball: phase.ball } : {}),
        },
      }
    }
  }
}
