// Turns a sprite into a canvas once and keeps it (design §7: "baked into offscreen canvases at
// load"). Characters are baked lazily per (frame, shirt, skin, hair, variant): a few dozen
// canvases for the largest office. The only file in the art path that touches the DOM. A cache is
// made for one palette: a new theme is a new cache.

import type { Palette, Subst, Variant } from './palette.js'
import { rasterize, type SpriteDef } from './sprite.js'

export class SpriteCache {
  private readonly canvases = new Map<string, HTMLCanvasElement>()

  constructor(private readonly palette: Palette) {}

  /** The baked canvas for `def`. `key` names the sprite (`frame:sit_type_a`); the substitution
   * and the variant are added to it, so the same sprite in another shirt is another canvas. */
  get(key: string, def: SpriteDef, subst: Subst = {}, variant: Variant = 'normal'): HTMLCanvasElement {
    const full = `${key}|${subst.S ?? ''}${subst.K ?? ''}${subst.H ?? ''}|${variant}`
    const cached = this.canvases.get(full)
    if (cached) return cached
    const canvas = document.createElement('canvas')
    canvas.width = def.w
    canvas.height = def.h
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas is not available')
    context.putImageData(new ImageData(rasterize(def, this.palette, subst, variant), def.w, def.h), 0, 0)
    this.canvases.set(full, canvas)
    return canvas
  }

  get size(): number {
    return this.canvases.size
  }
}
