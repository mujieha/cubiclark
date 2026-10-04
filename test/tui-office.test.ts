// The text office: rooms, desks with their helpers beside them, the lobby, Morty by room, and the cut.

import { describe, expect, test } from 'vitest'
import { layout, type OfficeLayout } from '../src/core/office/layout.js'
import type { MascotActivity } from '../src/core/office/mascot.js'
import type { RoomId } from '../src/core/office/roles.js'
import { cellWidth } from '../src/core/tui/cells.js'
import { MORTY_WORDS } from '../src/core/tui/glyphs.js'
import { line, stripSgr } from '../src/core/tui/line.js'
import { officeText, type OfficeText } from '../src/core/tui/office-text.js'
import type { TuiMorty } from '../src/core/tui/scene.js'
import type { World } from '../src/core/types.js'
import { visibleAgents, withVisibleAgents } from '../src/core/visible.js'
import { WORLD_FIXTURES } from '../scripts/world-fixture-lib.js'

const mono = { color: false, unicode: true }

interface Built {
  view: World
  lay: OfficeLayout
  hidden: ReturnType<typeof visibleAgents>['hidden']
}

function build(name: string): Built {
  const world = (WORLD_FIXTURES[name] as () => World)()
  const visible = visibleAgents(world, Date.parse(world.clock))
  const view = withVisibleAgents(world, visible)
  return { view, lay: layout(view), hidden: visible.hidden }
}

function office(name: string, extra: Partial<Parameters<typeof officeText>[0]> = {}, width = 120, maxRows = 40): { built: Built; result: OfficeText | undefined } {
  const built = build(name)
  return { built, result: officeText({ view: built.view, layout: built.lay, hidden: built.hidden, width, maxRows, animate: false, animationMs: 0, unicode: true, ...extra }) }
}

const textOf = (result: OfficeText, width = 120): string[] => result.rows.map((row) => stripSgr(line(row, width, mono)))

