// The office for everyone who cannot see the canvas, and for the mouse and the keyboard: one
// transparent <button> per agent over the canvas, in reading order, each labelled with the same
// words the list view uses. It carries hover (a tooltip), keyboard focus (Tab walks the agents),
// screen-reader labels and the data-* attributes the end-to-end tests compare with the list.
// Every string reaches the page through textContent or an attribute, never as markup.

import type { Rect } from '../../core/office/geometry.js'
import { ariaLabel, tooltipLines } from '../../core/office/labels.js'
import type { OfficeLayout, Placement } from '../../core/office/layout.js'
import type { World } from '../../core/types.js'

export interface OverlayHandlers {
  /** The agent the keyboard focus is on, or undefined when it left the office. */
  onFocus: (agentId: string | undefined) => void
  /** An agent was clicked (or activated from the keyboard): the page selects it. */
  onSelect?: (agentId: string) => void
}

export class OfficeOverlay {
  private readonly root: HTMLDivElement
  private readonly tooltip: HTMLDivElement
  private readonly buttons = new Map<string, HTMLButtonElement>()
  private readonly boxes = new Map<string, Rect>()
  private walking = new Set<string>()
  private world: World | undefined
  private scale = 1
  private tooltipFor: string | undefined
  private selectedId: string | undefined

  constructor(
    stage: HTMLElement,
    private readonly handlers: OverlayHandlers
  ) {
    this.root = document.createElement('div')
    this.root.className = 'office-overlay'
    this.tooltip = document.createElement('div')
    this.tooltip.id = 'office-tooltip'
    this.tooltip.setAttribute('role', 'tooltip')
    this.tooltip.hidden = true
    stage.appendChild(this.root)
    stage.appendChild(this.tooltip)
    document.addEventListener('keydown', this.onKeyDown)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.hideTooltip()
  }

  /** One button per placement, in reading order; buttons of agents that left are removed. */
  update(world: World, layout: OfficeLayout, scale: number): void {
    this.world = world
    this.scale = scale
    const wanted = new Set<string>()
    const ordered: HTMLButtonElement[] = []
    for (const placement of layout.placements) {
      const agent = world.agents[placement.agentId]
      if (!agent) continue
      wanted.add(agent.id)
      const button = this.buttons.get(agent.id) ?? this.createButton(agent.id)
      button.dataset.state = agent.state
      button.dataset.room = placement.room
      button.dataset.kind = placement.kind
      button.setAttribute('aria-pressed', String(agent.id === this.selectedId))
      button.setAttribute('aria-label', ariaLabel(agent, world))
      this.boxes.set(agent.id, placement.boxPx)
      if (!this.walking.has(agent.id)) this.place(button, placement.boxPx)
      ordered.push(button)
    }
    for (const [id, button] of this.buttons) {
      if (wanted.has(id)) continue
      button.remove()
      this.buttons.delete(id)
      this.boxes.delete(id)
      this.walking.delete(id)
      if (this.tooltipFor === id) this.hideTooltip()
    }
    // Put the buttons in reading order, moving only those out of place (a moved node can lose focus).
    ordered.forEach((button, index) => {
      if (this.root.children[index] !== button) this.root.insertBefore(button, this.root.children[index] ?? null)
    })
    if (this.tooltipFor) this.showTooltip(this.tooltipFor)
  }

  /** The agent the page has selected: its button says so (aria-pressed), the others do not. */
  setSelected(agentId: string | undefined): void {
    this.selectedId = agentId
    for (const [id, button] of this.buttons) button.setAttribute('aria-pressed', String(id === agentId))
  }

  /** The canvas scale changed (the window was resized): every button moves with it. */
  setScale(scale: number, placements: readonly Placement[]): void {
    this.scale = scale
    for (const placement of placements) {
      const button = this.buttons.get(placement.agentId)
      if (button && !this.walking.has(placement.agentId)) this.place(button, placement.boxPx)
    }
  }

  /** A walking agent's button follows the walker; one that has stopped goes back to its seat. */
  syncWalkers(walkers: readonly { agentId: string; box: Rect }[]): void {
    const now = new Set<string>()
    for (const walker of walkers) {
      now.add(walker.agentId)
      const button = this.buttons.get(walker.agentId)
      if (button) this.place(button, walker.box)
    }
    for (const id of this.walking) {
      if (now.has(id)) continue
      const button = this.buttons.get(id)
      const box = this.boxes.get(id)
      if (button && box) this.place(button, box)
    }
    this.walking = now
  }

  clear(): void {
    for (const button of this.buttons.values()) button.remove()
    this.buttons.clear()
    this.boxes.clear()
    this.walking.clear()
    this.hideTooltip()
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown)
    this.clear()
    this.root.remove()
    this.tooltip.remove()
  }

  private createButton(agentId: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'office-agent'
    button.dataset.agentId = agentId
    button.addEventListener('pointerenter', () => this.showTooltip(agentId))
    button.addEventListener('pointerleave', () => {
      if (document.activeElement !== button) this.hideTooltip()
    })
    button.addEventListener('click', () => this.handlers.onSelect?.(agentId))
    button.addEventListener('focus', () => {
      this.showTooltip(agentId)
      this.handlers.onFocus(agentId)
    })
    button.addEventListener('blur', () => {
      this.hideTooltip()
      this.handlers.onFocus(undefined)
    })
    this.buttons.set(agentId, button)
    return button
  }

  private place(button: HTMLButtonElement, box: Rect): void {
    button.style.transform = `translate(${box.x * this.scale}px, ${box.y * this.scale}px)`
    button.style.width = `${box.w * this.scale}px`
    button.style.height = `${box.h * this.scale}px`
  }

  private showTooltip(agentId: string): void {
    const agent = this.world?.agents[agentId]
    const button = this.buttons.get(agentId)
    const box = this.boxes.get(agentId)
    if (!this.world || !agent || !button || !box) return
    this.tooltipFor = agentId
    this.tooltip.textContent = ''
    for (const line of tooltipLines(agent, this.world)) {
      const row = document.createElement('div')
      row.textContent = line
      this.tooltip.appendChild(row)
    }
    // Under the agent's seat, not under a walker: the tooltip stays put while its agent moves.
    this.tooltip.style.transform = `translate(${box.x * this.scale}px, ${(box.y + box.h) * this.scale + 4}px)`
    this.tooltip.hidden = false
  }

  private hideTooltip(): void {
    this.tooltipFor = undefined
    this.tooltip.hidden = true
  }
}
