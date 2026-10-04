import { describe, expect, test } from 'vitest'
import { allStatesWorld, stateWorld, worldSessionId as s, worldSubagentId as sub } from '../scripts/world-fixture-lib.js'
import { layout } from '../src/core/office/layout.js'
import { ariaLabel, tooltipLines } from '../src/core/office/labels.js'
import {
  BUBBLE_TEXT_MAX,
  EMPTY_SCENES,
  POSE_FRAMES,
  STATE_VISUALS,
  directionBetween,
  formatAgo,
  frameAt,
  lampFor,
  resolveBubble,
  type Pose,
  type StateVisual,
} from '../src/core/office/visual.js'
import { AGENT_STATES, type Agent, type AgentState, type World } from '../src/core/types.js'

function agentOf(world: World, id: string): Agent {
  const agent = world.agents[id]
  if (!agent) throw new Error(`no agent ${id}`)
  return agent
}

function bubbleOf(world: World, id: string, reducedMotion = false) {
  return resolveBubble(agentOf(world, id), world, layout(world), reducedMotion)
}

const signature = (v: StateVisual): string =>
  [v.pose, v.bubble?.icon, v.bubble?.style, v.lamp, v.screen, v.dim, v.tag].join('|')
const shapeOnly = (v: StateVisual): string => [v.pose, v.bubble?.icon, v.tag].join('|')

describe('the state table (design §6)', () => {
  test('there is a visual for every state', () => {
    for (const state of AGENT_STATES) expect(STATE_VISUALS[state], state).toBeDefined()
    expect(Object.keys(STATE_VISUALS).sort()).toEqual([...AGENT_STATES].sort())
  })

  test('every alert bubble and every pulsing bubble carries no text, so the 4.5 rule on bubble text (plain and muted) is the whole story', () => {
    for (const state of AGENT_STATES) {
      const bubble = STATE_VISUALS[state].bubble
      if (bubble?.style === 'alert' || bubble?.pulse) expect(bubble.text, state).toBe('none')
    }
  })

  test('the 16 visuals are pairwise distinct', () => {
    const signatures = AGENT_STATES.map((state) => signature(STATE_VISUALS[state]))
    expect(new Set(signatures).size).toBe(AGENT_STATES.length)
  })

  test('and still pairwise distinct with colour and lamp taken away: shape and pose alone tell them apart', () => {
    const signatures = AGENT_STATES.map((state) => shapeOnly(STATE_VISUALS[state]))
    expect(new Set(signatures).size).toBe(AGENT_STATES.length)
  })

  test('no two states with a bubble share an icon', () => {
    const icons = AGENT_STATES.flatMap((state) => STATE_VISUALS[state].bubble?.icon ?? [])
    expect(new Set(icons).size).toBe(icons.length)
  })

  test('only a permission wait pulses, and only a permission wait has a red lamp', () => {
    for (const state of AGENT_STATES) {
      const visual = STATE_VISUALS[state]
      expect(visual.bubble?.pulse ?? false, state).toBe(state === 'waiting_permission')
      expect(visual.lamp, state).toBe(state === 'waiting_permission' ? 'red' : state === 'waiting_user' ? 'amber' : 'off')
    }
  })

  test('only stuck is dimmed, and only finished and ended carry a board tag', () => {
    for (const state of AGENT_STATES) {
      expect(STATE_VISUALS[state].dim, state).toBe(state === 'stuck')
      expect(STATE_VISUALS[state].tag !== undefined, state).toBe(state === 'finished' || state === 'ended')
    }
    expect(STATE_VISUALS.finished.tag).toBe('check')
    expect(STATE_VISUALS.ended.tag).toBe('exit')
  })

  test('the table matches design §6 row by row', () => {
    expect(STATE_VISUALS.thinking.bubble?.icon).toBe('dots')
    expect(STATE_VISUALS.reading.bubble?.icon).toBe('book')
    expect(STATE_VISUALS.searching.bubble?.icon).toBe('magnifier')
    expect(STATE_VISUALS.browsing.bubble?.icon).toBe('globe')
    expect(STATE_VISUALS.editing.pose).toBe('type_fast')
    expect(STATE_VISUALS.running.screen).toBe('flicker')
    expect(STATE_VISUALS.delegating.pose).toBe('side')
    expect(STATE_VISUALS.waiting_permission.pose).toBe('stand_wave')
    expect(STATE_VISUALS.waiting_user.bubble).toBeUndefined()
    expect(STATE_VISUALS.compacting.bubble?.icon).toBe('stack')
    expect(STATE_VISUALS.stuck.bubble?.style).toBe('muted')
    expect(STATE_VISUALS.rate_limited.pose).toBe('sleep')
    expect(STATE_VISUALS.failed.pose).toBe('slump')
    expect(STATE_VISUALS.failed.bubble?.style).toBe('alert')
  })

  test('the monitor says something too: dark when off or booting, red for a failure, flickering for a command', () => {
    for (const state of AGENT_STATES) {
      const expected =
        state === 'failed'
          ? 'error'
          : state === 'running'
            ? 'flicker'
            : ['starting', 'rate_limited', 'finished', 'ended'].includes(state)
              ? 'off'
              : 'on'
      expect(STATE_VISUALS[state].screen, state).toBe(expected)
    }
  })

  test('a failed agent is told from a rate-limited one by more than the bubble: their screens differ', () => {
    expect(STATE_VISUALS.failed.screen).not.toBe(STATE_VISUALS.rate_limited.screen)
    expect(STATE_VISUALS.starting.screen).not.toBe(STATE_VISUALS.thinking.screen)
  })

  test('lampFor reads the same table', () => {
    const world = allStatesWorld()
    for (const state of AGENT_STATES) {
      const agent = Object.values(world.agents).find((a) => a.state === state)
      expect(lampFor(agent as Agent)).toBe(STATE_VISUALS[state].lamp)
    }
  })
})

