// The World expected for each fixture scenario, plus step-through tests that stop after a
// chosen event and assert every AgentState the reducer can reach on its own (design §6's
// `compacting` and `ended` need hooks, phase 2; `waiting_permission` needs tick(), tested in
// tick.test.ts) — and a few small, hand-built event sequences the fixtures cannot exercise:
// order independence and nested subagent re-parenting.

import { describe, expect, test } from 'vitest'
import {
  DEMO_CWD,
  SHOP_CWD,
  apiErrorLines,
  backgroundWorkerLines,
  exploreScenario,
  mainSessionLines,
  permissionDeniedLines,
  rateLimitLines,
  sessionId,
  subagentId,
  toolUseId,
  ts,
} from '../scripts/fixture-lib.js'
import { reduce } from '../src/core/reducer.js'
import { parseTranscript } from '../src/core/transcript/parse.js'
import type { AgentEvent, AgentState, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

const START = Date.parse('2026-01-15T10:00:00.000Z')
const HOUR = 60 * 60 * 1000

function toText(lines: { raw?: string; [k: string]: unknown }[]): string {
  return lines.map((line) => (line.raw !== undefined ? line.raw : JSON.stringify(line))).join('\n') + '\n'
}

function reduceAll(world: World, events: AgentEvent[]): World {
  return Object.freeze(events).reduce((w, e) => reduce(w, Object.freeze({ ...e }) as AgentEvent), world)
}

function stateAfter(events: AgentEvent[], count: number, agentId: string): AgentState | undefined {
  return reduceAll(emptyWorld('t0', '/root'), events.slice(0, count)).agents[agentId]?.state
}

describe('reduce over each fixture scenario', () => {
  test('main-session: five tools used, ends waiting_user', () => {
    const sid = sessionId('1')
    const parsed = parseTranscript(toText(mainSessionLines(START, sid, DEMO_CWD)), { agentId: sid, kind: 'session' })
    const world = reduceAll(emptyWorld('t0', '/root'), parsed.events)
    expect(world.agents[sid]).toMatchObject({
      kind: 'session',
      parentId: undefined,
      project: 'demo',
      model: 'claude-sonnet-5',
      state: 'waiting_user',
      currentTool: undefined,
      counters: { prompts: 1, tools: 5, compactions: 0, subagents: 0, tokensOut: 74 },
      label: undefined,
      error: undefined,
      permissionMode: 'default',
    })
  })

  test('background-worker: labelled, background, still running Bash', () => {
    const sid = sessionId('2')
    const parsed = parseTranscript(toText(backgroundWorkerLines(START + HOUR, sid, DEMO_CWD)), {
      agentId: sid,
      kind: 'session',
    })
    const world = reduceAll(emptyWorld('t0', '/root'), parsed.events)
    expect(world.agents[sid]).toMatchObject({
      kind: 'background',
      project: 'demo',
      label: 'demo-worker',
      state: 'running',
      currentTool: { name: 'Bash', target: 'npm' },
      counters: { prompts: 1, tools: 1, compactions: 0, subagents: 0, tokensOut: 10 },
    })
  })

  test('explore (full): parent waits after delegating, subagent finishes with a role', () => {
    const start = START + 2 * HOUR
    const parentSid = sessionId('3')
    const aid = subagentId('e1')
    const explore = exploreScenario(start, parentSid, DEMO_CWD, aid, { full: true })
    const parentParsed = parseTranscript(toText(explore.parentLines), { agentId: parentSid, kind: 'session' })
    const subParsed = parseTranscript(toText(explore.subagentLines), {
      agentId: aid,
      kind: 'subagent',
      parentId: parentSid,
    })
    const linkEvent: AgentEvent = {
      t: 'subagent_link',
      ts: subParsed.events[0]?.ts ?? ts(start, 20),
      agentId: aid,
      parentId: parentSid,
      spawnToolUseId: explore.meta.toolUseId as string,
      agentType: explore.meta.agentType as string,
    }
    const world = reduceAll(emptyWorld('t0', '/root'), [...parentParsed.events, linkEvent, ...subParsed.events])

    expect(world.agents[parentSid]).toMatchObject({
      kind: 'session',
      project: 'demo',
      state: 'waiting_user',
      counters: { subagents: 1 },
    })
    expect(world.agents[aid]).toMatchObject({
      kind: 'subagent',
      parentId: parentSid,
      project: 'demo',
      state: 'finished',
      label: 'Explore',
      role: 'explorer',
    })
  })

  test('rate-limit: ends rate_limited with the error recorded', () => {
    const sid = sessionId('5')
    const parsed = parseTranscript(toText(rateLimitLines(START + 4 * HOUR, sid, SHOP_CWD)), {
      agentId: sid,
      kind: 'session',
    })
    const world = reduceAll(emptyWorld('t0', '/root'), parsed.events)
    expect(world.agents[sid]).toMatchObject({
      project: 'shop',
      state: 'rate_limited',
      error: { kind: 'rate_limit', message: 'API Error: rate limit exceeded, please retry later' },
    })
  })

  test('api-error: ends failed with the error recorded', () => {
    const sid = sessionId('6')
    const parsed = parseTranscript(toText(apiErrorLines(START + 5 * HOUR, sid, DEMO_CWD)), {
      agentId: sid,
      kind: 'session',
    })
    const world = reduceAll(emptyWorld('t0', '/root'), parsed.events)
    expect(world.agents[sid]).toMatchObject({
      state: 'failed',
      error: { kind: 'other', message: 'API Error: invalid request: missing required field' },
    })
  })

  test('permission-denied: a "permission denied" log line, ends waiting_user', () => {
    const sid = sessionId('8')
    const parsed = parseTranscript(toText(permissionDeniedLines(START + 7 * HOUR, sid, DEMO_CWD)), {
      agentId: sid,
      kind: 'session',
    })
    const world = reduceAll(emptyWorld('t0', '/root'), parsed.events)
    expect(world.agents[sid]?.state).toBe('waiting_user')
    expect(world.log.some((l) => l.text === 'permission denied')).toBe(true)
  })
})

describe('every AgentState the reducer can reach on its own', () => {
  const mainSid = sessionId('1')
  const mainEvents = parseTranscript(toText(mainSessionLines(START, mainSid, DEMO_CWD)), {
    agentId: mainSid,
    kind: 'session',
  }).events

  test('starting: right after the first agent_meta, before any prompt', () => {
    expect(stateAfter(mainEvents, 1, mainSid)).toBe('starting')
  })
  test('thinking: after the first prompt', () => {
    expect(stateAfter(mainEvents, 4, mainSid)).toBe('thinking')
  })
  test('reading: while Read is open', () => {
    expect(stateAfter(mainEvents, 5, mainSid)).toBe('reading')
  })
  test('editing: while Edit is open', () => {
    expect(stateAfter(mainEvents, 8, mainSid)).toBe('editing')
  })
  test('running: while Bash is open', () => {
    expect(stateAfter(mainEvents, 11, mainSid)).toBe('running')
  })
  test('searching: while Grep is open', () => {
    expect(stateAfter(mainEvents, 14, mainSid)).toBe('searching')
  })
  test('browsing: while WebFetch is open', () => {
    expect(stateAfter(mainEvents, 17, mainSid)).toBe('browsing')
  })
  test('waiting_user: after the final turn ends', () => {
    expect(stateAfter(mainEvents, mainEvents.length, mainSid)).toBe('waiting_user')
  })

  test('delegating: right after the Agent tool_use opens', () => {
    const start = START + 2 * HOUR
    const parentSid = sessionId('3')
    const explore = exploreScenario(start, parentSid, DEMO_CWD, subagentId('e1'), { full: true })
    const events = parseTranscript(toText(explore.parentLines), { agentId: parentSid, kind: 'session' }).events
    expect(stateAfter(events, 3, parentSid)).toBe('delegating')
  })

  test('finished: a subagent after its own turn ends', () => {
    const start = START + 2 * HOUR
    const parentSid = sessionId('3')
    const aid = subagentId('e1')
    const explore = exploreScenario(start, parentSid, DEMO_CWD, aid, { full: true })
    const events = parseTranscript(toText(explore.subagentLines), { agentId: aid, kind: 'subagent', parentId: parentSid })
      .events
    expect(stateAfter(events, events.length, aid)).toBe('finished')
  })

  test('rate_limited: right after the first (retrying) api_error', () => {
    const sid = sessionId('5')
    const events = parseTranscript(toText(rateLimitLines(START + 4 * HOUR, sid, SHOP_CWD)), {
      agentId: sid,
      kind: 'session',
    }).events
    expect(stateAfter(events, 5, sid)).toBe('rate_limited')
  })

  test('failed: after the terminal, non-retrying, non-rate-limit api_error', () => {
    const sid = sessionId('6')
    const events = parseTranscript(toText(apiErrorLines(START + 5 * HOUR, sid, DEMO_CWD)), {
      agentId: sid,
      kind: 'session',
    }).events
    expect(stateAfter(events, events.length, sid)).toBe('failed')
  })
})

describe('compacting and ended never appear from transcripts alone', () => {
  test('no agent in any fixture-derived World is ever left in compacting or ended', () => {
    const scenarios: AgentEvent[][] = [
      parseTranscript(toText(mainSessionLines(START, sessionId('1'), DEMO_CWD)), { agentId: sessionId('1'), kind: 'session' })
        .events,
      parseTranscript(toText(backgroundWorkerLines(START + HOUR, sessionId('2'), DEMO_CWD)), {
        agentId: sessionId('2'),
        kind: 'session',
      }).events,
      parseTranscript(toText(rateLimitLines(START + 4 * HOUR, sessionId('5'), SHOP_CWD)), {
        agentId: sessionId('5'),
        kind: 'session',
      }).events,
    ]
    for (const events of scenarios) {
      const world = reduceAll(emptyWorld('t0', '/root'), events)
      for (const agent of Object.values(world.agents)) {
        expect(agent.state).not.toBe('compacting')
        expect(agent.state).not.toBe('ended')
      }
    }
  })
})

describe('order independence and nested re-parenting (hand-built events, not from any fixture)', () => {
  test('a subagent_link before or after the matching tool_start gives the same World', () => {
    const parentId = 'parent-1'
    const childId = 'child-1'
    const spawnId = toolUseId(900)
    const meta: AgentEvent = { t: 'agent_meta', ts: 't0', agentId: parentId, kind: 'session' }
    const start: AgentEvent = {
      t: 'tool_start',
      ts: 't1',
      agentId: parentId,
      toolUseId: spawnId,
      name: 'Agent',
      target: 'Explore',
      subagentType: 'Explore',
    }
    const link: AgentEvent = { t: 'subagent_link', ts: 't1', agentId: childId, parentId, spawnToolUseId: spawnId, agentType: 'Explore' }

    const linkFirst = reduceAll(emptyWorld('t0', '/root'), [meta, link, start])
    const startFirst = reduceAll(emptyWorld('t0', '/root'), [meta, start, link])

    expect(linkFirst.agents[childId]).toEqual(startFirst.agents[childId])
    expect(linkFirst.agents[parentId]).toEqual(startFirst.agents[parentId])
  })

  test('a subagent started by another subagent re-parents to it, not to the top session', () => {
    const sessionAgentId = 'session-1'
    const midId = 'mid-1'
    const leafId = 'leaf-1'
    const midSpawnId = toolUseId(901)
    const leafSpawnId = toolUseId(902)

    const events: AgentEvent[] = [
      { t: 'agent_meta', ts: 't0', agentId: sessionAgentId, kind: 'session' },
      {
        t: 'tool_start',
        ts: 't1',
        agentId: sessionAgentId,
        toolUseId: midSpawnId,
        name: 'Agent',
        target: 'Explore',
        subagentType: 'Explore',
      },
      { t: 'subagent_link', ts: 't1', agentId: midId, parentId: sessionAgentId, spawnToolUseId: midSpawnId, agentType: 'Explore' },
      {
        t: 'tool_start',
        ts: 't2',
        agentId: midId,
        toolUseId: leafSpawnId,
        name: 'Agent',
        target: 'Explore',
        subagentType: 'Explore',
      },
      // The path-derived parentId always names the top-level session; the reducer re-parents
      // to `mid` because leafSpawnId is one of `mid`'s open tools.
      { t: 'subagent_link', ts: 't2', agentId: leafId, parentId: sessionAgentId, spawnToolUseId: leafSpawnId, agentType: 'Explore' },
    ]

    const world = reduceAll(emptyWorld('t0', '/root'), events)
    expect(world.agents[leafId]?.parentId).toBe(midId)
    expect(world.agents[midId]?.parentId).toBe(sessionAgentId)
  })
})
