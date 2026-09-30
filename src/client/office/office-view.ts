// The office as the page uses it: a World goes in, a canvas and its frame loop come out. Owns the
// previous layout (so seats stay put), the actors (who is walking where), reduced motion, the
// size of the canvas and the numbers the tests read from the canvas's data-* attributes.

import { layout as computeLayout, type OfficeLayout } from '../../core/office/layout.js'
import { advanceMascot, initialMascot, mascotPose, mascotSeed, type MascotInput, type MascotPose, type MascotState } from '../../core/office/mascot.js'
import { mascotGrid } from '../../core/office/mascot-map.js'
import { reconcileActors, type Actor } from '../../core/office/motion.js'
import { buildTileMap } from '../../core/office/tilemap.js'
import { EMPTY_SCENES, type EmptySceneId } from '../../core/office/visual.js'
import type { Task, World } from '../../core/types.js'
import { emptyWorld } from '../../core/world.js'
import { FrameLoop, browserHost, type LoopHost } from './loop.js'
import { MascotMarker } from './mascot-marker.js'
import { OfficeOverlay } from './overlay.js'
import { BUILT_IN_ART } from './art/art-set.js'
import { OfficeRenderer, type Look, type Scene } from './renderer.js'
import { DAY } from '../../core/theme/day.js'

/** The day theme with the built-in art: what the office is drawn in until a theme is chosen. */
export const DEFAULT_LOOK: Look = { palette: DAY.palette, ring: DAY.ring, art: BUILT_IN_ART, mascot: { ...DAY.palette, ...DAY.mascot } }

export interface OfficeEnv {
  host: LoopHost
  matchMedia: (query: string) => MediaQueryList
  devicePixelRatio: () => number
  /** The clock animation runs on: performance.now() in a browser, and so on a faked page clock. */
  now: () => number
}

export function browserEnv(): OfficeEnv {
  return {
    host: browserHost(),
    matchMedia: (query) => window.matchMedia(query),
    devicePixelRatio: () => window.devicePixelRatio,
    now: () => performance.now(),
  }
}

const NO_ARRIVALS: readonly string[] = []
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const STATS_EVERY_MS = 1000

export class OfficeView {
  /** Exactly as big as the canvas: where the overlay of accessible buttons is placed. */
  readonly stage: HTMLDivElement
  readonly canvas: HTMLCanvasElement
  private readonly renderer: OfficeRenderer
  private readonly overlay: OfficeOverlay
  /** Made when Morty is first drawn: with him off the page holds nothing of his, not even a hidden box. */
  private marker: MascotMarker | undefined
  private readonly loop: FrameLoop
  private readonly reducedQuery: MediaQueryList
  private readonly observer: ResizeObserver | undefined
  private readonly onReducedChange: () => void
  private previousLayout: OfficeLayout | undefined
  private actors = new Map<string, Actor>()
  private world: World | undefined
  private empty: EmptySceneId | null = null
  private seeded = false
  private reduced: boolean
  private focusedId: string | undefined
  private selectedId: string | undefined
  private task: Task | undefined
  private drawnAgents = 0
  private statsAtMs = Number.NEGATIVE_INFINITY
  /** Morty: shown unless the page (or the server, with --no-mascot) has him off. */
  private mascotOn = true
  private mascot: MascotState | undefined
  /** What he needs to know between updates, from the last one: the World, its layout, grid and actors. */
  private mascotScene: Pick<MascotInput, 'world' | 'layout' | 'grid' | 'actors'> | undefined

