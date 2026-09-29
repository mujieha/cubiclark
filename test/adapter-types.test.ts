import { describe, expect, test } from 'vitest'
import { emptySnapshot, mergeSnapshots, type AdapterSnapshot } from '../src/core/adapters/types.js'
import { emptyWorld } from '../src/core/world.js'

const T0 = '2026-01-15T10:00:00.000Z'

describe('emptyWorld (phase 4 fields)', () => {
  test('has no replay, no adapters, no quota', () => {
    const world = emptyWorld(T0, '/root')
    expect(world.replay).toBeUndefined()
    expect(world.sources.adapters).toBeUndefined()
    expect(world.quota).toBeUndefined()
    expect(world.tasks).toEqual({})
  })
})

describe('mergeSnapshots', () => {
  test('an empty list gives an empty snapshot', () => {
    expect(mergeSnapshots([])).toEqual({ diagnostics: { unparsed: 0, errors: [] } })
    expect(emptySnapshot()).toEqual({ diagnostics: { unparsed: 0, errors: [] } })
  })

  test('concatenates tasks, links and sessions; unions cwds; sums diagnostics', () => {
    const a: AdapterSnapshot = {
      tasks: [{ id: 't1', timeline: [] }],
      links: [{ agentId: 'a1', taskId: 't1' }],
      orchestratorCwds: ['/x'],
      diagnostics: { unparsed: 1, errors: ['e1'] },
    }
    const b: AdapterSnapshot = {
      tasks: [{ id: 't2', timeline: [] }],
      links: [{ agentId: 'a2', taskId: 't2', role: 'builder' }],
      orchestratorCwds: ['/x', '/y'],
      cliSessions: [{ sessionId: 's1', state: 'working' }],
      cliFetchedAt: T0,
      diagnostics: { unparsed: 2, errors: ['e2'] },
    }
    const merged = mergeSnapshots([a, b])
    expect(merged.tasks?.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(merged.links).toHaveLength(2)
    expect(merged.orchestratorCwds).toEqual(['/x', '/y'])
    expect(merged.cliSessions).toEqual([{ sessionId: 's1', state: 'working' }])
    expect(merged.cliFetchedAt).toBe(T0)
    expect(merged.diagnostics).toEqual({ unparsed: 3, errors: ['e1', 'e2'] })
  })

  test('quota samples from several parts are re-sorted by time', () => {
    const merged = mergeSnapshots([
      { quotaSamples: [{ ts: '2026-01-15T12:00:00.000Z', p5h: 10 }], diagnostics: { unparsed: 0, errors: [] } },
      { quotaSamples: [{ ts: '2026-01-15T09:00:00.000Z', p5h: 5 }], diagnostics: { unparsed: 0, errors: [] } },
    ])
    expect(merged.quotaSamples?.map((s) => s.p5h)).toEqual([5, 10])
  })

  test('the first cliFetchedAt wins', () => {
    const merged = mergeSnapshots([
      { cliFetchedAt: '2026-01-15T10:00:00.000Z', diagnostics: { unparsed: 0, errors: [] } },
      { cliFetchedAt: '2026-01-15T11:00:00.000Z', diagnostics: { unparsed: 0, errors: [] } },
    ])
    expect(merged.cliFetchedAt).toBe('2026-01-15T10:00:00.000Z')
  })

  test('a live adapter with no tasks says so with an empty list, which is kept', () => {
    const merged = mergeSnapshots([{ tasks: [], diagnostics: { unparsed: 0, errors: [] } }])
    expect(merged.tasks).toEqual([])
    expect(mergeSnapshots([{ diagnostics: { unparsed: 0, errors: [] } }]).tasks).toBeUndefined()
  })
})
