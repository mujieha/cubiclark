import { describe, expect, test } from 'vitest'
import {
  agentRows,
  agentStateLabel,
  diagnosticsLine,
  emptyScreen,
  emptyScreenText,
  officeStatusLine,
  publicWorld,
  sourcesLine,
} from '../src/core/view.js'
import type { Agent, World } from '../src/core/types.js'
import { emptyWorld, ensureAgent, setState, updateAgent } from '../src/core/world.js'

function withAgent(world: World, id: string, patch: Partial<Agent>): World {
  let next = ensureAgent(world, id, patch.stateSince ?? world.clock)
  next = updateAgent(next, id, (agent) => ({ ...agent, ...patch }))
  return next
}

describe('emptyScreen', () => {
  test('no snapshot yet, or transcripts still starting -> no-data', () => {
    expect(emptyScreen(undefined)).toBe('no-data')
    const world = emptyWorld('t0', '/root')
    expect(emptyScreen(world)).toBe('no-data')
  })

  test('an unreadable transcripts root -> unreadable', () => {
    let world = emptyWorld('t0', '/root')
    world = {
      ...world,
      sources: { ...world.sources, transcripts: { ...world.sources.transcripts, status: 'unreadable', error: 'boom' } },
    }
    expect(emptyScreen(world)).toBe('unreadable')
  })

  test('live, no agents, zero files found, hooks not installed -> no-collector', () => {
    let world = emptyWorld('t0', '/root')
    world = {
      ...world,
      sources: {
        ...world.sources,
        transcripts: { status: 'live', root: '/root', files: 0, inWindow: 0, windowHours: 12 },
      },
    }
    expect(emptyScreen(world)).toBe('no-collector')
  })

  test('live, no agents, files present but none active -> no-agents', () => {
    let world = emptyWorld('t0', '/root')
    world = {
      ...world,
      sources: {
        ...world.sources,
        transcripts: { status: 'live', root: '/root', files: 3, inWindow: 0, windowHours: 12 },
      },
    }
    expect(emptyScreen(world)).toBe('no-agents')
  })

  test('at least one agent -> null (show the table, not an empty screen)', () => {
    let world = emptyWorld('t0', '/root')
    world = {
      ...world,
      sources: { ...world.sources, transcripts: { status: 'live', root: '/root', files: 1, inWindow: 1, windowHours: 12 } },
    }
    world = withAgent(world, 'a1', {})
    expect(emptyScreen(world)).toBeNull()
  })
})

describe('emptyScreenText', () => {
  test('names the root and the error for unreadable', () => {
    let world = emptyWorld('t0', '/my/root')
    world = {
      ...world,
      sources: { ...world.sources, transcripts: { ...world.sources.transcripts, status: 'unreadable', error: 'ENOENT' } },
    }
    expect(emptyScreenText('unreadable', world)).toContain('/my/root')
    expect(emptyScreenText('unreadable', world)).toContain('ENOENT')
  })

  test('no-agents mentions the window and any older transcripts left out', () => {
    let world = emptyWorld('t0', '/root')
    world = {
      ...world,
      sources: { ...world.sources, transcripts: { status: 'live', root: '/root', files: 5, inWindow: 0, windowHours: 12 } },
    }
    const text = emptyScreenText('no-agents', world)
    expect(text).toContain('12 hours')
    expect(text).toContain('5 older transcripts')
  })
})

describe('agentRows', () => {
  test('parents first, subagents immediately after and indented one level', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'b-parent', { kind: 'session', project: 'demo', stateSince: 't0' })
    world = withAgent(world, 'a-child', { kind: 'subagent', parentId: 'b-parent', project: 'demo', stateSince: 't0' })
    world = withAgent(world, 'a-parent', { kind: 'session', project: 'demo', stateSince: 't0' })

    const rows = agentRows(world, Date.parse('2026-01-15T10:00:00.000Z'))
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['a-parent', 0],
      ['b-parent', 0],
      ['a-child', 1],
    ])
  })

  test('a subagent row carries its parent\'s short id and label', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'parent-1', { kind: 'session', label: 'demo-worker', project: 'demo', stateSince: 't0' })
    world = withAgent(world, 'child-1', { kind: 'subagent', parentId: 'parent-1', project: 'demo', stateSince: 't0' })

    const rows = agentRows(world, Date.parse('2026-01-15T10:00:00.000Z'))
    const child = rows.find((r) => r.id === 'child-1')
    expect(child?.parentLabel).toBe('parent-1 demo-worker')
  })

  test('the state label always includes the inferred suffix when stateEvidence is inferred', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'a1', { state: 'waiting_permission', stateEvidence: 'inferred', project: 'demo', stateSince: 't0' })
    const rows = agentRows(world, Date.parse('2026-01-15T10:00:00.000Z'))
    expect(rows[0]?.stateLabel).toBe('waiting for permission? (inferred)')
  })

  test('an observed permission wait (from a hook) is not worded as a guess', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'a1', { state: 'waiting_permission', stateEvidence: 'observed', project: 'demo', stateSince: 't0' })
    const rows = agentRows(world, Date.parse('2026-01-15T10:00:00.000Z'))
    expect(rows[0]?.stateLabel).toBe('waiting for permission')
  })

  test('since is formatted relative to the given now', () => {
    let world = emptyWorld('t0', '/root')
    world = ensureAgent(world, 'a1', '2026-01-15T10:00:00.000Z')
    world = setState(world, 'a1', 'thinking', '2026-01-15T09:58:00.000Z')
    const rows = agentRows(world, Date.parse('2026-01-15T10:00:00.000Z'))
    expect(rows[0]?.since).toBe('2m ago')
  })

  test('current tool is "<name> <target>", or just the name with no target', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'a1', {
      project: 'demo',
      stateSince: 't0',
      currentTool: { name: 'Read', target: 'a.ts' },
    })
    world = withAgent(world, 'a2', { project: 'demo', stateSince: 't0', currentTool: { name: 'WebSearch' } })
    const rows = agentRows(world, Date.parse('2026-01-15T10:00:00.000Z'))
    expect(rows.find((r) => r.id === 'a1')?.currentTool).toBe('Read a.ts')
    expect(rows.find((r) => r.id === 'a2')?.currentTool).toBe('WebSearch')
  })
})

