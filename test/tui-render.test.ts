/* eslint-disable no-control-regex -- the test is about control characters */
// renderTui: the acceptance matrix. Eight fixture worlds at three sizes, in colour and without: every
// frame is exactly the size of the terminal, holds no control character but the colour codes the line
// builder writes, shows exactly the agents visibleAgents says, and its office, list and status bar agree
// on the counts. Then the hostile strings, the tiny sizes, the focus, the selection and the animation.

import { describe, expect, test } from 'vitest'
import { modelFamily } from '../src/core/office/roles.js'
import { cellWidth } from '../src/core/tui/cells.js'
import { FAMILY_LETTERS, MORTY_WORDS, STATE_GLYPHS } from '../src/core/tui/glyphs.js'
import { ALLOWED_SGR, stripSgr } from '../src/core/tui/line.js'
import { layout } from '../src/core/office/layout.js'
import { renderTui, type TuiFrame, type TuiOptions, type TuiSize } from '../src/core/tui/render.js'
import { INITIAL_UI } from '../src/core/tui/ui.js'
import { AGENT_STATES, type World } from '../src/core/types.js'
import { agentStateLabel, shortId } from '../src/core/view.js'
import { visibleAgents, withVisibleAgents } from '../src/core/visible.js'
import { WORLD_FIXTURES } from '../scripts/world-fixture-lib.js'

const WORLDS = ['rooms', 'all-states', 'crowd-250-idle', 'mascot-play', 'empty-starting', 'empty-unreadable', 'empty-no-collector', 'empty-no-agents']
const SIZES: TuiSize[] = [
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 200, rows: 60 },
]
const MORTY = { activity: 'nap', walking: false, room: 'lobby' } as const

const fixture = (name: string): World => (WORLD_FIXTURES[name] as () => World)()
const nowOf = (world: World): number => Date.parse(world.clock)

function render(world: World, size: TuiSize, patch: Partial<TuiOptions> = {}): TuiFrame {
  return renderTui(world, size, nowOf(world), { ui: INITIAL_UI, color: false, unicode: true, animate: false, animationMs: 0, morty: MORTY, ...patch })
}

const plain = (frame: TuiFrame): string[] => frame.lines.map(stripSgr)

