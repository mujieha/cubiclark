// Morty's name, for the pointer and for a screen reader. The canvas is decoration (aria-hidden); an
// agent has a button over it. Morty is not an agent, so he gets no button and no Tab stop: one <div>
// with role "img" and a label, laid over his picture, and a small label that shows when the pointer
// is on him. It sits before the overlay of agent buttons in the page, so wherever he and an agent
// overlap, the agent is what the pointer finds. Text only, through textContent and attributes.

import type { Rect } from '../../core/office/geometry.js'
import { MASCOT_LABEL } from '../../core/office/mascot.js'

export class MascotMarker {
  private readonly marker: HTMLDivElement
  private readonly tip: HTMLDivElement
  private box: Rect | undefined
  private scale = 1
  private placedAt = ''
  private tipShown = false

  /** `stage` is the element the canvas is in; the marker goes in front of `before` (the overlay of
   * agent buttons), so that it is under them. */
  constructor(stage: HTMLElement, before: Element | null) {
    this.marker = document.createElement('div')
    this.marker.className = 'office-mascot'
    this.marker.setAttribute('role', 'img')
    this.marker.setAttribute('aria-label', MASCOT_LABEL)
    this.marker.hidden = true
    this.tip = document.createElement('div')
    this.tip.className = 'office-mascot-tip'
    this.tip.setAttribute('role', 'tooltip')
    this.tip.textContent = MASCOT_LABEL
    this.tip.hidden = true
    this.marker.addEventListener('pointerenter', () => this.showTip())
    this.marker.addEventListener('pointerleave', () => this.hideTip())
    stage.insertBefore(this.marker, before)
    stage.insertBefore(this.tip, before)
  }

  /** Puts the marker over `box` (px of the office) at `scale`, or hides it (and his label) when he is not shown. */
  show(box: Rect | undefined, scale: number): void {
    this.box = box
    this.scale = scale
    if (!box) {
      this.marker.hidden = true
      this.hideTip()
      this.placedAt = ''
      return
    }
    this.marker.hidden = false
    const at = `${box.x},${box.y},${box.w},${box.h},${scale}`
    if (at !== this.placedAt) {
      this.placedAt = at
      this.marker.style.transform = `translate(${box.x * scale}px, ${box.y * scale}px)`
      this.marker.style.width = `${box.w * scale}px`
      this.marker.style.height = `${box.h * scale}px`
      if (this.tipShown) this.placeTip()
    }
  }

  destroy(): void {
    this.marker.remove()
    this.tip.remove()
  }

  private showTip(): void {
    this.tipShown = true
    this.placeTip()
    this.tip.hidden = false
  }

  private hideTip(): void {
    this.tipShown = false
    this.tip.hidden = true
  }

  /** Under him, where the agents' label goes under an agent. */
  private placeTip(): void {
    if (!this.box) return
    this.tip.style.transform = `translate(${this.box.x * this.scale}px, ${(this.box.y + this.box.h) * this.scale + 4}px)`
  }
}
