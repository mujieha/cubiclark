// What each state looks like (design §6, binding) as data: pose, bubble, lamp, screen, dimming and
// board tag per state, plus the pure functions that turn an Agent into the bubble the renderer
// draws. No canvas here, so the truth-telling rule "two states never render alike" is a unit test.

import type { Agent, AgentState, World } from '../types.js'
import type { Point } from './geometry.js'
import { placementOf, type OfficeLayout } from './layout.js'

export type Pose =
  | 'settle'
  | 'type_slow'
  | 'type'
  | 'type_fast'
  | 'lean_fwd'
  | 'side'
  | 'stand_wave'
  | 'lean_back'
  | 'shuffle'
  | 'frozen'
  | 'sleep'
  | 'slump'
  | 'walk_out'

export type BubbleIcon =
  | 'spark'
  | 'dots'
  | 'book'
  | 'magnifier'
  | 'globe'
  | 'pencil'
  | 'prompt'
  | 'arrow'
  | 'question'
  | 'stack'
  | 'bang'
  | 'zzz'
  | 'cross'

export type BubbleStyle = 'plain' | 'alert' | 'muted'
export type BubbleText = 'none' | 'target' | 'verb' | 'child' | 'quiet' | 'reset'
export type Lamp = 'off' | 'red' | 'amber'
/** A monitor: dark (off, or still booting), lit, flickering while a command runs, or showing an error. */
export type Screen = 'off' | 'on' | 'flicker' | 'error'
export type Tag = 'check' | 'exit'
export type Direction = 'left' | 'right' | 'up' | 'down'

export interface StateVisual {
  pose: Pose
  bubble?: { icon: BubbleIcon; style: BubbleStyle; pulse: boolean; text: BubbleText }
  lamp: Lamp
  screen: Screen
  dim: boolean
  /** Only for agents shown on the lobby board. */
  tag?: Tag
}

const plain = (icon: BubbleIcon, text: BubbleText = 'none'): StateVisual['bubble'] => ({ icon, style: 'plain', pulse: false, text })

export const STATE_VISUALS: Record<AgentState, StateVisual> = {
  // The screen is still dark: the agent has only just sat down.
  starting: { pose: 'settle', bubble: plain('spark'), lamp: 'off', screen: 'off', dim: false },
  thinking: { pose: 'type_slow', bubble: plain('dots'), lamp: 'off', screen: 'on', dim: false },
  reading: { pose: 'lean_fwd', bubble: plain('book', 'target'), lamp: 'off', screen: 'on', dim: false },
  searching: { pose: 'lean_fwd', bubble: plain('magnifier', 'target'), lamp: 'off', screen: 'on', dim: false },
  browsing: { pose: 'lean_fwd', bubble: plain('globe', 'target'), lamp: 'off', screen: 'on', dim: false },
  editing: { pose: 'type_fast', bubble: plain('pencil', 'target'), lamp: 'off', screen: 'on', dim: false },
  running: { pose: 'type', bubble: plain('prompt', 'verb'), lamp: 'off', screen: 'flicker', dim: false },
  delegating: { pose: 'side', bubble: plain('arrow', 'child'), lamp: 'off', screen: 'on', dim: false },
  waiting_permission: {
    pose: 'stand_wave',
    bubble: { icon: 'question', style: 'alert', pulse: true, text: 'none' },
    lamp: 'red',
    screen: 'on',
    dim: false,
  },
  waiting_user: { pose: 'lean_back', lamp: 'amber', screen: 'on', dim: false },
  compacting: { pose: 'shuffle', bubble: plain('stack'), lamp: 'off', screen: 'on', dim: false },
  stuck: {
    pose: 'frozen',
    bubble: { icon: 'bang', style: 'muted', pulse: false, text: 'quiet' },
    lamp: 'off',
    screen: 'on',
    dim: true,
  },
  rate_limited: { pose: 'sleep', bubble: plain('zzz', 'reset'), lamp: 'off', screen: 'off', dim: false },
  failed: {
    pose: 'slump',
    bubble: { icon: 'cross', style: 'alert', pulse: false, text: 'none' },
    lamp: 'off',
    // Red, not dark: the one thing that tells a failed agent from a rate-limited one at a glance.
    screen: 'error',
    dim: false,
  },
  finished: { pose: 'walk_out', lamp: 'off', screen: 'off', dim: false, tag: 'check' },
  ended: { pose: 'walk_out', lamp: 'off', screen: 'off', dim: false, tag: 'exit' },
}

// --- Frames ---------------------------------------------------------------------------------

export interface FrameRef {
  /** A key of CHARACTER_FRAMES (src/client/office/art/characters.ts). */
  name: string
  /** Whole-sprite vertical offset in px: 1 is a bob or a breath. */
  dy: number
  mirror: boolean
}

const frame = (name: string, dy = 0, mirror = false): FrameRef => ({ name, dy, mirror })

