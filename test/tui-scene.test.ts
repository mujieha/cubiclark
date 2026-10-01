// Morty and the seats in the terminal come from the same machine the page runs, driven without drawing.

import { describe, expect, test } from 'vitest'
import { layout as computeLayout, placementOf } from '../src/core/office/layout.js'
import { initialMascot, mascotSeed, type MascotInput } from '../src/core/office/mascot.js'
import { mascotGrid } from '../src/core/office/mascot-map.js'
import { reconcileActors } from '../src/core/office/motion.js'
import { buildTileMap } from '../src/core/office/tilemap.js'
import { MORTY_WORDS } from '../src/core/tui/glyphs.js'
import { stripSgr } from '../src/core/tui/line.js'
import { renderTui } from '../src/core/tui/render.js'
import { sceneAtFrame, sceneForWorld, type TuiMorty, type TuiScene } from '../src/core/tui/scene.js'
import { INITIAL_UI } from '../src/core/tui/ui.js'
import type { World } from '../src/core/types.js'
import { visibleAgents, withVisibleAgents } from '../src/core/visible.js'
import { WORLD_FIXTURES } from '../scripts/world-fixture-lib.js'

const SIZE = { cols: 120, rows: 40 }
const viewOf = (name: string): World => {
  const world = (WORLD_FIXTURES[name] as () => World)()
  return withVisibleAgents(world, visibleAgents(world, Date.parse(world.clock)))
}
const frameOf = (view: World, morty: TuiMorty | undefined) =>
  renderTui(view, SIZE, Date.parse(view.clock), { ui: INITIAL_UI, color: false, unicode: true, animate: false, animationMs: 0, morty })

describe.each(['mascot-play', 'rooms'])('%s: his day starts as the page\'s does', (name) => {
  test('napping in the lobby, from the very state the machine begins with', () => {
    const view = viewOf(name)
    const scene = sceneForWorld(undefined, view, 0, { mascot: true, reducedMotion: false })
    const { morty } = sceneAtFrame(scene, 0, false)
    expect(morty).toEqual({ activity: 'nap', walking: false, room: 'lobby' })

    const lay = computeLayout(view)
    const grid = mascotGrid(view, lay, buildTileMap(lay, { quota: view.quota !== undefined }))
    const actors = reconcileActors(new Map(), undefined, lay, { nowMs: 0, reducedMotion: false, firstSnapshot: true })
    const input: MascotInput = { world: view, layout: lay, grid, actors, nowMs: 0, reducedMotion: false, arrivals: [] }
    expect(scene.mascot).toEqual(initialMascot(mascotSeed(view.clock), input))
  })
})

describe('a day of Morty', () => {
  test('half an hour in one-second steps: several activities, always a word on his line', () => {
    const view = viewOf('mascot-play')
    let scene: TuiScene = sceneForWorld(undefined, view, 0, { mascot: true, reducedMotion: false })
    const seen = new Set<string>()
    for (let t = 0; t <= 30 * 60_000; t += 1000) {
      const stepped = sceneAtFrame(scene, t, false)
      scene = stepped.scene
      const morty = stepped.morty as TuiMorty
      seen.add(morty.activity)
      expect(Object.keys(MORTY_WORDS)).toContain(morty.activity)
      const frame = frameOf(view, morty)
      const line = frame.meta.office?.mortyLine
      expect(line, `at ${t} ms`).toBeDefined()
      expect(stripSgr(frame.lines[line as number] as string)).toContain(MORTY_WORDS[morty.activity])
    }
    console.log(`Morty's activities in 30 minutes: ${[...seen].join(', ')}`)
    expect(seen.size).toBeGreaterThanOrEqual(3)
  })
})

describe('reduced motion', () => {
  test('he sleeps in his basket for as long as it lasts, and the frames do not change', () => {
    const view = viewOf('mascot-play')
    let scene = sceneForWorld(undefined, view, 0, { mascot: true, reducedMotion: true })
    const first = sceneAtFrame(scene, 0, true)
    scene = first.scene
    expect(first.morty).toEqual({ activity: 'nap', walking: false, room: 'lobby' })
    const later = sceneAtFrame(scene, 30 * 60_000, true)
    expect(later.morty).toEqual(first.morty)
    const a = frameOf(view, sceneAtFrame(scene, 10_000, true).morty)
    const b = frameOf(view, sceneAtFrame(scene, 20_000, true).morty)
    expect(a.lines).toEqual(b.lines)
  })
})

describe('--no-mascot', () => {
  test('there is no Morty at any step and no word of his in the frame', () => {
    const view = viewOf('mascot-play')
    let scene = sceneForWorld(undefined, view, 0, { mascot: false, reducedMotion: false })
    expect(scene.mascot).toBeUndefined()
    for (let t = 0; t < 120_000; t += 5000) {
      const stepped = sceneAtFrame(scene, t, false)
      scene = stepped.scene
      expect(stepped.morty).toBeUndefined()
    }
    const text = frameOf(view, undefined).lines.map(stripSgr).join('\n')
    for (const word of Object.values(MORTY_WORDS)) expect(text).not.toContain(word)
  })
})

describe('seats', () => {
  test('stay put when another agent arrives', () => {
    const full = viewOf('rooms')
    const ids = Object.keys(full.agents)
    const without = ids[ids.length - 1] as string
    const smaller: World = { ...full, agents: Object.fromEntries(Object.entries(full.agents).filter(([id]) => id !== without)) }
    const one = sceneForWorld(undefined, smaller, 0, { mascot: true, reducedMotion: false })
    const two = sceneForWorld(one, full, 1000, { mascot: true, reducedMotion: false })
    for (const id of Object.keys(smaller.agents)) {
      expect(placementOf(two.layout, id)?.seat, id).toEqual(placementOf(one.layout, id)?.seat)
    }
    expect(placementOf(two.layout, without)).toBeDefined()
  })

  test('a scene with no previous one starts fresh', () => {
    const view = viewOf('rooms')
    const a = sceneForWorld(undefined, view, 0, { mascot: true, reducedMotion: false })
    const b = sceneForWorld(undefined, view, 0, { mascot: true, reducedMotion: false })
    expect(a.mascot).toEqual(b.mascot)
    expect(a.seeded).toBe(true)
  })
})
