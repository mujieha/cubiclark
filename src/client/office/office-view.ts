// The office as the page uses it: a World goes in, a canvas and its frame loop come out. Owns the
// previous layout (so seats stay put), the actors (who is walking where), reduced motion, the
// size of the canvas and the numbers the tests read from the canvas's data-* attributes.

import { layout as computeLayout, type OfficeLayout } from '../../core/office/layout.js'
import { reconcileActors, type Actor } from '../../core/office/motion.js'
import { buildTileMap } from '../../core/office/tilemap.js'
import { EMPTY_SCENES, type EmptySceneId } from '../../core/office/visual.js'
import type { Task, World } from '../../core/types.js'
import { emptyWorld } from '../../core/world.js'
import { FrameLoop, browserHost, type LoopHost } from './loop.js'
import { OfficeOverlay } from './overlay.js'
import { OfficeRenderer, type Scene } from './renderer.js'

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

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const STATS_EVERY_MS = 1000

export class OfficeView {
  /** Exactly as big as the canvas: where the overlay of accessible buttons is placed. */
  readonly stage: HTMLDivElement
  readonly canvas: HTMLCanvasElement
  private readonly renderer: OfficeRenderer
  private readonly overlay: OfficeOverlay
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

  constructor(
    private readonly container: HTMLElement,
    private readonly env: OfficeEnv,
    private readonly handlers: { onSelect?: (agentId: string) => void } = {}
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
    this.renderer = new OfficeRenderer(this.canvas)
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
    this.overlay.destroy()
    this.reducedQuery.removeEventListener('change', this.onReducedChange)
  }

  private resize(): void {
    const before = this.renderer.scale
    this.renderer.resize(this.container.clientWidth, this.env.devicePixelRatio())
    this.canvas.dataset.scale = String(this.renderer.scale)
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
    }
    // A world still "starting" is not a first snapshot: the agents that appear a moment later are
    // already there, not arriving.
    if (this.world && this.world.sources.transcripts.status !== 'starting') this.seeded = true

    this.renderer.setScene(scene)
    if (this.empty) this.overlay.clear()
    else this.overlay.update(world, scene.layout, this.renderer.scale)
    this.canvas.dataset.rows = String(scene.layout.rows)
    this.canvas.dataset.scene = this.empty ?? 'office'
    this.loop.requestDraw()
  }

  private drawFrame(): void {
    const nowMs = this.env.now()
    const stats = this.renderer.draw(nowMs, this.focusedId ?? this.selectedId)
    this.overlay.syncWalkers(stats.walkers)
    this.drawnAgents = stats.drawn
    this.canvas.dataset.frames = String(this.loop.frames + 1)
    this.canvas.dataset.actors = String(this.drawnAgents)
    if (nowMs - this.statsAtMs >= STATS_EVERY_MS) {
      this.statsAtMs = nowMs
      this.canvas.dataset.fps = String(this.loop.fps())
      this.canvas.dataset.drawP95 = this.loop.drawP95().toFixed(2)
    }
  }
}