describe('the rooms of the rooms world', () => {
  const { built, result } = office('rooms')
  const lines = textOf(result as OfficeText)

  test('names the three top rooms, one box per project cluster, and the lobby', () => {
    expect(lines.join('\n')).toContain("Manager's office")
    expect(lines.join('\n')).toContain('Planning room')
    expect(lines.join('\n')).toContain('Review corner')
    for (const cluster of built.lay.clusters) expect(lines.join('\n')).toContain(cluster.project)
    expect(lines.some((l) => l.startsWith('Lobby:'))).toBe(true)
  })

  test('draws every agent in view, none cut', () => {
    const r = result as OfficeText
    expect(r.elided).toBe(0)
    expect(r.shown).toBe(Object.keys(built.view.agents).length)
  })

  test('the order is the layout\'s reading order', () => {
    expect((result as OfficeText).order).toEqual(built.lay.placements.map((p) => p.agentId))
  })

  test('a helper\'s token follows its anchor\'s, joined by a colon', () => {
    const r = result as OfficeText
    const stools = built.lay.placements.filter((p) => p.kind === 'stool')
    expect(stools.length).toBeGreaterThan(0)
    // every colon-joined token is a stool helper: as many ':' separators as stools, and none otherwise
    const colons = lines.join('\n').match(/:[^\s]{2}/g) ?? []
    expect(colons.filter((c) => /^:[\^?REXSBD!WC#$F+-][oshf.]$/.test(c))).toHaveLength(stools.length)
    expect(r.shown).toBeGreaterThan(stools.length)
  })

  test('the header counts the same agents as the rows', () => {
    expect(lines[0]).toMatch(new RegExp(`^Office · ${Object.keys(built.view.agents).length} agents`))
  })
})

describe('the selected agent', () => {
  test('has a > right before its token and nowhere else', () => {
    const built = build('rooms')
    const id = built.lay.placements[2]!.agentId
    const result = officeText({ view: built.view, layout: built.lay, hidden: built.hidden, width: 120, maxRows: 40, animate: false, animationMs: 0, unicode: true, selectedId: id }) as OfficeText
    const lines = textOf(result)
    // the box edges and the elided note do not use '>'
    expect(lines.join('\n').match(/>[^\s]{2}/g)).toHaveLength(1)
  })
})

describe('a crowd', () => {
  test('crowd-250-idle at 10 rows is cut, says how many are missing, and fits', () => {
    const { result, built } = office('crowd-250-idle', {}, 120, 10)
    const r = result as OfficeText
    expect(r.rows.length).toBeLessThanOrEqual(10)
    expect(r.elided).toBeGreaterThan(0)
    expect(r.shown + r.elided).toBe(Object.keys(built.view.agents).length)
    expect(textOf(r).some((l) => l.includes(`… ${r.elided} more agents`))).toBe(true)
  })

  test('is left out below 6 rows or 60 columns', () => {
    expect(office('rooms', {}, 120, 5).result).toBeUndefined()
    expect(office('rooms', {}, 59, 40).result).toBeUndefined()
    expect(office('rooms', {}, 60, 6).result).toBeDefined()
  })

  test('every width gives rows no wider than it', () => {
    for (const width of [60, 80, 99, 120, 200]) {
      for (const maxRows of [6, 9, 14, 30]) {
        const { result } = office('crowd-250-idle', {}, width, maxRows)
        const r = result as OfficeText
        expect(r.rows.length).toBeLessThanOrEqual(maxRows)
        for (const row of r.rows) expect(cellWidth(stripSgr(line(row, width, mono)))).toBe(width)
        expect(row0width(r, width)).toBeLessThanOrEqual(width)
      }
    }
  })
})

/** The natural width of every row but the header (which line() cuts): boxes and flow lines fit by themselves. */
function row0width(r: OfficeText, width: number): number {
  return Math.max(...r.rows.slice(1).map((row) => cellWidth(stripSgr(line(row, width + 40, mono)).trimEnd())))
}

describe('Morty', () => {
  const activities = Object.keys(MORTY_WORDS) as MascotActivity[]
  const rooms: (RoomId | 'hall' | undefined)[] = ['manager', 'review', 'floor', 'hall', 'lobby', undefined]

  test.each(activities.flatMap((activity) => rooms.map((room) => [activity, room] as const)))('%s in %s: his glyph and word are on the right line', (activity, room) => {
    const morty: TuiMorty = { activity, walking: false, room }
    const { result } = office('rooms', { morty })
    const r = result as OfficeText
    expect(r.mortyRow).toBeDefined()
    const lines = textOf(r)
    const mine = lines[r.mortyRow as number] as string
    expect(mine).toContain(`🐕 ${MORTY_WORDS[activity]}`)
    if (room === 'manager') expect(mine).toContain('│')
    if (room === 'review') expect(mine).toContain('│')
    if (room === 'floor' || room === 'hall') expect(mine.startsWith('Project floor:')).toBe(true)
    if (room === 'lobby' || room === undefined) expect(mine.startsWith('Lobby:')).toBe(true)
  })

  test('without him no row has any of his words', () => {
    const { result } = office('rooms')
    const text = textOf(result as OfficeText).join('\n')
    for (const word of Object.values(MORTY_WORDS)) expect(text).not.toContain(word)
    expect((result as OfficeText).mortyRow).toBeUndefined()
  })

  test('with a companion, walking, he says so; in ASCII he is a d', () => {
    const morty: TuiMorty = { activity: 'play', walking: true, room: 'lobby', withId: 'session-0000abcd' }
    const lines = textOf(office('rooms', { morty, unicode: false }).result as OfficeText)
    expect(lines.join('\n')).toContain('d playing ball 0000abcd (walking)')
  })

  test('is not counted as an agent', () => {
    const base = office('rooms').result as OfficeText
    const withHim = office('rooms', { morty: { activity: 'nap', walking: false, room: 'lobby' } }).result as OfficeText
    expect(withHim.shown).toBe(base.shown)
    expect(withHim.order).toEqual(base.order)
  })

  test('stays in the office when the office is cut to a few rows', () => {
    const morty: TuiMorty = { activity: 'nap', walking: false, room: 'lobby' }
    const r = office('crowd-250-idle', { morty }, 120, 8).result as OfficeText
    expect(r.mortyRow).toBeDefined()
    const r2 = office('crowd-250-idle', { morty: { ...morty, room: 'manager' } }, 120, 8).result as OfficeText
    expect(r2.mortyRow).toBeDefined()
  })
})

describe('typing', () => {
  test('a typing agent\'s letter is in capitals on the odd half second, only when animation is on', () => {
    const { built } = office('state-editing')
    const tokenAt = (animate: boolean, animationMs: number): string =>
      textOf(officeText({ view: built.view, layout: built.lay, hidden: built.hidden, width: 120, maxRows: 40, animate, animationMs, unicode: true }) as OfficeText).join('\n')
    expect(tokenAt(true, 0)).toMatch(/ E[a-z.]/)
    expect(tokenAt(true, 500)).toMatch(/ E[A-Z*]/)
    expect(tokenAt(false, 500)).toMatch(/ E[a-z.]/)
    const on = officeText({ view: built.view, layout: built.lay, hidden: built.hidden, width: 120, maxRows: 40, animate: true, animationMs: 0, unicode: true }) as OfficeText
    expect(on.typing).toBe(true)
  })
})
