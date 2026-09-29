import { describe, expect, test } from 'vitest'
import { agentRows, diagnosticsLine, emptyScreen, emptyScreenText, publicWorld } from '../src/core/view.js'
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
      },
    }
    expect(diagnosticsLine(world)).toBe('unparsed 3 · unknown types 2 · versions 2.1.284 · source errors 1')
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
})
