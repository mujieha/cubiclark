import { describe, expect, test } from 'vitest'
import { textMetrics } from '../src/core/office/text.js'
import { whiteboardLabel, whiteboardModel, WHITEBOARD_MAX_DOTS, WHITEBOARD_MIN_LABEL_CHARS } from '../src/core/office/whiteboard.js'
import type { Task, TaskTimelineEntry } from '../src/core/types.js'

const entry = (time: string, kind: TaskTimelineEntry['kind'], model?: string): TaskTimelineEntry => ({
  ts: `2026-01-16T${time}:00.000Z`,
  kind,
  text: kind,
  ...(model ? { model } : {}),
})

describe('whiteboardModel', () => {
  test('no task, no board', () => {
    expect(whiteboardModel(undefined)).toBeUndefined()
  })

  test('the model carries the whole task id and its phase; what fits is decided where the width is known', () => {
    expect(whiteboardModel({ id: 'demo-login', phase: 'building', timeline: [] })).toMatchObject({ label: 'demo-login', phase: 'building' })
    expect(whiteboardModel({ id: 'ab', timeline: [] })?.label).toBe('ab')
    expect(whiteboardModel({ id: 'ab', timeline: [] })).not.toHaveProperty('phase')
  })

  test.each([
    ['planning', ['current', 'future', 'future', 'future']],
    ['building', ['past', 'current', 'future', 'future']],
    ['review', ['past', 'past', 'current', 'future']],
    ['done', ['past', 'past', 'past', 'current']],
  ] as const)('a task in %s', (phase, stages) => {
    expect(whiteboardModel({ id: 't', phase, timeline: [] })?.stages).toEqual(stages)
  })

  test('a task with no phase has all four stages ahead of it', () => {
    expect(whiteboardModel({ id: 't', timeline: [] })?.stages).toEqual(['future', 'future', 'future', 'future'])
  })

  test('a blocked task marks the stage it stopped in', () => {
    const task: Task = {
      id: 't',
      phase: 'blocked',
      timeline: [entry('09:00', 'dispatched', 'sonnet'), entry('10:00', 'blocked')],
    }
    expect(whiteboardModel(task)?.stages).toEqual(['past', 'blocked', 'future', 'future'])
  })

  test('model changes are counted, and capped at four dots', () => {
    const task: Task = {
      id: 't',
      phase: 'building',
      timeline: [entry('09:00', 'dispatched', 'claude-opus-5-5'), entry('10:00', 'forked', 'claude-sonnet-5-5'), entry('11:00', 'resumed', 'claude-sonnet-5-5')],
    }
    expect(whiteboardModel(task)?.modelChanges).toBe(1)
    const flipping: Task = {
      id: 't',
      timeline: Array.from({ length: 9 }, (_, i) => entry(`0${i + 1}:00`, 'resumed', i % 2 === 0 ? 'claude-opus-5-5' : 'claude-sonnet-5-5')),
    }
    expect(whiteboardModel(flipping)?.modelChanges).toBe(WHITEBOARD_MAX_DOTS)
    expect(whiteboardModel({ id: 't', timeline: [] })?.modelChanges).toBe(0)
  })
})

describe('whiteboardLabel', () => {
  const LONG = 'mujieha-site-appcast-source'
  /** A monospace font: every character is `cell` wide. */
  const cell = textMetrics(1.75).smallPx * 0.6
  const measure = (text: string): number => [...text].length * cell
  const label = (id: string, phase: Task['phase'], cells: number): string => {
    const model = whiteboardModel({ id, ...(phase === undefined ? {} : { phase }), timeline: [] })
    if (!model) throw new Error('no model')
    return whiteboardLabel(model, cells * cell, measure)
  }

  test('at scale 1.75 a long task id is never a five-character stump: the room holds five cells', () => {
    const room = 21 * 1.75
    expect(Math.floor(room / cell)).toBe(5)
    const board = (phase: Task['phase']): string => {
      const model = whiteboardModel({ id: LONG, ...(phase === undefined ? {} : { phase }), timeline: [] })
      return whiteboardLabel(model as NonNullable<typeof model>, room, measure)
    }
    expect(board('building')).toBe('')
    expect(board(undefined)).toBe('')
    expect(board('done')).toBe('done')
    for (const phase of ['planning', 'building', 'review', 'done', 'blocked'] as const) expect(board(phase)).not.toMatch(/^muji/)
  })

  test('a short id is shown whole', () => {
    expect(label('ab', 'building', 5)).toBe('ab')
    expect(label('demo', undefined, 5)).toBe('demo')
  })

  test('a long id is shown cut only when at least eight of its characters fit', () => {
    expect(WHITEBOARD_MIN_LABEL_CHARS).toBe(8)
    expect(label(LONG, 'building', 27)).toBe(LONG)
    expect(label(LONG, 'building', 10)).toBe('mujieha-s…')
    expect(label(LONG, 'building', 9)).toBe('mujieha-…')
  })

  test('with seven or fewer characters of the id to show, the phase word stands in', () => {
    expect(label(LONG, 'building', 8)).toBe('building')
    expect(label(LONG, 'review', 6)).toBe('review')
    expect(label(LONG, 'review', 5)).toBe('')
  })

  test('at every width the answer is the id, an id cut at eight characters or more, the phase, or nothing', () => {
    const model = whiteboardModel({ id: LONG, phase: 'planning', timeline: [] })
    if (!model) throw new Error('no model')
    for (let width = 0; width <= 300; width += 0.5) {
      const text = whiteboardLabel(model, width, measure)
      expect(measure(text), `${width}`).toBeLessThanOrEqual(width)
      if (text === '' || text === LONG || text === 'planning') continue
      expect(text.endsWith('…'), `${width}: ${text}`).toBe(true)
      expect(LONG.startsWith(text.slice(0, -1))).toBe(true)
      expect([...text].length - 1, `${width}: ${text}`).toBeGreaterThanOrEqual(WHITEBOARD_MIN_LABEL_CHARS)
    }
  })

  test('no room, no word', () => {
    expect(label(LONG, 'done', 0)).toBe('')
  })
})
