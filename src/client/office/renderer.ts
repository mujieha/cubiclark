// Draws the office on a canvas (PLAN.md phase 3 §2.8). The static picture (floors, walls, desks,
// room names, signs) is baked once per world update into an offscreen canvas at 1x; each frame
// blits it and then draws the moving parts: characters, lamps, monitors, bubbles, board tags.
// Every coordinate is in logical px and every draw lands on a whole px, under a transform that
// scales by a whole number, so pixels stay crisp. All text goes through fillText, never markup.

import { TILE, type Point, type Rect } from '../../core/office/geometry.js'
import type { OfficeLayout, Placement } from '../../core/office/layout.js'
import { positionAt, type Actor } from '../../core/office/motion.js'
import { accessoryFor, effectiveRole, modelFamily } from '../../core/office/roles.js'
import { deskObjects, type TileId, type TileMap } from '../../core/office/tilemap.js'
import { whiteboardModel } from '../../core/office/whiteboard.js'
import {
  EMPTY_SCENES,
  STATE_VISUALS,
  frameAt,
  lampFor,
  resolveBubble,
  type Direction,
  type EmptySceneId,
  type FrameRef,
  type ResolvedBubble,
} from '../../core/office/visual.js'
import type { Agent, Task, World } from '../../core/types.js'
import { ACCESSORIES } from './art/accessories.js'
import { CHARACTER_FRAMES } from './art/characters.js'
import { ICONS, TAGS } from './art/icons.js'
import { PROPS, TILES } from './art/tiles.js'
import { SpriteCache } from './bake.js'
import { PALETTE, shirtKey, variantFor, type Variant } from './palette.js'
import { rotate90, type SpriteDef } from './sprite.js'

export interface Scene {
  world: World
  layout: OfficeLayout
  tilemap: TileMap
  actors: ReadonlyMap<string, Actor>
  reducedMotion: boolean
  /** When set, this is one of the four empty screens: the office is drawn empty, in that scene. */
  empty?: EmptySceneId
  /** The task the whiteboard shows (chosen in the HUD, or the selected agent's). */
  task?: Task
}

export interface DrawStats {
  /** Agents drawn this frame, as a character or a board tag. */
  drawn: number
  /** Agents drawn walking this frame, with the px box they are in: their overlay buttons follow them. */
  walkers: { agentId: string; box: Rect }[]
}

const MAX_SCALE = 4
const FONT = "6px ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
const SIGN_FONT = "bold 7px ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
const ACCENT = '#6fd6a8'
const BUBBLE_H = 13
const PULSE_MS = 350

const colour = (key: string): string => PALETTE[key] as string

/** The ink, accent, fill and edge a bubble style is drawn in. */
const BUBBLE_STYLES = {
  plain: { fill: '1', edge: '0', ink: '0', accent: 'd', text: '0' },
  alert: { fill: 'a', edge: '0', ink: '1', accent: '1', text: '1' },
  muted: { fill: '2', edge: '3', ink: '3', accent: '2', text: '3' },
} as const