describe('diagnosticsLine', () => {
  test('an all-clean World reports only unparsed 0', () => {
    expect(diagnosticsLine(emptyWorld('t0', '/root'))).toBe('unparsed 0')
  })

  test('every non-empty part is included', () => {
    let world = emptyWorld('t0', '/root')
    world = {
      ...world,
      diagnostics: {
        unparsedLines: 3,
        unknownHookShapes: 0,
        sourceErrors: ['boom'],
        unknownTypes: { 'future-thing': 1, 'system:x': 2 },
        versions: ['2.1.284'],
        unparsedBy: {},
      },
    }
    expect(diagnosticsLine(world)).toBe('unparsed 3 · unknown types 2 · versions 2.1.284 · source errors 1')
  })

  test('the reasons follow the unparsed count, biggest first, three at most', () => {
    let world = emptyWorld('t0', '/root')
    world = {
      ...world,
      diagnostics: {
        ...world.diagnostics,
        unparsedLines: 10,
        unparsedBy: { no_timestamp: { mode: 5, user: 1 }, not_json: { '(none)': 1 }, unknown_type: { x: 2 }, handler_rejected: { assistant: 1 } },
      },
    }
    // a tie (not_json 1, handler_rejected 1) keeps the order of UNPARSED_REASONS; the 4th reason is cut
    expect(diagnosticsLine(world)).toBe('unparsed 10 (no_timestamp 6, unknown_type 2, not_json 1)')
  })

  test('unknown hook shapes are named when there are any', () => {
    let world = emptyWorld('t0', '/root')
    world = { ...world, diagnostics: { ...world.diagnostics, unknownHookShapes: 2 } }
    expect(diagnosticsLine(world)).toBe('unparsed 0 · unknown hook shapes 2')
  })
})

describe('sourcesLine', () => {
  const clock = '2026-01-15T10:00:30.000Z'

  function withSources(transcripts: Partial<World['sources']['transcripts']>, hooks: World['sources']['hooks']): World {
    const world = emptyWorld(clock, '/root')
    return { ...world, sources: { transcripts: { ...world.sources.transcripts, ...transcripts }, hooks } }
  }

  test('hooks not installed', () => {
    const world = withSources({ status: 'live' }, { status: 'not_installed', events: 0 })
    expect(sourcesLine(world)).toBe('transcripts: live · hooks: not installed')
  })

  test('hooks live with the event count and how long ago the last one was', () => {
    const world = withSources({ status: 'live' }, { status: 'live', events: 14, lastEventTs: '2026-01-15T10:00:27.000Z' })
    expect(sourcesLine(world)).toBe('transcripts: live · hooks: live (14 events, last 3s ago)')
  })

  test('hooks live with nothing read yet', () => {
    expect(sourcesLine(withSources({ status: 'live' }, { status: 'live', events: 0 }))).toBe(
      'transcripts: live · hooks: live (0 events)'
    )
  })

  test('hooks paused and hooks failing with the reason', () => {
    expect(sourcesLine(withSources({ status: 'live' }, { status: 'live', events: 3, paused: true }))).toContain('hooks: paused')
    expect(sourcesLine(withSources({ status: 'live' }, { status: 'failing', events: 0, reason: 'the collector copy is missing' }))).toBe(
      'transcripts: live · hooks: failing — the collector copy is missing'
    )
  })

  test('an unreadable transcripts folder is named as such', () => {
    expect(sourcesLine(withSources({ status: 'unreadable' }, { status: 'not_installed', events: 0 }))).toContain('transcripts: unreadable')
  })

  describe('with adapters', () => {
    const withAdapters = (adapters: NonNullable<World['sources']['adapters']>): World => {
      const world = withSources({ status: 'live' }, { status: 'not_installed', events: 0 })
      return { ...world, sources: { ...world.sources, adapters } }
    }

    test('a live adapter says how it is doing; one that is off is left out', () => {
      const line = sourcesLine(
        withAdapters([
          { id: 'task-folders', status: 'live', detail: '5 tasks in 1 root' },
          { id: 'quota-samples', status: 'off', detail: 'not configured' },
          { id: 'claude-agents', status: 'off', detail: 'not configured' },
        ])
      )
      expect(line).toBe('transcripts: live · hooks: not installed · task-folders: 5 tasks in 1 root')
    })

    test('a missing or failing adapter says so, with its reason', () => {
      const line = sourcesLine(
        withAdapters([
          { id: 'task-folders', status: 'missing', detail: 'no readable tasks root' },
          { id: 'quota-samples', status: 'failing', detail: 'boom' },
        ])
      )
      expect(line).toContain(' · task-folders: missing — no readable tasks root')
      expect(line).toContain(' · quota-samples: failing — boom')
    })

    test('a problem with the configuration file is shown even when every adapter is off', () => {
      const line = sourcesLine(withAdapters([{ id: 'task-folders', status: 'off', detail: 'not configured · config: unknown key "x" ignored' }]))
      expect(line).toContain('task-folders: off — not configured · config: unknown key "x" ignored')
    })

    test('no adapters key, no change', () => {
      expect(sourcesLine(withSources({ status: 'live' }, { status: 'not_installed', events: 0 }))).toBe('transcripts: live · hooks: not installed')
    })
  })
})