describe('frames', () => {
  const poses = Object.keys(POSE_FRAMES) as Pose[]

  test('every state names a pose that has frames', () => {
    for (const state of AGENT_STATES) expect(POSE_FRAMES[STATE_VISUALS[state].pose].frames.length).toBeGreaterThan(0)
  })

  test('a moving pose cycles through its frames over its period', () => {
    const { frames, periodMs } = POSE_FRAMES.type
    expect(frameAt('type', 0, false)).toEqual(frames[0])
    expect(frameAt('type', periodMs / 2, false)).toEqual(frames[1])
    expect(frameAt('type', periodMs, false)).toEqual(frames[0])
    expect(frameAt('type', periodMs * 7 + 1, false)).toEqual(frames[0])
  })

  test('reduced motion always shows the first frame', () => {
    for (const pose of poses) {
      for (const t of [0, 137, 999, 12_345]) expect(frameAt(pose, t, true)).toEqual(POSE_FRAMES[pose].frames[0])
    }
  })

  test('frozen never moves, even with motion on', () => {
    for (const t of [0, 250, 800, 5000]) expect(frameAt('frozen', t, false)).toEqual(POSE_FRAMES.frozen.frames[0])
  })

  test('a waiting agent stands two pixels taller than anyone sitting, in both frames of the wave', () => {
    for (const ref of POSE_FRAMES.stand_wave.frames) expect(ref.dy).toBe(-2)
    for (const pose of ['type', 'lean_fwd', 'lean_back', 'sleep', 'slump'] as const) {
      for (const ref of POSE_FRAMES[pose].frames) expect(ref.dy, pose).toBeGreaterThanOrEqual(0)
    }
  })

  test('a negative time does not throw or index out of range', () => {
    expect(frameAt('type', -1, false)).toBeDefined()
  })
})

describe('directionBetween', () => {
  const origin = { x: 100, y: 100 }
  test.each([
    [{ x: 132, y: 100 }, 'right'],
    [{ x: 60, y: 110 }, 'left'],
    [{ x: 100, y: 160 }, 'down'],
    [{ x: 90, y: 20 }, 'up'],
    [{ x: 132, y: 132 }, 'right'],
    [{ x: 68, y: 68 }, 'left'],
  ] as const)('%o is %s', (to, direction) => {
    expect(directionBetween(origin, to)).toBe(direction)
  })
})

