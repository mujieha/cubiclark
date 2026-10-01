// Morty and the seats, for the terminal (cubiclark-tui): the page's own calls into layout() and the
// mascot machine (OfficeView.apply and drawFrame), without any drawing. Pure, like the rest of core/:
// the animation clock is passed in. In the terminal the agents do not walk; they are at their seats at
// once. The actors are kept only because Morty's machine reads them (it goes to greet an arrival).

import { layout as computeLayout, type OfficeLayout } from '../office/layout.js'
import { advanceMascot, initialMascot, mascotPose, mascotSeed, type MascotActivity, type MascotInput, type MascotState } from '../office/mascot.js'
import { mascotGrid, roomOf, tileOf } from '../office/mascot-map.js'
import { reconcileActors, type Actor } from '../office/motion.js'
import type { RoomId } from '../office/roles.js'
import { buildTileMap } from '../office/tilemap.js'
import type { World } from '../types.js'

/** Where Morty is and what he is doing, in the words the terminal can show. */
export interface TuiMorty {
  activity: MascotActivity
  walking: boolean
  /** The room his feet are in; `hall` is the gap between rooms, undefined when he is nowhere known. */
  room: RoomId | 'hall' | undefined
  /** The agent he is sitting by or playing with. */
  withId?: string
}

export interface TuiScene {
  layout: OfficeLayout
  actors: ReadonlyMap<string, Actor>
  /** The first World with agents in it has been seen: later arrivals walk in (and Morty greets them). */
  seeded: boolean
  mascot?: MascotState
  mascotScene?: Pick<MascotInput, 'world' | 'layout' | 'grid' | 'actors'>
}

export interface SceneOptions {
  /** Morty is in the office (off with `--no-mascot`). */
  mascot: boolean
  reducedMotion: boolean
}

/** The page's `apply` for a World that is not an empty screen: `view` is the World in view, `animMs` the animation clock. */
export function sceneForWorld(prev: TuiScene | undefined, view: World, animMs: number, opts: SceneOptions): TuiScene {
  const officeLayout = computeLayout(view, prev?.layout)
  const actors = reconcileActors(prev?.actors ?? new Map<string, Actor>(), prev?.layout, officeLayout, {
    nowMs: animMs,
    reducedMotion: opts.reducedMotion,
    firstSnapshot: !prev?.seeded,
  })
  // A World still "starting" is not a first snapshot: the agents that appear a moment later are already there.
  const seeded = (prev?.seeded ?? false) || view.sources.transcripts.status !== 'starting'
  const scene: TuiScene = { layout: officeLayout, actors, seeded }
  if (!opts.mascot) return scene

  const tilemap = buildTileMap(officeLayout, { quota: view.quota !== undefined })
  const grid = mascotGrid(view, officeLayout, tilemap)
  // Everyone who started walking in from the door at this very update: Morty goes to say hello.
  const arrivals = [...actors.values()].filter((actor) => actor.phase === 'arriving' && actor.startMs === animMs).map((actor) => actor.agentId)
  const mascotScene = { world: view, layout: officeLayout, grid: prev?.mascotScene?.grid.key === grid.key ? prev.mascotScene.grid : grid, actors }
  const input: MascotInput = { ...mascotScene, nowMs: animMs, reducedMotion: opts.reducedMotion, arrivals }
  return { ...scene, mascotScene, mascot: prev?.mascot ? advanceMascot(prev.mascot, input) : initialMascot(mascotSeed(view.clock), input) }
}

/** The page's `drawFrame` advance: Morty brought up to `animMs`, and where he is in words. */
export function sceneAtFrame(scene: TuiScene, animMs: number, reducedMotion: boolean): { scene: TuiScene; morty?: TuiMorty } {
  if (!scene.mascot || !scene.mascotScene) return { scene }
  const mascot = advanceMascot(scene.mascot, { ...scene.mascotScene, nowMs: animMs, reducedMotion, arrivals: [] })
  const pose = mascotPose(mascot, animMs)
  return {
    scene: { ...scene, mascot },
    morty: {
      activity: pose.activity,
      walking: pose.walking,
      room: roomOf(scene.layout, tileOf(pose.point)),
      ...(pose.withId === undefined ? {} : { withId: pose.withId }),
    },
  }
}