  constructor(
    private readonly container: HTMLElement,
    private readonly env: OfficeEnv,
    private readonly handlers: { onSelect?: (agentId: string) => void } = {},
    look: Look = DEFAULT_LOOK
  ) {
    container.classList.add('office')
    this.stage = document.createElement('div')
    this.stage.className = 'office-stage'
    container.appendChild(this.stage)
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'office-canvas'
    // The overlay's buttons are the accessible picture of the office; the canvas is decoration.
    this.canvas.setAttribute('aria-hidden', 'true')
    this.stage.appendChild(this.canvas)
    this.renderer = new OfficeRenderer(this.canvas, look)
    this.overlay = new OfficeOverlay(this.stage, {
      onFocus: (agentId) => this.setFocused(agentId),
      onSelect: (agentId) => this.handlers.onSelect?.(agentId),
    })

    this.reducedQuery = env.matchMedia(REDUCED_MOTION)
    this.reduced = this.reducedQuery.matches
    this.loop = new FrameLoop(env.host, () => this.drawFrame())
    this.loop.setMode(this.reduced ? 'on-demand' : 'continuous')
    this.publishMode()

    this.onReducedChange = () => {
      this.reduced = this.reducedQuery.matches
      this.loop.setMode(this.reduced ? 'on-demand' : 'continuous')
      this.publishMode()
      this.apply()
    }
    this.reducedQuery.addEventListener('change', this.onReducedChange)

    this.resize()
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(container)
    }
    this.loop.start()
  }

  /** Shows a World, or one of the four empty scenes. */
  setWorld(world: World | undefined, empty: EmptySceneId | null): void {
    this.world = world
    this.empty = empty
    this.apply()
  }

  /** A new theme, or a custom pack: the office is drawn again in it. */
  setLook(look: Look): void {
    this.renderer.setLook(look)
    this.loop.requestDraw()
  }

  /** Morty on or off. Off, the office is drawn exactly as it was before he existed: no basket, no bowl. */
  setMascot(on: boolean): void {
    if (this.mascotOn === on) return
    this.mascotOn = on
    this.mascot = undefined
    this.mascotScene = undefined
    this.apply()
  }

  /** Shown while the list view is off: the loop runs only while the office is on screen. */
  setVisible(visible: boolean): void {
    if (visible) {
      this.loop.start()
      this.resize()
      this.loop.requestDraw()
    } else {
      this.loop.stop()
    }
  }

  /** The agent the keyboard focus is on, ringed on the canvas. */
  setFocused(agentId: string | undefined): void {
    this.focusedId = agentId
    this.loop.requestDraw()
  }

  /** The task the whiteboard shows. Takes effect with the next setWorld, which redraws the walls. */
  setSelectedTask(task: Task | undefined): void {
    this.task = task
  }

  /** The agent the page has selected (its card is in the HUD): ringed until the focus moves elsewhere. */
  setSelected(agentId: string | undefined): void {
    if (this.selectedId === agentId) return
    this.selectedId = agentId
    this.overlay.setSelected(agentId)
    this.loop.requestDraw()
  }

  get layout(): OfficeLayout | undefined {
    return this.previousLayout
  }

  get scale(): number {
    return this.renderer.scale
  }

  get reducedMotion(): boolean {
    return this.reduced
  }

  destroy(): void {
    this.loop.stop()
    this.observer?.disconnect()
    this.marker?.destroy()
    this.overlay.destroy()
    this.reducedQuery.removeEventListener('change', this.onReducedChange)
  }

  private resize(): void {
    const before = this.renderer.scale
    this.renderer.resize(this.container.clientWidth, this.env.devicePixelRatio())
    this.canvas.dataset.scale = String(this.renderer.scale)
    this.canvas.dataset.backing = String(this.renderer.density)
    if (this.renderer.scale !== before && this.previousLayout) this.overlay.setScale(this.renderer.scale, this.previousLayout.placements)
    this.loop.requestDraw()
  }

  private publishMode(): void {
    this.canvas.dataset.reducedMotion = String(this.reduced)
  }

  private apply(): void {
    const nowMs = this.env.now()
    const world = this.world ?? emptyWorld('', '')
    let scene: Scene

    if (this.empty) {
      // One of the four empty screens: the office with nobody in it, lit and doored to say which.
      const bare: World = { ...world, agents: {} }
      const officeLayout = computeLayout(bare)
      const doorOpen = EMPTY_SCENES[this.empty].door === 'open'
      scene = {
        world: bare,
        layout: officeLayout,
        tilemap: buildTileMap(officeLayout, { doorOpen }),
        actors: new Map(),
        reducedMotion: this.reduced,
        empty: this.empty,
      }
      this.actors = new Map()
      this.previousLayout = undefined
      // He is not in an empty office: the picture there says why it is empty.
      this.mascot = undefined
      this.mascotScene = undefined
    } else {
      const officeLayout = computeLayout(world, this.previousLayout)
      this.actors = reconcileActors(this.actors, this.previousLayout, officeLayout, {
        nowMs,
        reducedMotion: this.reduced,
        firstSnapshot: !this.seeded,
      })
      this.previousLayout = officeLayout
      scene = {
        world,
        layout: officeLayout,
        tilemap: buildTileMap(officeLayout, { quota: world.quota !== undefined }),
        actors: this.actors,
        reducedMotion: this.reduced,
        ...(this.task ? { task: this.task } : {}),
      }
      if (this.mascotOn) {
        // Everyone who started walking in from the door at this very update: Morty goes to say hello.
        const arrivals = [...this.actors.values()].filter((actor) => actor.phase === 'arriving' && actor.startMs === nowMs).map((actor) => actor.agentId)
        const grid = mascotGrid(world, officeLayout, scene.tilemap)
        this.mascotScene = { world, layout: officeLayout, grid: this.mascotScene?.grid.key === grid.key ? this.mascotScene.grid : grid, actors: this.actors }
        const input: MascotInput = { ...this.mascotScene, nowMs, reducedMotion: this.reduced, arrivals }
        this.mascot = this.mascot ? advanceMascot(this.mascot, input) : initialMascot(mascotSeed(world.clock), input)
        scene.mascot = this.mascotScene.grid.spots
      } else {
        this.mascot = undefined
        this.mascotScene = undefined
      }
    }
    // A world still "starting" is not a first snapshot: the agents that appear a moment later are
    // already there, not arriving.
    if (this.world && this.world.sources.transcripts.status !== 'starting') this.seeded = true

    this.renderer.setScene(scene)
    // A taller office may need a lower density (geometry.ts backingScale): said here for the tests.
    this.canvas.dataset.backing = String(this.renderer.density)
    if (this.empty) this.overlay.clear()
    else this.overlay.update(world, scene.layout, this.renderer.scale)
    this.canvas.dataset.rows = String(scene.layout.rows)
    this.canvas.dataset.scene = this.empty ?? 'office'
    this.loop.requestDraw()
  }

  private drawFrame(): void {
    const nowMs = this.env.now()
    let pose: MascotPose | undefined
    if (this.mascot && this.mascotScene) {
      this.mascot = advanceMascot(this.mascot, { ...this.mascotScene, nowMs, reducedMotion: this.reduced, arrivals: NO_ARRIVALS })
      pose = mascotPose(this.mascot, nowMs)
    }
    const stats = this.renderer.draw(nowMs, this.focusedId ?? this.selectedId, pose)
    this.overlay.syncWalkers(stats.walkers)
    if (pose) {
      // In front of the overlay in the page, so the agents' buttons are over his marker, never under it.
      this.marker ??= new MascotMarker(this.stage, this.stage.querySelector('.office-overlay'))
      this.marker.show({ x: pose.point.x - 8, y: pose.point.y - 4, w: 16, h: 12 }, this.renderer.scale)
    } else {
      this.marker?.show(undefined, this.renderer.scale)
    }
    this.drawnAgents = stats.drawn
    this.canvas.dataset.frames = String(this.loop.frames + 1)
    // Morty is not an agent: `actors` never counts him. What he is doing is published for the tests.
    this.canvas.dataset.actors = String(this.drawnAgents)
    this.canvas.dataset.mascot = pose?.activity ?? 'off'
    this.canvas.dataset.mascotPhase = pose ? (pose.walking ? 'walk' : 'stay') : 'off'
    this.canvas.dataset.mascotWith = pose?.withId ?? ''
    if (nowMs - this.statsAtMs >= STATS_EVERY_MS) {
      this.statsAtMs = nowMs
      this.canvas.dataset.fps = String(this.loop.fps())
      this.canvas.dataset.drawP95 = this.loop.drawP95().toFixed(2)
    }
  }
}