export const POSE_FRAMES: Record<Pose, { frames: FrameRef[]; periodMs: number }> = {
  settle: { frames: [frame('sit_idle_a'), frame('sit_idle_b')], periodMs: 1600 },
  type_slow: { frames: [frame('sit_type_a'), frame('sit_type_b', 1)], periodMs: 1200 },
  type: { frames: [frame('sit_type_a'), frame('sit_type_b')], periodMs: 600 },
  type_fast: { frames: [frame('sit_type_a'), frame('sit_type_b')], periodMs: 300 },
  lean_fwd: { frames: [frame('sit_lean_fwd_a'), frame('sit_lean_fwd_b')], periodMs: 1400 },
  side: { frames: [frame('sit_side'), frame('sit_side', 1)], periodMs: 1600 },
  // Standing up: two px taller than anyone sitting, so a waiting agent stands out in a row of desks.
  stand_wave: { frames: [frame('stand_wave_a', -2), frame('stand_wave_b', -2)], periodMs: 500 },
  lean_back: { frames: [frame('sit_lean_back'), frame('sit_lean_back', 1)], periodMs: 2400 },
  shuffle: { frames: [frame('sit_shuffle_a'), frame('sit_shuffle_b')], periodMs: 700 },
  frozen: { frames: [frame('sit_type_a')], periodMs: 1000 },
  sleep: { frames: [frame('sit_sleep'), frame('sit_sleep', 1)], periodMs: 2400 },
  slump: { frames: [frame('sit_slump')], periodMs: 1000 },
  walk_out: { frames: [frame('walk_side_a'), frame('walk_side_b')], periodMs: 400 },
}

/** The frame of a pose at time `tMs`. Reduced motion (and the frozen pose) always shows the first. */
export function frameAt(pose: Pose, tMs: number, reducedMotion: boolean): FrameRef {
  const { frames, periodMs } = POSE_FRAMES[pose]
  const first = frames[0] as FrameRef
  if (reducedMotion || pose === 'frozen' || frames.length === 1) return first
  const phase = ((tMs % periodMs) + periodMs) % periodMs
  return frames[Math.floor(phase / (periodMs / frames.length))] ?? first
}

// --- Bubbles --------------------------------------------------------------------------------

/** Bubble text is capped so a bubble never grows much wider than its desk cell. 12 keeps an
 * ordinary host name such as `example.com` whole. */
export const BUBBLE_TEXT_MAX = 12

export interface ResolvedBubble {
  icon: BubbleIcon
  style: BubbleStyle
  pulse: boolean
  text?: string
  /** Only for the delegating arrow: which way it points. */
  direction?: Direction
}

/** "45s", "12m" or "3h": how long, in the coarsest unit that is not zero. */
export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

function truncate(text: string): string {
  return text.length > BUBBLE_TEXT_MAX ? `${text.slice(0, BUBBLE_TEXT_MAX - 1)}…` : text
}

const GONE: ReadonlySet<AgentState> = new Set(['finished', 'failed', 'ended'])

function firstLiveChild(agent: Agent, world: World): Agent | undefined {
  return Object.values(world.agents)
    .filter((other) => other.parentId === agent.id && !GONE.has(other.state))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
}

/** The dominant axis from one point to another; a tie goes horizontal. */
export function directionBetween(from: Point, to: Point): Direction {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'down' : 'up'
}

function arrowDirection(agent: Agent, child: Agent | undefined, officeLayout: OfficeLayout): Direction {
  const from = placementOf(officeLayout, agent.id)
  const to = child ? placementOf(officeLayout, child.id) : undefined
  return from && to ? directionBetween(from.seat, to.seat) : 'right'
}

function bubbleText(kind: BubbleText, agent: Agent, world: World, child: Agent | undefined): string | undefined {
  const nowMs = Date.parse(world.clock)
  switch (kind) {
    case 'none':
      return undefined
    case 'target':
    case 'verb':
      return agent.currentTool?.target
    case 'child':
      return child ? (child.label ?? child.kind) : undefined
    case 'quiet':
      return formatAgo(nowMs - Date.parse(agent.lastActivity))
    case 'reset': {
      const reset = world.quota?.resets5h
      const untilMs = reset === undefined ? Number.NaN : Date.parse(reset) - nowMs
      return Number.isNaN(untilMs) || untilMs <= 0 ? undefined : formatAgo(untilMs)
    }
  }
}

/** Fills a state's bubble from the World: the file or host, the command verb, the subagent's label,
 * how long an agent has been quiet, or when the quota resets. Undefined when the state has no
 * bubble. Reduced motion turns the pulse off. */
export function resolveBubble(agent: Agent, world: World, officeLayout: OfficeLayout, reducedMotion: boolean): ResolvedBubble | undefined {
  const spec = STATE_VISUALS[agent.state].bubble
  if (!spec) return undefined
  const child = spec.text === 'child' || spec.icon === 'arrow' ? firstLiveChild(agent, world) : undefined
  const text = bubbleText(spec.text, agent, world, child)
  return {
    icon: spec.icon,
    style: spec.style,
    pulse: spec.pulse && !reducedMotion,
    text: text === undefined ? undefined : truncate(text),
    direction: spec.icon === 'arrow' ? arrowDirection(agent, child, officeLayout) : undefined,
  }
}

export function lampFor(agent: Agent): Lamp {
  return STATE_VISUALS[agent.state].lamp
}

// --- Empty scenes: one office per empty screen ----------------------------------------------

export type EmptySceneId = 'no-data' | 'unreadable' | 'no-collector' | 'no-agents'

export interface EmptyScene {
  lights: 'off' | 'on'
  door: 'open' | 'closed'
  prop?: 'clock' | 'plug' | 'cabinet'
}

export const EMPTY_SCENES: Record<EmptySceneId, EmptyScene> = {
  'no-data': { lights: 'off', door: 'closed', prop: 'clock' },
  unreadable: { lights: 'on', door: 'closed', prop: 'cabinet' },
  'no-collector': { lights: 'on', door: 'closed', prop: 'plug' },
  'no-agents': { lights: 'on', door: 'open' },
}