/** The office's lines: from the first body line to the line where the list's title is. */
function officeLines(lines: readonly string[]): string[] {
  const end = lines.findIndex((l, i) => i >= 3 && /^[[ ]Agents \d+/.test(l))
  return lines.slice(3, end < 0 ? lines.length : end)
}

const TOKEN = /(?<=[ >:])[\^?REXSBD!WC#$F+-][oshf.OSHF*](?=[ :│|]|$)/g

describe.each(WORLDS)('%s', (name) => {
  const world = fixture(name)
  const ids = visibleAgents(world, nowOf(world)).ids

  describe.each(SIZES)('at $cols×$rows', (size) => {
    describe.each([false, true])('colour %s', (color) => {
      const frame = render(world, size, { color })

      test('is exactly the size of the terminal', () => {
        expect(frame.lines).toHaveLength(size.rows)
        for (const l of frame.lines) expect(cellWidth(stripSgr(l))).toBe(size.cols)
      })

      test('holds no control character but the allowed colour codes', () => {
        for (const l of frame.lines) {
          const rest = l.replace(ALLOWED_SGR, '')
          expect(rest).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
          expect(rest).not.toMatch(/\p{Cf}/u)
          if (!color) expect(l).not.toContain('\x1b')
        }
      })
    })

    const lines = plain(render(world, size))

    test('shows exactly the visible agents, and the counts agree', () => {
      const frame = render(world, size)
      expect(frame.meta.visible).toBe(ids.size)
      expect(new Set(frame.meta.listOrder)).toEqual(new Set(ids))
      expect(lines[1]).toMatch(new RegExp(`^busy \\d+/${ids.size}\\b`))
      if (ids.size > 0) {
        expect(lines.find((l) => /^[[ ]Agents \d+/.test(l))).toMatch(new RegExp(`^[[ ]Agents ${ids.size}\\b`))
        const header = lines.find((l) => l.startsWith('Office · '))
        expect(header).toMatch(new RegExp(`^Office · ${ids.size} agents?\\b`))
        const office = frame.meta.office
        expect(office).toBeDefined()
        expect((office?.shown ?? 0) + (office?.elided ?? 0)).toBe(ids.size)
        const tokens = officeLines(lines)
          .filter((l) => !l.startsWith('Key:') && !l.startsWith('Office ·'))
          .flatMap((l) => l.match(TOKEN) ?? [])
        expect(tokens).toHaveLength(office?.shown ?? -1)
      } else {
        expect(frame.meta.office).toBeUndefined()
        expect(frame.meta.listOrder).toEqual([])
      }
    })
  })
})

describe('crowd-250-idle', () => {
  test('is 49 agents in view and says what it leaves out, in the status bar', () => {
    const world = fixture('crowd-250-idle')
    const frame = render(world, { cols: 200, rows: 60 })
    expect(frame.meta.visible).toBe(49)
    expect(plain(frame)[1]).toContain('195 idle not shown · 6 finished not shown')
  })

  test('twenty frames at 200×60 are quick', () => {
    const world = fixture('crowd-250-idle')
    const started = performance.now()
    for (let i = 0; i < 20; i++) render(world, { cols: 200, rows: 60 })
    const each = (performance.now() - started) / 20
    console.log(`renderTui crowd-250-idle 200x60: ${each.toFixed(1)} ms a frame`)
    expect(each).toBeLessThan(100)
  })
})

describe('every state tells itself apart by glyph and word', () => {
  const world = fixture('all-states')
  const view = withVisibleAgents(world, visibleAgents(world, nowOf(world)))

  test('the list row of each agent has its glyph, its family letter and its state\'s word', () => {
    const frame = render(world, { cols: 200, rows: 60 })
    const lines = plain(frame)
    for (const agent of Object.values(view.agents)) {
      const token = `${STATE_GLYPHS[agent.state]}${FAMILY_LETTERS[modelFamily(agent.model)]}`
      const row = lines.find((l) => l.includes(`${token} ${shortId(agent.id)}`))
      expect(row, `${agent.state} ${agent.id}`).toBeDefined()
      expect(row).toContain(agentStateLabel(agent))
    }
  })

  test('all sixteen states are in the world in view', () => {
    expect(new Set(Object.values(view.agents).map((a) => a.state)).size).toBe(AGENT_STATES.length)
  })
})

describe('hostile strings', () => {
  const hostile = (): World => {
    const world = fixture('rooms')
    const id = Object.keys(world.agents)[1] as string
    const agent = world.agents[id]!
    agent.label = '\x1b]0;owned\x07evil\nname\u{202e}\u{200b}' + '漢'.repeat(30) + '🐕'
    agent.project = 'pro\x1b[2Jject\r\n'
    agent.model = 'claude-opus\x9b31m'
    agent.currentTool = { name: 'Bash', target: 'rm\x1b[31m -rf\t/x\u{2028}y' }
    world.log.push({ ts: world.clock, agentId: id, kind: 'tool', text: 'done\x1b[?1049l\x07\x1b]52;c;AAAA\x07' })
    return world
  }

  test.each(SIZES)('at $cols×$rows, in colour and without, nothing from the World becomes a sequence', (size) => {
    for (const color of [false, true]) {
      const frame = render(hostile(), size, { color })
      expect(frame.lines).toHaveLength(size.rows)
      for (const l of frame.lines) {
        expect(cellWidth(stripSgr(l))).toBe(size.cols)
        const rest = l.replace(ALLOWED_SGR, '')
        expect(rest).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
        expect(rest).not.toMatch(/\p{Cf}/u)
      }
      const text = plain(frame).join('\n')
      expect(text).not.toContain('owned')
      expect(text).not.toContain('52;c')
      expect(text).not.toContain('?1049')
    }
  })

  test('at 200×60 the log still says what happened, and the label is a plain word', () => {
    const text = plain(render(hostile(), { cols: 200, rows: 60 })).join('\n')
    expect(text).toContain('done')
    expect(text).toContain('evil name')
  })

  test('an unreadable folder\'s error message is stripped on the empty screen', () => {
    const world = fixture('empty-unreadable')
    world.sources.transcripts.error = 'bad\x1b]52;c;AAAA\x07 \x1b[31mred\x1b[0m'
    const text = plain(render(world, SIZES[0] as TuiSize)).join('\n')
    expect(text).toContain('bad red')
    expect(text).not.toContain('52;c')
  })
})

describe('odd sizes', () => {
  const sizes: [number, number][] = [[1, 1], [19, 4], [20, 5], [59, 19], [60, 20], [99, 30], [100, 30], [30, 8], [500, 12]]

  test.each(sizes)('%i×%i fits exactly', (cols, rows) => {
    const frame = render(fixture('crowd-250-idle'), { cols, rows })
    expect(frame.lines).toHaveLength(rows)
    for (const l of frame.lines) expect(cellWidth(stripSgr(l))).toBe(cols)
  })

  test('the office says why it is not there', () => {
    expect(plain(render(fixture('rooms'), { cols: 59, rows: 19 }))[2]).toContain('office hidden')
    expect(plain(render(fixture('rooms'), { cols: 80, rows: 24 }, { ui: { ...INITIAL_UI, officeOn: false } }))[2]).toContain('office off')
    expect(plain(render(fixture('rooms'), { cols: 80, rows: 24 }))[2]).not.toContain('office')
  })

  test('below 20×5 it says the terminal is too small', () => {
    expect(plain(render(fixture('rooms'), { cols: 19, rows: 4 }))[0]).toContain('Cubiclark:')
  })

  test('with the office off, no office is drawn and the rows go to the list and the log', () => {
    const frame = render(fixture('rooms'), { cols: 120, rows: 40 }, { ui: { ...INITIAL_UI, officeOn: false } })
    expect(frame.meta.office).toBeUndefined()
    expect(plain(frame).some((l) => l.startsWith('Office ·'))).toBe(false)
    expect(frame.meta.listRows).toBeGreaterThan(30)
  })
})

describe('focus', () => {
  test('the focused view is in brackets in the header', () => {
    const world = fixture('rooms')
    for (const [focus, label] of [['office', '[Office]'], ['list', '[List]'], ['log', '[Log]']] as const) {
      const frame = render(world, { cols: 80, rows: 24 }, { ui: { ...INITIAL_UI, focus } })
      expect(plain(frame)[0]).toContain(label)
      expect(frame.meta.focus).toBe(focus)
    }
  })

  test('the office has no focus when it is not on screen', () => {
    const frame = render(fixture('rooms'), { cols: 59, rows: 19 }, { ui: { ...INITIAL_UI, focus: 'office' } })
    expect(frame.meta.focus).toBe('list')
    expect(plain(frame)[0]).toContain('[List]')
  })
})

describe('selection', () => {
  test('a visible agent has a > in the list, in the office and a card line', () => {
    const world = fixture('rooms')
    const base = render(world, { cols: 120, rows: 40 })
    const id = base.meta.listOrder[3] as string
    const frame = render(world, { cols: 120, rows: 40 }, { ui: { ...INITIAL_UI, selectedId: id } })
    const lines = plain(frame)
    expect(lines.filter((l) => l.startsWith('>'))).toHaveLength(1)
    expect(lines.some((l) => l.startsWith('› '))).toBe(true)
    expect(officeLines(lines).join('\n').match(/>[^\s]{2}/g)).toHaveLength(1)
  })

  test('an agent that is not in view is no selection at all', () => {
    const frame = render(fixture('rooms'), { cols: 120, rows: 40 }, { ui: { ...INITIAL_UI, selectedId: 'not-an-agent' } })
    const lines = plain(frame)
    expect(lines.filter((l) => l.startsWith('>'))).toHaveLength(0)
    expect(lines.some((l) => l.startsWith('› '))).toBe(false)
  })

  test('a hidden idle agent is not shown even when it was selected', () => {
    const world = fixture('crowd-250-idle')
    const visible = visibleAgents(world, nowOf(world))
    const hidden = Object.keys(world.agents).find((id) => !visible.ids.has(id)) as string
    const lines = plain(render(world, { cols: 120, rows: 40 }, { ui: { ...INITIAL_UI, selectedId: hidden } }))
    expect(lines.some((l) => l.startsWith('› '))).toBe(false)
    expect(lines.filter((l) => l.startsWith('>'))).toHaveLength(0)
  })
})

describe('animation', () => {
  const world = fixture('state-editing')

  test('typing letters flip with the clock only when animation is on', () => {
    const at = (animate: boolean, animationMs: number): string[] => plain(render(world, { cols: 120, rows: 40 }, { animate, animationMs, morty: undefined }))
    expect(at(true, 0)).not.toEqual(at(true, 500))
    expect(at(false, 0)).toEqual(at(false, 500))
    expect(at(true, 0)).toEqual(at(false, 0))
  })

  test('meta.animated says so', () => {
    expect(render(world, { cols: 120, rows: 40 }, { animate: true }).meta.animated).toBe(true)
    expect(render(world, { cols: 120, rows: 40 }, { animate: false }).meta.animated).toBe(false)
  })
})

describe('Morty in the frame', () => {
  test('is on the line meta says, with his word, and absent without him', () => {
    const world = fixture('mascot-play')
    const frame = render(world, { cols: 120, rows: 40 })
    const lines = plain(frame)
    expect(frame.meta.office?.mortyLine).toBeDefined()
    expect(lines[frame.meta.office?.mortyLine as number]).toContain(`🐕 ${MORTY_WORDS.nap}`)
    const without = plain(render(world, { cols: 120, rows: 40 }, { morty: undefined })).join('\n')
    for (const word of Object.values(MORTY_WORDS)) expect(without).not.toContain(word)
  })
})

describe('a layout that is not of this world', () => {
  test('is recomputed, so the frame is the one without it', () => {
    const rooms = fixture('rooms')
    const other = fixture('mascot-play')
    const stale = layout(other)
    const a = render(rooms, { cols: 120, rows: 40 }, { layout: stale })
    const b = render(rooms, { cols: 120, rows: 40 })
    expect(a.lines).toEqual(b.lines)
  })
})
