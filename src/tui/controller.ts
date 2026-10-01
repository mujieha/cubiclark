// The terminal's state between frames (cubiclark-tui): the UI state (focus, selection, office on/off,
// log scroll), the scene (seats and Morty), and what the last frame said about itself, which is what
// the next key needs. A stream of Worlds and a clock go in, frames come out; keys change the UI state
// through the pure reducer. No I/O, so the loop around it is the only thing left to fake.

import { sceneAtFrame, sceneForWorld, type TuiScene } from '../core/tui/scene.js'
import { renderTui, type TuiFrame, type TuiSize } from '../core/tui/render.js'
import { INITIAL_UI, reconcileUi, reduceKey, type TuiKey, type TuiUi } from '../core/tui/ui.js'
import type { World } from '../core/types.js'
import { emptyScreen } from '../core/view.js'
import { visibleAgents, withVisibleAgents } from '../core/visible.js'

export interface ControllerOptions {
  idleDesks?: number
  /** Morty is in the office (off with `--no-mascot`). */
  mascot: boolean
  /** Off: Morty sleeps in his basket and the typing letters stay still. */
  animate: boolean
  color: boolean
  unicode: boolean
}

const NO_META: TuiFrame['meta'] = {
  visible: 0,
  focus: 'list',
  listOrder: [],
  officeOrder: [],
  listTop: 0,
  listRows: 0,
  logRows: 0,
  logPage: 0,
  animated: false,
}

export class TuiController {
  private ui: TuiUi = INITIAL_UI
  private scene: TuiScene | undefined
  private lastWorld: World | undefined
  private meta: TuiFrame['meta'] = NO_META

  constructor(private readonly options: ControllerOptions) {}

  /** The UI state as it is now. */
  get state(): TuiUi {
    return this.ui
  }

  /** Something on the last frame changes with the clock: ask for another soon. */
  get animated(): boolean {
    return this.meta.animated
  }

  /** The frame for `world` at the animation clock `animMs` (any steadily increasing millisecond clock). */
  frame(world: World, size: TuiSize, animMs: number): TuiFrame {
    const nowMs = Date.parse(world.clock)
    if (world !== this.lastWorld) {
      this.lastWorld = world
      const visible = visibleAgents(world, nowMs, { idleDesks: this.options.idleDesks })
      const view = withVisibleAgents(world, visible)
      // An empty screen has no office and so no Morty; when agents come back he starts his day again.
      this.scene = emptyScreen(view) === null ? sceneForWorld(this.scene, view, animMs, { mascot: this.options.mascot, reducedMotion: !this.options.animate }) : undefined
      this.ui = reconcileUi(this.ui, visible.ids, true)
    }
    let morty
    if (this.scene) {
      const stepped = sceneAtFrame(this.scene, animMs, !this.options.animate)
      this.scene = stepped.scene
      morty = stepped.morty
    }
    const frame = renderTui(world, size, nowMs, {
      ui: this.ui,
      color: this.options.color,
      unicode: this.options.unicode,
      animate: this.options.animate,
      animationMs: animMs,
      idleDesks: this.options.idleDesks,
      layout: this.scene?.layout,
      morty,
    })
    this.meta = frame.meta
    this.ui = reconcileUi(this.ui, new Set(frame.meta.listOrder), frame.meta.office !== undefined)
    return frame
  }

  /** A key. True means quit. */
  key(key: TuiKey): boolean {
    const { ui, quit } = reduceKey(this.ui, key, {
      officeOrder: this.meta.officeOrder,
      listOrder: this.meta.listOrder,
      officeShown: this.meta.office !== undefined,
      logRows: this.meta.logRows,
      logPage: this.meta.logPage,
      listPage: Math.max(1, this.meta.listRows - 1),
    })
    this.ui = ui
    return quit
  }
}