export class OfficeRenderer {
  private readonly cache = new SpriteCache()
  private readonly context: CanvasRenderingContext2D
  private staticLayer: HTMLCanvasElement | undefined
  private scene: Scene | undefined
  private cssScale = 1
  private backing = 1
  private arrows: Record<Direction, SpriteDef> | undefined

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas is not available')
    this.context = context
  }

  get scale(): number {
    return this.cssScale
  }

  /** The largest whole-number scale that fits `containerWidthCss`, and the backing-store density. */
  resize(containerWidthCss: number, devicePixelRatio: number): void {
    const cols = this.scene?.layout.cols ?? 36
    this.cssScale = Math.min(MAX_SCALE, Math.max(1, Math.floor(containerWidthCss / (cols * TILE))))
    this.backing = this.cssScale * Math.max(1, Math.round(devicePixelRatio))
    this.applySize()
  }

  private applySize(): void {
    const layout = this.scene?.layout
    const cols = layout?.cols ?? 36
    const rows = layout?.rows ?? 20
    this.canvas.width = cols * TILE * this.backing
    this.canvas.height = rows * TILE * this.backing
    this.canvas.style.width = `${cols * TILE * this.cssScale}px`
    this.canvas.style.height = `${rows * TILE * this.cssScale}px`
  }

  setScene(scene: Scene): void {
    const sizeChanged = !this.scene || this.scene.layout.rows !== scene.layout.rows || this.scene.layout.cols !== scene.layout.cols
    this.scene = scene
    if (sizeChanged) this.applySize()
    this.staticLayer = this.bakeStatic(scene)
  }

  // --- The static layer ---------------------------------------------------------------------

  private tileCanvas(id: TileId, variant: Variant): HTMLCanvasElement {
    return this.cache.get(`tile:${id}`, TILES[id], {}, variant)
  }

  private bakeStatic(scene: Scene): HTMLCanvasElement {
    const { layout, tilemap, world } = scene
    const variant: Variant = scene.empty && EMPTY_SCENES[scene.empty].lights === 'off' ? 'dark' : 'normal'
    const layer = document.createElement('canvas')
    layer.width = tilemap.cols * TILE
    layer.height = tilemap.rows * TILE
    const ctx = layer.getContext('2d')
    if (!ctx) throw new Error('2D canvas is not available')
    ctx.imageSmoothingEnabled = false

    tilemap.floor.forEach((id, index) => {
      ctx.drawImage(this.tileCanvas(id, variant), (index % tilemap.cols) * TILE, Math.floor(index / tilemap.cols) * TILE)
    })
    for (const object of tilemap.objects) ctx.drawImage(this.tileCanvas(object.tile, variant), object.x * TILE, object.y * TILE)

    ctx.textBaseline = 'middle'
    ctx.fillStyle = colour(variant === 'dark' ? '2' : '1')
    ctx.font = SIGN_FONT
    for (const room of layout.rooms) {
      if (room.id === 'manager' || room.id === 'planning' || room.id === 'review') {
        ctx.fillText(room.name, room.rect.x * TILE + 4, TILE + 8, room.rect.w * TILE - 8)
      }
    }
    for (const cluster of layout.clusters) {
      ctx.fillText(cluster.project, cluster.signRect.x * TILE + 4, cluster.signRect.y * TILE + 8, cluster.signRect.w * TILE - 8)
    }
    if (world.quota) this.drawMeter(ctx, layout, world)
    if (scene.task && !scene.empty) this.drawWhiteboard(ctx, layout, scene.task)
    if (scene.empty) this.drawEmptyProps(ctx, layout, scene.empty, variant)
    return layer
  }

  /** The whiteboard (two tiles wide, in the planning room): the task's short id, its four stages
   * (past filled, current filled with a mark above it, future hollow, blocked red with a cross) and
   * a dot for each change of model. The interior is 30 px wide and rows 2 to 11 of the tiles: the
   * label sits on row 7, the stage boxes on rows 9 to 11, the dots at the top right. */
  private drawWhiteboard(ctx: CanvasRenderingContext2D, layout: OfficeLayout, task: Task): void {
    const planning = layout.rooms.find((room) => room.id === 'planning')
    const model = whiteboardModel(task)
    if (!planning || !model) return
    const x = (planning.rect.x + 4) * TILE
    const y = TILE
    ctx.fillStyle = colour('0')
    ctx.font = FONT
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(model.label, x + 2, y + 7, 20)

    model.stages.forEach((state, index) => {
      const bx = x + 2 + index * 7
      const by = y + 9
      if (state === 'future') {
        ctx.fillStyle = colour('2')
        ctx.fillRect(bx, by, 5, 1)
        ctx.fillRect(bx, by + 2, 5, 1)
        ctx.fillRect(bx, by + 1, 1, 1)
        ctx.fillRect(bx + 4, by + 1, 1, 1)
        return
      }
      ctx.fillStyle = colour(state === 'past' ? 'c' : state === 'current' ? 'b' : 'a')
      ctx.fillRect(bx, by, 5, 3)
      ctx.fillStyle = colour('0')
      if (state === 'current') ctx.fillRect(bx + 1, by - 1, 3, 1)
      if (state === 'blocked') {
        ctx.fillRect(bx, by, 1, 1)
        ctx.fillRect(bx + 4, by, 1, 1)
        ctx.fillRect(bx + 2, by + 1, 1, 1)
        ctx.fillRect(bx, by + 2, 1, 1)
        ctx.fillRect(bx + 4, by + 2, 1, 1)
      }
    })

    ctx.fillStyle = colour('e')
    for (let dot = 0; dot < model.modelChanges; dot++) ctx.fillRect(x + 23 + dot * 2, y + 3, 1, 1)
  }

  /** The wall meter: a bar for the 5-hour window over one for the 7-day window, each green, amber
   * from 70% and red from 90%; the frame is ringed red while any agent is rate limited. */
  private drawMeter(ctx: CanvasRenderingContext2D, layout: OfficeLayout, world: World): void {
    const manager = layout.rooms.find((room) => room.id === 'manager')
    if (!manager || !world.quota) return
    const x = (manager.rect.x + 7) * TILE
    const y = TILE + 2
    const limited = Object.values(world.agents).some((agent) => agent.state === 'rate_limited')
    const bar = (percent: number, top: number, height: number): void => {
      const fraction = Math.max(0, Math.min(1, percent / 100))
      ctx.fillStyle = colour(fraction >= 0.9 ? 'a' : fraction >= 0.7 ? 'b' : 'c')
      ctx.fillRect(x + 2, y + top, fraction > 0 ? Math.max(1, Math.round(12 * fraction)) : 0, height)
    }
    bar(world.quota.p5h, 2, 3)
    bar(world.quota.p7d, 6, 2)
    if (limited) {
      ctx.strokeStyle = colour('a')
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, 15, 11)
    }
  }

  private drawEmptyProps(ctx: CanvasRenderingContext2D, layout: OfficeLayout, id: EmptySceneId, variant: Variant): void {
    const prop = EMPTY_SCENES[id].prop
    const floor = layout.rooms.find((room) => room.id === 'floor')
    const manager = layout.rooms.find((room) => room.id === 'manager')
    if (!prop || !floor || !manager) return
    // Twice their size: an empty office has nothing else to look at, so its one prop has to say why.
    const draw = (def: SpriteDef, key: string, x: number, y: number): void =>
      ctx.drawImage(this.cache.get(key, def, {}, variant), x, y, def.w * 2, def.h * 2)
    if (prop === 'clock') draw(PROPS.wall_clock, 'prop:wall_clock', (manager.rect.x + 6) * TILE, TILE + 6)
    if (prop === 'plug') draw(PROPS.sign_unplugged, 'prop:sign_unplugged', (floor.rect.x + 12) * TILE, (floor.rect.y + 1) * TILE + 8)
    if (prop === 'cabinet') draw(PROPS.cabinet_locked, 'prop:cabinet_locked', (floor.rect.x + 12) * TILE, (floor.rect.y + 1) * TILE)
  }

  // --- Each frame ---------------------------------------------------------------------------

  draw(nowMs: number, focusedId?: string): DrawStats {
    const ctx = this.context
    ctx.setTransform(this.backing, 0, 0, this.backing, 0, 0)
    ctx.imageSmoothingEnabled = false
    const stats: DrawStats = { drawn: 0, walkers: [] }
    if (!this.scene || !this.staticLayer) return stats
    ctx.drawImage(this.staticLayer, 0, 0)
    const scene = this.scene
    if (scene.empty) return stats

    // Desks whose owner has left, drawn empty until the clear delay is up.
    for (const actor of scene.actors.values()) {
      if (actor.vacatedDesk && actor.vacatedDesk.untilMs > nowMs) this.drawTiles(ctx, deskObjects(actor.vacatedDesk.rect))
    }

    interface Item {
      sortY: number
      draw: () => void
    }
    const items: Item[] = []
    const bubbles: (() => void)[] = []
    for (const placement of scene.layout.placements) {
      const agent = scene.world.agents[placement.agentId]
      const actor = scene.actors.get(placement.agentId)
      if (!agent || !actor) continue
      const where = positionAt(actor, scene.layout, nowMs)
      const onBoard = actor.phase === 'departed' || (actor.phase === 'leaving' && !where.walking)
      stats.drawn++
      if (onBoard) {
        items.push({ sortY: placement.seat.y, draw: () => this.drawTag(ctx, agent, placement) })
      } else if (where.walking) {
        stats.walkers.push({ agentId: agent.id, box: { x: where.point.x - 8, y: where.point.y - 24, w: 16, h: 24 } })
        items.push({ sortY: where.point.y, draw: () => this.drawWalker(ctx, agent, where.point, where.facing, nowMs) })
      } else {
        items.push({ sortY: placement.seat.y, draw: () => this.drawSeated(ctx, agent, placement, nowMs) })
        const bubble = resolveBubble(agent, scene.world, scene.layout, scene.reducedMotion)
        if (bubble) bubbles.push(() => this.drawBubble(ctx, placement, bubble, nowMs))
      }
    }
    items.sort((a, b) => a.sortY - b.sortY)
    for (const item of items) item.draw()
    for (const draw of bubbles) draw()

    if (focusedId) {
      const focused = scene.layout.placements.find((placement) => placement.agentId === focusedId)
      if (focused) this.drawRing(ctx, focused.boxPx)
    }
    return stats
  }

  private drawTiles(ctx: CanvasRenderingContext2D, objects: readonly { x: number; y: number; tile: TileId }[]): void {
    for (const object of objects) ctx.drawImage(this.tileCanvas(object.tile, 'normal'), object.x * TILE, object.y * TILE)
  }

  private characterFrame(agent: Agent, frame: FrameRef, dim: boolean): HTMLCanvasElement {
    const { K, H } = variantFor(agent.id)
    const def = CHARACTER_FRAMES[frame.name] as SpriteDef
    return this.cache.get(`frame:${frame.name}`, def, { S: shirtKey(modelFamily(agent.model)), K, H }, dim ? 'dim' : 'normal')
  }

  /** A character with the accessory of its effective role, top-left at (x, y); a mirrored frame
   * flips both together. */
  private drawCharacter(ctx: CanvasRenderingContext2D, agent: Agent, frame: FrameRef, x: number, y: number, dim: boolean): void {
    const def = CHARACTER_FRAMES[frame.name] as SpriteDef
    ctx.save()
    if (frame.mirror) {
      ctx.translate(x + def.w, y)
      ctx.scale(-1, 1)
    } else {
      ctx.translate(x, y)
    }
    ctx.drawImage(this.characterFrame(agent, frame, dim), 0, 0)
    const accessory = accessoryFor(effectiveRole(agent, (this.scene as Scene).world))
    if (accessory !== 'none') {
      const art = ACCESSORIES[accessory]
      const anchor = def.anchors?.[art.anchor]
      if (anchor) {
        ctx.drawImage(this.cache.get(`acc:${accessory}`, art.sprite, {}, dim ? 'dim' : 'normal'), anchor.x + art.dx, anchor.y + art.dy)
      }
    }
    ctx.restore()
  }

  private drawSeated(ctx: CanvasRenderingContext2D, agent: Agent, placement: Placement, nowMs: number): void {
    const scene = this.scene as Scene
    const visual = STATE_VISUALS[agent.state]
    const frame = frameAt(visual.pose, nowMs, scene.reducedMotion)
    this.drawCharacterAt(ctx, agent, placement, frame, visual.dim, nowMs)
  }

  private drawCharacterAt(ctx: CanvasRenderingContext2D, agent: Agent, placement: Placement, frame: FrameRef, dim: boolean, nowMs: number): void {
    const scene = this.scene as Scene
    const x = placement.seat.x - 8
    const y = placement.seat.y - 24 + frame.dy
    this.drawCharacter(ctx, agent, frame, x, y, dim)
    if (placement.kind !== 'desk') return
    // The desk goes over the character, whose legs reach into the desk row when standing.
    const desk = scene.layout.desks.find((d) => d.id === placement.deskId)
    if (desk) this.drawDeskFront(ctx, desk.rect, agent, nowMs)
  }

  /** The desk in front of the character, with the monitor and the lamp on top. */
  private drawDeskFront(ctx: CanvasRenderingContext2D, cell: Rect, agent: Agent, nowMs: number): void {
    const scene = this.scene as Scene
    this.drawTiles(ctx, deskObjects(cell).slice(1))
    const visual = STATE_VISUALS[agent.state]
    const screen = visual.screen === 'flicker' && scene.reducedMotion ? 'on' : visual.screen
    const monitor =
      screen === 'off'
        ? PROPS.monitor_off
        : screen === 'error'
          ? PROPS.monitor_error
          : screen === 'on'
            ? PROPS.monitor_on
            : Math.floor(nowMs / 100) % 2 === 0
              ? PROPS.monitor_flicker
              : PROPS.monitor_on
    const lamp = lampFor(agent)
    const lampSprite = lamp === 'red' ? PROPS.lamp_red : lamp === 'amber' ? PROPS.lamp_amber : PROPS.lamp_off
    const top = (cell.y + 2) * TILE
    ctx.drawImage(this.cache.get(`prop:monitor:${screen}:${screen === 'flicker' ? Math.floor(nowMs / 100) % 2 : 0}`, monitor), cell.x * TILE + 4, top - 3)
    ctx.drawImage(this.cache.get(`prop:lamp:${lamp}`, lampSprite), (cell.x + 2) * TILE + 5, top - 3)
  }

  private drawWalker(ctx: CanvasRenderingContext2D, agent: Agent, point: Point, facing: Direction, nowMs: number): void {
    const step = Math.floor(nowMs / 200) % 2 === 0 ? 'a' : 'b'
    const name = facing === 'up' ? `walk_up_${step}` : facing === 'down' ? `walk_down_${step}` : `walk_side_${step}`
    const frame: FrameRef = { name, dy: 0, mirror: facing === 'left' }
    this.drawCharacter(ctx, agent, frame, point.x - 8, point.y - 24, false)
  }

  private drawTag(ctx: CanvasRenderingContext2D, agent: Agent, placement: Placement): void {
    const tag = STATE_VISUALS[agent.state].tag
    if (!tag) return
    ctx.drawImage(this.cache.get(`tag:${tag}`, TAGS[tag]), placement.seat.x - 7, placement.seat.y - 8)
    ctx.fillStyle = colour(shirtKey(modelFamily(agent.model)))
    ctx.fillRect(placement.seat.x - 5, placement.seat.y + 6, 10, 2)
  }

  private arrowSprite(direction: Direction): SpriteDef {
    if (!this.arrows) {
      const down = rotate90(ICONS.arrow)
      const left = rotate90(down)
      this.arrows = { right: ICONS.arrow, down, left, up: rotate90(left) }
    }
    return this.arrows[direction]
  }

  private drawBubble(ctx: CanvasRenderingContext2D, placement: Placement, bubble: ResolvedBubble, nowMs: number): void {
    const scene = this.scene as Scene
    const style = BUBBLE_STYLES[bubble.style]
    const withText = placement.kind === 'desk' && bubble.text !== undefined
    ctx.font = FONT
    const textWidth = withText ? Math.ceil(ctx.measureText(bubble.text as string).width) : 0
    const width = 4 + 9 + (withText ? 3 + textWidth : 0) + 4
    const headX = placement.seat.x
    const left = placement.kind === 'desk' ? placement.boxPx.x + 2 : headX - Math.floor(width / 2)
    const x = Math.max(0, Math.min(scene.layout.cols * TILE - width, left))
    const y = placement.kind === 'desk' ? placement.boxPx.y + 1 : placement.boxPx.y - BUBBLE_H - 2
    const dimmed = bubble.pulse && Math.floor(nowMs / PULSE_MS) % 2 === 1

    ctx.save()
    ctx.globalAlpha = dimmed ? 0.55 : 1
    const rect = (rx: number, ry: number, rw: number, rh: number, key: string): void => {
      ctx.fillStyle = colour(key)
      ctx.fillRect(rx, ry, rw, rh)
    }
    rect(x + 1, y, width - 2, BUBBLE_H, style.fill)
    rect(x, y + 1, width, BUBBLE_H - 2, style.fill)
    const edge = (rx: number, ry: number, rw: number, rh: number): void => {
      if (bubble.style !== 'muted') return rect(rx, ry, rw, rh, style.edge)
      // A muted bubble has a dashed edge: every other pixel.
      for (let i = 0; i < Math.max(rw, rh); i++) if (i % 2 === 0) rect(rx + (rw > rh ? i : 0), ry + (rh > rw ? i : 0), 1, 1, style.edge)
    }
    edge(x + 1, y, width - 2, 1)
    edge(x + 1, y + BUBBLE_H - 1, width - 2, 1)
    edge(x, y + 1, 1, BUBBLE_H - 2)
    edge(x + width - 1, y + 1, 1, BUBBLE_H - 2)
    if (bubble.style === 'alert') {
      // The doubled outline: a paper-white ring just inside the dark one.
      rect(x + 2, y + 1, width - 4, 1, '1')
      rect(x + 2, y + BUBBLE_H - 2, width - 4, 1, '1')
      rect(x + 1, y + 2, 1, BUBBLE_H - 4, '1')
      rect(x + width - 2, y + 2, 1, BUBBLE_H - 4, '1')
    }
    const tailX = Math.max(x + 3, Math.min(x + width - 4, headX))
    rect(tailX - 1, y + BUBBLE_H, 3, 1, style.fill)
    rect(tailX, y + BUBBLE_H + 1, 1, 1, style.fill)
    rect(tailX - 2, y + BUBBLE_H, 1, 1, style.edge)
    rect(tailX + 2, y + BUBBLE_H, 1, 1, style.edge)
    rect(tailX - 1, y + BUBBLE_H + 1, 1, 1, style.edge)
    rect(tailX + 1, y + BUBBLE_H + 1, 1, 1, style.edge)
    rect(tailX, y + BUBBLE_H + 2, 1, 1, style.edge)

    const def = bubble.icon === 'arrow' ? this.arrowSprite(bubble.direction ?? 'right') : ICONS[bubble.icon]
    // The cache key already includes the ink and accent, so the same icon on another bubble is another canvas.
    ctx.drawImage(this.cache.get(`icon:${bubble.icon}:${bubble.direction ?? ''}`, def, { S: style.ink, K: style.accent }), x + 4, y + 2)
    if (withText) {
      ctx.fillStyle = colour(style.text)
      ctx.textBaseline = 'middle'
      ctx.fillText(bubble.text as string, x + 4 + 9 + 3, y + BUBBLE_H / 2 + 0.5)
    }
    ctx.restore()
  }

  private drawRing(ctx: CanvasRenderingContext2D, box: Rect): void {
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
  }
}
