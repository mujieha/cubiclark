import { describe, expect, test } from 'vitest'
import { MAX_REPLAY_MS, orderReplay, parseDuration, replayClockMs, splitAt, takeDue, toReplayItems, type ReplayItem } from '../src/core/replay.js'
import type { AgentEvent } from '../src/core/types.js'

const H = 3_600_000

describe('parseDuration', () => {
  test.each([
    ['3h', 3 * H],
    ['90m', 90 * 60_000],
    ['1h30m', 90 * 60_000],
    ['45s', 45_000],
    ['2d', 48 * H],
    ['1.5h', 90 * 60_000],
    ['1d2h3m4s', 86_400_000 + 2 * H + 3 * 60_000 + 4000],
    ['0.5s', 500],
  ])('%s is %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms)
  })

  test.each(['', '0h', '0s', '0.0m', 'abc', '-3h', '3', 'h', '3 h', '3H', '1h 30m', '3hours', '1.h', '.5h', '3h5', '15d', '1000d'])('%j is not a duration', (text) => {
    expect(parseDuration(text)).toBeUndefined()
  })

  test('the longest is 14 days', () => {
    expect(parseDuration('14d')).toBe(MAX_REPLAY_MS)
    expect(parseDuration('336h')).toBe(MAX_REPLAY_MS)
    expect(parseDuration('337h')).toBeUndefined()
  })
})

const event = (ts: string): AgentEvent => ({ t: 'prompt', ts, agentId: 'a' })
const item = (source: ReplayItem['source'], ms: number, label = ''): ReplayItem => ({
  source,
  ms,
  event: { t: 'prompt', ts: Number.isNaN(ms) ? 'no time' : new Date(ms).toISOString(), agentId: label },
})

describe('orderReplay', () => {
  test('by time, stable for equal times, so a transcript event before a hook event of one moment stays first', () => {
    const items = [item('hook', 5, 'h5'), item('transcript', 5, 't5'), item('transcript', 1, 't1'), item('hook', 5, 'h5b')]
    expect(orderReplay(items).map((i) => (i.event as { agentId: string }).agentId)).toEqual(['t1', 'h5', 't5', 'h5b'])
  })
  test('an item with no valid time is dropped', () => {
    expect(orderReplay([item('hook', Number.NaN), item('hook', 3)]).map((i) => i.ms)).toEqual([3])
  })
  test('toReplayItems stamps each event with its own time, and a bad one with NaN', () => {
    const items = toReplayItems('transcript', [event('2026-01-16T10:00:00.000Z'), event('nope')])
    expect(items[0]).toMatchObject({ source: 'transcript', ms: Date.parse('2026-01-16T10:00:00.000Z') })
    expect(items[1]?.ms).toBeNaN()
  })
})

describe('splitAt', () => {
  const ordered = [item('hook', 1), item('hook', 5), item('hook', 5), item('hook', 9)]
  test('an item exactly at the start belongs to the window', () => {
    const { before, during } = splitAt(ordered, 5)
    expect(before.map((i) => i.ms)).toEqual([1])
    expect(during.map((i) => i.ms)).toEqual([5, 5, 9])
  })
  test('everything before, everything during, and nothing', () => {
    expect(splitAt(ordered, 100)).toEqual({ before: ordered, during: [] })
    expect(splitAt(ordered, 0)).toEqual({ before: [], during: ordered })
    expect(splitAt([], 5)).toEqual({ before: [], during: [] })
  })
})

describe('the replay clock', () => {
  test('at 10x, one real second is ten seconds of replay', () => {
    expect(replayClockMs(1_000_000, 50_000, 51_000, 10)).toBe(1_010_000)
  })
  test('it starts at the start of the window, and never runs backwards', () => {
    expect(replayClockMs(1_000_000, 50_000, 50_000, 10)).toBe(1_000_000)
    expect(replayClockMs(1_000_000, 50_000, 40_000, 10)).toBe(1_000_000)
  })
  test('three hours at 10x take 18 minutes', () => {
    expect(replayClockMs(0, 0, 18 * 60_000, 10)).toBe(3 * H)
  })
})

describe('takeDue', () => {
  const during = [item('hook', 10), item('hook', 20), item('hook', 20), item('hook', 40)]
  test('delivers everything the clock has reached, in order, and moves the cursor', () => {
    const first = takeDue(during, 0, 20)
    expect(first.due.map((i) => i.ms)).toEqual([10, 20, 20])
    expect(first.cursor).toBe(3)
  })
  test('nothing twice across calls; nothing before its time', () => {
    const first = takeDue(during, 0, 20)
    expect(takeDue(during, first.cursor, 30)).toEqual({ due: [], cursor: 3 })
    const last = takeDue(during, first.cursor, 40)
    expect(last.due.map((i) => i.ms)).toEqual([40])
    expect(takeDue(during, last.cursor, 1000)).toEqual({ due: [], cursor: 4 })
  })
  test('an empty schedule delivers nothing', () => {
    expect(takeDue([], 0, 1000)).toEqual({ due: [], cursor: 0 })
    expect(takeDue(during, 0, 5)).toEqual({ due: [], cursor: 0 })
  })
})
