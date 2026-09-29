import { describe, expect, test } from 'vitest'
import { whiteboardModel, WHITEBOARD_MAX_DOTS } from '../src/core/office/whiteboard.js'
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

  test('the label is the task id cut to five characters', () => {
    expect(whiteboardModel({ id: 'demo-login', timeline: [] })?.label).toBe('demo-')
    expect(whiteboardModel({ id: 'ab', timeline: [] })?.label).toBe('ab')
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
