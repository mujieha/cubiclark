// `cubiclark replay --since <duration>`: the scheduling arithmetic, as pure functions. The server
// collects every event of the window, orders them by time, applies those before the window at once
// (so the agents that were already there are present) and then releases the rest as a clock that
// runs `speed` times faster than the real one reaches them. No clock is read here: every time is
// an argument.

import type { AgentEvent } from './types.js'

/** A replay never looks further back than this. */
export const MAX_REPLAY_MS = 14 * 24 * 60 * 60 * 1000
export const DEFAULT_REPLAY_SPEED = 10
export const MAX_REPLAY_SPEED = 1000

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const

/** '3h', '90m', '1h30m', '45s', '2d', '1.5h': a length of time in ms. Undefined for anything else,
 * for zero, and for more than MAX_REPLAY_MS. */
export function parseDuration(text: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?[dhms])+$/.test(text)) return undefined
  let total = 0
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)([dhms])/g)) {
    total += Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS]
  }
  const ms = Math.round(total)
  return ms > 0 && ms <= MAX_REPLAY_MS ? ms : undefined
}

export interface ReplayItem {
  source: 'transcript' | 'hook'
  event: AgentEvent
  ms: number
}

/** Events of one source as replay items, each stamped with its own time. */
export function toReplayItems(source: ReplayItem['source'], events: readonly AgentEvent[]): ReplayItem[] {
  return events.map((event) => ({ source, event, ms: Date.parse(event.ts) }))
}

/** By time, stable: items of one moment keep the order they came in. Items with no valid time
 * are dropped (the caller counts them). */
export function orderReplay(items: readonly ReplayItem[]): ReplayItem[] {
  return items.filter((item) => !Number.isNaN(item.ms)).sort((a, b) => a.ms - b.ms)
}

/** What happened before the window (applied at once) and during it (played back). An item exactly
 * at the start is part of the window. */
export function splitAt(ordered: readonly ReplayItem[], startMs: number): { before: ReplayItem[]; during: ReplayItem[] } {
  const index = ordered.findIndex((item) => item.ms >= startMs)
  return index < 0 ? { before: [...ordered], during: [] } : { before: ordered.slice(0, index), during: ordered.slice(index) }
}

/** The replay clock: it starts at `startMs` when playback starts (`realStartMs`) and runs `speed`
 * times as fast as the real one. */
export function replayClockMs(startMs: number, realStartMs: number, realNowMs: number, speed: number): number {
  return startMs + Math.max(0, realNowMs - realStartMs) * speed
}

/** Every item from `cursor` on whose time the clock has reached, in order, and the new cursor.
 * Nothing is delivered twice across calls. */
export function takeDue(during: readonly ReplayItem[], cursor: number, clockMs: number): { due: ReplayItem[]; cursor: number } {
  let next = cursor
  while (next < during.length && (during[next] as ReplayItem).ms <= clockMs) next += 1
  return { due: during.slice(cursor, next), cursor: next }
}