describe('formatAgo', () => {
  test.each([
    [0, '0s'],
    [45_000, '45s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [12 * 60_000, '12m'],
    [3 * 3_600_000, '3h'],
    [-5000, '0s'],
  ])('%d ms is %s', (ms, text) => {
    expect(formatAgo(ms)).toBe(text)
  })
})

describe('resolveBubble', () => {
  test('a state without a bubble has none', () => {
    for (const state of ['waiting_user', 'finished', 'ended'] as AgentState[]) {
      expect(bubbleOf(stateWorld(state), s(1)), state).toBeUndefined()
    }
  })

  test('reading, searching, browsing and editing show the file or host', () => {
    expect(bubbleOf(stateWorld('reading'), s(1))).toMatchObject({ icon: 'book', text: 'index.ts' })
    expect(bubbleOf(stateWorld('searching'), s(1))).toMatchObject({ icon: 'magnifier', text: 'TODO' })
    expect(bubbleOf(stateWorld('browsing'), s(1))).toMatchObject({ icon: 'globe', text: 'example.com' })
    expect(bubbleOf(stateWorld('editing'), s(1))).toMatchObject({ icon: 'pencil', text: 'app.ts' })
  })

  test('running shows the command verb', () => {
    expect(bubbleOf(stateWorld('running'), s(1))).toMatchObject({ icon: 'prompt', text: 'npm' })
  })

  test('delegating shows the subagent label and an arrow toward its stool', () => {
    expect(bubbleOf(stateWorld('delegating'), s(1))).toMatchObject({ icon: 'arrow', text: 'Explore', direction: 'right' })
  })

  test('delegating with no child placed still points somewhere', () => {
    const world = stateWorld('delegating')
    const alone: World = { ...world, agents: { [s(1)]: agentOf(world, s(1)) } }
    expect(bubbleOf(alone, s(1))).toMatchObject({ icon: 'arrow', direction: 'right', text: undefined })
  })

  test('a child that has stopped being a child gives the arrow nothing to point at, so it points right', () => {
    const world = stateWorld('delegating')
    const child = agentOf(world, sub(1))
    const moved: World = { ...world, agents: { [s(1)]: agentOf(world, s(1)), [sub(1)]: { ...child, parentId: 'nobody' } } }
    expect(bubbleOf(moved, s(1))).toMatchObject({ direction: 'right', text: undefined })
  })

  test('a finished child is not the one the arrow points at', () => {
    const world = stateWorld('delegating')
    const done = { ...agentOf(world, sub(1)), state: 'finished' as const }
    expect(bubbleOf({ ...world, agents: { ...world.agents, [sub(1)]: done } }, s(1))?.text).toBeUndefined()
  })

  test('stuck shows how long the agent has been quiet', () => {
    expect(bubbleOf(stateWorld('stuck'), s(1))).toMatchObject({ icon: 'bang', style: 'muted', text: '12m' })
  })

  test('rate limited shows the time to the quota reset, and only with quota data', () => {
    expect(bubbleOf(stateWorld('rate_limited'), s(1))).toMatchObject({ icon: 'zzz', text: '42m' })
    const noQuota: World = { ...stateWorld('rate_limited'), quota: undefined }
    expect(bubbleOf(noQuota, s(1))).toMatchObject({ icon: 'zzz', text: undefined })
    const past: World = { ...stateWorld('rate_limited'), quota: { p5h: 100, p7d: 40, resets5h: '2026-01-15T10:00:00.000Z' } }
    expect(bubbleOf(past, s(1))?.text).toBeUndefined()
  })

  test('a permission wait is a pulsing red question mark; reduced motion stops the pulse', () => {
    const world = stateWorld('waiting_permission')
    expect(bubbleOf(world, s(1))).toMatchObject({ icon: 'question', style: 'alert', pulse: true })
    expect(bubbleOf(world, s(1), true)).toMatchObject({ icon: 'question', style: 'alert', pulse: false })
  })

  test('long text is cut to the cap with an ellipsis', () => {
    const world = stateWorld('reading')
    const long = { ...agentOf(world, s(1)), currentTool: { name: 'Read', target: 'a-very-long-file-name.ts' } }
    const text = resolveBubble(long, { ...world, agents: { [s(1)]: long } }, layout(world), false)?.text
    expect(text).toHaveLength(BUBBLE_TEXT_MAX)
    expect(text?.endsWith('…')).toBe(true)
    expect(text).toBe('a-very-long…')
  })

  test('text that just fits is left alone', () => {
    const world = stateWorld('reading')
    const fits = { ...agentOf(world, s(1)), currentTool: { name: 'Read', target: 'abcdefghijkl' } }
    expect(resolveBubble(fits, { ...world, agents: { [s(1)]: fits } }, layout(world), false)?.text).toBe('abcdefghijkl')
  })
})

describe('the empty scenes', () => {
  test('the four scenes differ from each other', () => {
    const scenes = Object.values(EMPTY_SCENES).map((scene) => JSON.stringify(scene))
    expect(new Set(scenes).size).toBe(4)
  })
})

describe('tooltip and screen-reader text', () => {
  test('a reading agent: who, state and time, tool, model', () => {
    const world = stateWorld('reading')
    expect(tooltipLines(agentOf(world, s(1)), world)).toEqual([
      'session 000a0001 · demo',
      'reading · 2m ago',
      'Read index.ts',
      'claude-sonnet-5-5',
    ])
  })

  test('a failed agent adds its error text', () => {
    const world = stateWorld('failed')
    expect(tooltipLines(agentOf(world, s(1)), world).join('\n')).toContain('API Error: invalid request')
  })

  test('only a failed agent shows error text', () => {
    const world = stateWorld('thinking')
    const withError = { ...agentOf(world, s(1)), error: { kind: 'other' as const, message: 'x' } }
    expect(tooltipLines(withError, world).join('\n')).not.toContain('x')
  })

  test('an inferred permission wait says so', () => {
    const world = stateWorld('waiting_permission')
    const inferred = { ...agentOf(world, s(1)), stateEvidence: 'inferred' as const }
    expect(tooltipLines(inferred, world)[1]).toContain('waiting for permission? (inferred)')
  })

  test('a subagent is named by its label', () => {
    const world = stateWorld('delegating')
    expect(tooltipLines(agentOf(world, sub(1)), world)[0]).toContain('Explore')
  })

  test('ariaLabel joins the same lines', () => {
    const world = stateWorld('reading')
    expect(ariaLabel(agentOf(world, s(1)), world)).toBe(tooltipLines(agentOf(world, s(1)), world).join(' — '))
  })
})
