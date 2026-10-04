// The controller: UI state, scene and frames over a stream of Worlds.

import { describe, expect, test } from 'vitest'
import { MORTY_WORDS } from '../src/core/tui/glyphs.js'
import { stripSgr } from '../src/core/tui/line.js'
import { renderTui } from '../src/core/tui/render.js'
import { INITIAL_UI } from '../src/core/tui/ui.js'
import type { World } from '../src/core/types.js'
import { TuiController, type ControllerOptions } from '../src/tui/controller.js'
import { WORLD_FIXTURES } from '../scripts/world-fixture-lib.js'

const SIZE = { cols: 120, rows: 40 }
const fixture = (name: string): World => (WORLD_FIXTURES[name] as () => World)()
const make = (patch: Partial<ControllerOptions> = {}): TuiController => new TuiController({ mascot: false, animate: false, color: false, unicode: true, ...patch })
const text = (lines: readonly string[]): string => lines.map(stripSgr).join('\n')

describe('frame', () => {
  test('is what renderTui makes from the same state', () => {
    const world = fixture('rooms')
    const frame = make().frame(world, SIZE, 0)
    const direct = renderTui(world, SIZE, Date.parse(world.clock), { ui: INITIAL_UI, color: false, unicode: true, animate: false, animationMs: 0 })
    expect(frame.lines).toEqual(direct.lines)
  })

  test('the same World twice gives the same frame', () => {
    const controller = make()
    const world = fixture('rooms')
    expect(controller.frame(world, SIZE, 0).lines).toEqual(controller.frame(world, SIZE, 1000).lines)
  })
})

describe('keys', () => {
  test('down selects the first agent of the list, and the next frame marks it', () => {
    const controller = make()
    const world = fixture('rooms')
    const first = controller.frame(world, SIZE, 0)
    expect(controller.key('down')).toBe(false)
    const frame = controller.frame(world, SIZE, 100)
    expect(controller.state.selectedId).toBe(first.meta.listOrder[0])
    expect(frame.lines.map(stripSgr).filter((l) => l.startsWith('>'))).toHaveLength(1)
  })

  test('q quits', () => {
    const controller = make()
    controller.frame(fixture('rooms'), SIZE, 0)
    expect(controller.key('quit')).toBe(true)
  })

  test('l takes the office away and brings it back', () => {
    const controller = make()
    const world = fixture('rooms')
    controller.frame(world, SIZE, 0)
    controller.key('office')
    expect(text(controller.frame(world, SIZE, 100).lines)).not.toContain('Office ·')
    controller.key('office')
    expect(text(controller.frame(world, SIZE, 200).lines)).toContain('Office ·')
  })

  test('Tab moves the focus the header shows', () => {
    const controller = make()
    const world = fixture('rooms')
    controller.frame(world, SIZE, 0)
    controller.key('tab')
    expect(text(controller.frame(world, SIZE, 100).lines)).toContain('[Log]')
    controller.key('tab')
    expect(text(controller.frame(world, SIZE, 200).lines)).toContain('[Office]')
  })

  test('the arrows scroll the log when it has the focus, and the page keeps its selection', () => {
    const controller = make()
    const world = fixture('rooms')
    for (let i = 0; i < 60; i++) world.log.push({ ts: world.clock, agentId: Object.keys(world.agents)[0] as string, kind: 'tool', text: `line ${i}` })
    controller.frame(world, SIZE, 0)
    controller.key('down')
    controller.key('tab')
    controller.frame(world, SIZE, 100)
    controller.key('up')
    controller.key('up')
    const frame = controller.frame(world, SIZE, 200)
    expect(controller.state.logScroll).toBe(2)
    expect(text(frame.lines)).toContain('2 back')
    expect(controller.state.selectedId).toBeDefined()
  })
})

describe('a selected agent that leaves view', () => {
  test('is deselected, and no row or card names it', () => {
    const controller = make()
    const world = fixture('crowd-250-idle')
    const first = controller.frame(world, SIZE, 0)
    controller.key('down')
    const id = first.meta.listOrder[0] as string
    expect(controller.frame(world, SIZE, 100).lines.map(stripSgr).some((l) => l.startsWith('› '))).toBe(true)

    const later = structuredClone(world)
    const agent = later.agents[id]!
    agent.state = 'finished'
    agent.stateSince = new Date(Date.parse(world.clock) - 3_600_000).toISOString()
    later.clock = new Date(Date.parse(world.clock) + 1000).toISOString()
    const frame = controller.frame(later, SIZE, 200)
    expect(frame.meta.listOrder).not.toContain(id)
    expect(controller.state.selectedId).toBeUndefined()
    const lines = frame.lines.map(stripSgr)
    expect(lines.some((l) => l.startsWith('› '))).toBe(false)
    expect(lines.filter((l) => l.startsWith('>'))).toHaveLength(0)
  })
})

describe('Morty over a stream of Worlds', () => {
  test('is absent from an empty screen, and starts his day again when agents come back', () => {
    const controller = make({ mascot: true, animate: true })
    controller.frame(fixture('rooms'), SIZE, 0)
    const empty = controller.frame(fixture('empty-no-agents'), SIZE, 100_000)
    for (const word of Object.values(MORTY_WORDS)) expect(text(empty.lines)).not.toContain(word)
    for (const at of [200_000, 200_500]) {
      const back = controller.frame(fixture('rooms'), SIZE, at)
      const fresh = make({ mascot: true, animate: true }).frame(fixture('rooms'), SIZE, at)
      expect(back.lines).toEqual(fresh.lines)
    }
  })

  test('with --no-mascot he is never there', () => {
    const controller = make({ mascot: false, animate: true })
    for (const at of [0, 60_000, 600_000]) {
      for (const word of Object.values(MORTY_WORDS)) expect(text(controller.frame(fixture('mascot-play'), SIZE, at).lines)).not.toContain(word)
    }
  })

  test('with animation off he sleeps in his basket however long it has been', () => {
    const controller = make({ mascot: true, animate: false })
    for (const at of [0, 600_000, 1_800_000]) expect(text(controller.frame(fixture('mascot-play'), SIZE, at).lines)).toContain(`🐕 ${MORTY_WORDS.nap}`)
  })
})

describe('animated', () => {
  test('is true while something moves, and false with animation off', () => {
    const on = make({ mascot: true, animate: true })
    on.frame(fixture('mascot-play'), SIZE, 0)
    expect(on.animated).toBe(true)
    const off = make({ mascot: true, animate: false })
    off.frame(fixture('mascot-play'), SIZE, 0)
    expect(off.animated).toBe(false)
  })
})