describe('publicWorld', () => {
  test('reduces cwd to its basename and drops tool_use/spawn ids', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'a1', {
      cwd: '/home/user/projects/demo',
      spawnToolUseId: 'toolu_fx000001',
      openTools: [{ id: 'toolu_fx000002', name: 'Read', target: 'a.ts', since: 't0' }],
    })
    const pub = publicWorld(world)
    expect(pub.agents.a1?.cwd).toBe('demo')
    expect(pub.agents.a1?.spawnToolUseId).toBeUndefined()
    expect(pub.agents.a1?.openTools[0]?.id).toBe('')
  })

  test('drops the closed tool ids too', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'a1', { closedToolIds: ['toolu_fx000003'] })
    expect(publicWorld(world).agents.a1?.closedToolIds).toBeUndefined()
  })
})

describe('the no-collector screen text', () => {
  test('points at the command that installs the collector', () => {
    const text = emptyScreenText('no-collector', emptyWorld('t0', '/my/root'))
    expect(text).toContain('/my/root')
    expect(text).toContain('cubiclark hooks on')
  })
})

describe('rows carry the raw state', () => {
  test('so the list and the office can be compared on the same value', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'a1', { state: 'compacting', project: 'demo', stateSince: 't0' })
    expect(agentRows(world, 0)[0]?.state).toBe('compacting')
  })

  test('agentStateLabel is the row label, inferred suffix included', () => {
    let world = emptyWorld('t0', '/root')
    world = withAgent(world, 'a1', { state: 'waiting_permission', stateEvidence: 'inferred', project: 'demo', stateSince: 't0' })
    const agent = world.agents.a1
    expect(agent && agentStateLabel(agent)).toBe(agentRows(world, 0)[0]?.stateLabel)
  })
})

describe('officeStatusLine', () => {
  function crowd(size: number, patch: (index: number) => Partial<Agent> = () => ({})): World {
    let world = emptyWorld('2026-01-15T10:00:00.000Z', '/root')
    for (let i = 0; i < size; i++) world = withAgent(world, `a${i}`, { project: 'demo', stateSince: 't0', ...patch(i) })
    return world
  }

  test('an empty world is zero agents, zero busy', () => {
    expect(officeStatusLine(emptyWorld('t0', '/root'))).toBe('0 agents · 0 busy')
  })

  test('one agent is singular', () => {
    expect(officeStatusLine(crowd(1, () => ({ state: 'thinking' })))).toBe('1 agent · 1 busy')
  })

  test('waiting for permission and rate limited are counted only when there are some', () => {
    const states: Agent['state'][] = ['thinking', 'running', 'waiting_permission', 'waiting_permission', 'rate_limited', 'waiting_user']
    const world = crowd(states.length, (i) => ({ state: states[i] }))
    expect(officeStatusLine(world)).toBe('6 agents · 2 busy · 2 waiting for permission · 1 rate limited')
  })

  test('finished, failed and idle agents are not busy', () => {
    const states: Agent['state'][] = ['finished', 'ended', 'failed', 'stuck', 'waiting_user']
    expect(officeStatusLine(crowd(states.length, (i) => ({ state: states[i] })))).toBe('5 agents · 0 busy')
  })

  test('above 50 agents it suggests the list view; at 50 it does not', () => {
    expect(officeStatusLine(crowd(50, () => ({ state: 'thinking' })))).not.toContain('list view')
    expect(officeStatusLine(crowd(51, () => ({ state: 'thinking' })))).toContain('busy office: the list view may be easier')
  })
})
