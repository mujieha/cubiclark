import { defaultTaskId, type LogFilter } from '../core/hud.js'
import { agentRows, diagnosticsLine, emptyScreen, emptyScreenText, officeStatusLine, sourcesLine, type EmptyScreenId } from '../core/view.js'
import type { World } from '../core/types.js'
import { Hud } from './hud.js'
import { OfficeView, browserEnv } from './office/office-view.js'
import './style.css'

const CONNECTION_LABELS = {
  connecting: 'connecting…',
  live: 'live',
  disconnected: 'disconnected — retrying…',
} as const

type ConnectionState = keyof typeof CONNECTION_LABELS
type ViewName = 'office' | 'list'

const HUD_STORAGE_KEY = 'cubiclark.hud'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string; id?: string } = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (opts.className) node.className = opts.className
  if (opts.id) node.id = opts.id
  if (opts.text !== undefined) node.textContent = opts.text
  return node
}

const COLUMN_LABELS = ['Kind', 'Parent', 'Project', 'Model', 'State', 'Since', 'Current tool'] as const

/** Whether the panel was left collapsed. Only a per-viewer convenience: no storage means "open". */
function readHudCollapsed(): boolean {
  try {
    return localStorage.getItem(HUD_STORAGE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

function writeHudCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(HUD_STORAGE_KEY, collapsed ? 'collapsed' : 'open')
  } catch {
    // storage can be blocked; the panel simply opens next time
  }
}

/** The page is one skeleton, built once: the office's canvas must survive every update of the World. */
class App {
  private world: World | undefined
  private connection: ConnectionState = 'connecting'
  private view: ViewName = viewFromHash()
  private shownView: ViewName | undefined
  private selectedAgentId: string | undefined
  private chosenTaskId: string | undefined
  private filter: LogFilter = {}
  private hudCollapsed = readHudCollapsed()

  private readonly connectionEl = el('span', { className: 'connection' })
  private readonly toggle = el('button', { id: 'view-toggle' })
  private readonly hudToggle = el('button', { id: 'hud-toggle' })
  private readonly main = el('div', { className: 'page-main' })
  private readonly officeSection = el('section', { id: 'office-view' })
  private readonly officeStatus = el('p', { className: 'office-status' })
  private readonly listSection = el('section', { id: 'list-view' })
  private readonly emptyEl = el('div', { className: 'empty' })
  private readonly sourcesEl = el('p', { className: 'sources' })
  private readonly diagnosticsEl = el('p', { className: 'diagnostics' })
  private readonly office: OfficeView
  private readonly hud: Hud

  constructor(private readonly root: HTMLElement) {
    const header = el('header', { className: 'header' })
    header.appendChild(el('span', { className: 'title', text: 'Cubiclark' }))
    // Tab order: the panel toggle first, so that after the view toggle the next stop is the office.
    this.hudToggle.type = 'button'
    this.hudToggle.setAttribute('aria-controls', 'hud')
    this.hudToggle.addEventListener('click', () => {
      this.hudCollapsed = !this.hudCollapsed
      writeHudCollapsed(this.hudCollapsed)
      this.applyHud()
    })
    header.appendChild(this.hudToggle)
    this.toggle.type = 'button'
    this.toggle.addEventListener('click', () => {
      location.hash = this.view === 'office' ? '#list' : '#office'
    })
    header.appendChild(this.toggle)

    const officeHost = el('div', { className: 'office-host' })
    this.officeSection.appendChild(officeHost)
    this.officeSection.appendChild(this.officeStatus)

    this.main.append(this.emptyEl, this.officeSection, this.listSection, this.sourcesEl, this.diagnosticsEl)
    this.hud = new Hud({
      onSelectTask: (taskId) => {
        this.chosenTaskId = taskId
        this.render()
      },
      onFilter: (filter) => {
        this.filter = filter
        this.render()
      },
      onSelectAgent: (agentId) => this.select(agentId),
    })
    this.hud.connectionSlot.appendChild(this.connectionEl)

    root.append(header, this.main, this.hud.element)

    this.office = new OfficeView(officeHost, browserEnv(), { onSelect: (agentId) => this.select(agentId) })
    window.addEventListener('hashchange', () => {
      this.view = viewFromHash()
      this.applyView()
    })
    this.render()
  }

  setWorld(world: World): void {
    this.world = world
    this.render()
  }

  setConnection(state: ConnectionState): void {
    this.connection = state
    this.render()
  }

  /** Clicking the selected agent again clears the selection. */
  private select(agentId: string): void {
    this.selectedAgentId = this.selectedAgentId === agentId ? undefined : agentId
    this.render()
  }

  private applyHud(): void {
    this.hud.element.hidden = this.hudCollapsed
    this.root.dataset.hud = this.hudCollapsed ? 'collapsed' : 'open'
    this.hudToggle.textContent = this.hudCollapsed ? 'Show panel' : 'Hide panel'
    this.hudToggle.setAttribute('aria-expanded', String(!this.hudCollapsed))
  }

  private applyView(): void {
    this.officeSection.hidden = this.view !== 'office'
    this.listSection.hidden = this.view !== 'list'
    this.toggle.textContent = this.view === 'office' ? 'List view' : 'Office view'
    this.toggle.setAttribute('aria-pressed', String(this.view === 'list'))
    this.root.dataset.view = this.view
    // Resizing clears the canvas, so the office is only told when the view really changes.
    if (this.shownView !== this.view) {
      this.shownView = this.view
      this.office.setVisible(this.view === 'office')
    }
  }

  private render(): void {
    this.connectionEl.className = `connection connection-${this.connection}`
    this.connectionEl.textContent = CONNECTION_LABELS[this.connection]

    // A selection that points at an agent that has left the World is dropped.
    if (this.selectedAgentId !== undefined && this.world && !this.world.agents[this.selectedAgentId]) this.selectedAgentId = undefined

    // The timeline shows the chosen task, else the selected agent's, else the newest one that is live.
    const chosen = this.chosenTaskId !== undefined && this.world?.tasks[this.chosenTaskId] ? this.chosenTaskId : undefined
    const taskId = chosen ?? (this.world ? defaultTaskId(this.world, this.selectedAgentId) : undefined)

    const screenId = emptyScreen(this.world)
    this.renderEmpty(screenId)
    // The whiteboard shows the same task as the timeline.
    this.office.setSelectedTask(taskId === undefined ? undefined : this.world?.tasks[taskId])
    this.office.setWorld(this.world, screenId)
    this.office.setSelected(this.selectedAgentId)

    const world = screenId ? undefined : this.world
    this.officeStatus.hidden = !world
    this.officeStatus.textContent = world ? officeStatusLine(world) : ''
    this.renderTable(world)
    this.sourcesEl.hidden = !world
    this.sourcesEl.textContent = world ? sourcesLine(world) : ''
    this.diagnosticsEl.hidden = !world
    this.diagnosticsEl.textContent = world ? diagnosticsLine(world) : ''
    this.applyView()
    this.applyHud()

    this.hud.update(this.world, { selectedAgentId: this.selectedAgentId, taskId, taskChosen: chosen !== undefined, filter: this.filter })
  }

  private renderEmpty(screenId: EmptyScreenId | null): void {
    this.emptyEl.hidden = screenId === null
    this.emptyEl.textContent = ''
    if (screenId === null) {
      delete this.emptyEl.dataset.empty
      return
    }
    this.emptyEl.dataset.empty = screenId
    this.emptyEl.appendChild(el('p', { text: emptyScreenText(screenId, this.world) }))
  }

  private renderTable(world: World | undefined): void {
    // The table is rebuilt on every update: a row the keyboard is on is found again by its agent.
    const focused = document.activeElement instanceof HTMLElement && this.listSection.contains(document.activeElement) ? document.activeElement.dataset.agentId : undefined
    this.listSection.textContent = ''
    if (!world) return
    const table = document.createElement('table')

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const label of COLUMN_LABELS) headRow.appendChild(el('th', { text: label }))
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    const nowMs = Date.parse(world.clock)
    let refocus: HTMLElement | undefined
    for (const row of agentRows(world, nowMs)) {
      const tr = document.createElement('tr')
      tr.dataset.agentId = row.id
      tr.dataset.state = row.state
      tr.tabIndex = 0
      if (row.id === this.selectedAgentId) tr.setAttribute('aria-current', 'true')
      tr.addEventListener('click', () => this.select(row.id))
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.select(row.id)
        }
      })
      if (row.id === focused) refocus = tr
      const indent = row.depth > 0 ? `${'  '.repeat(row.depth)}↳ ` : ''
      tr.appendChild(el('td', { text: `${indent}${row.kind}` }))
      tr.appendChild(el('td', { text: row.parentLabel ?? '—' }))
      tr.appendChild(el('td', { text: row.project }))
      tr.appendChild(el('td', { text: row.model ?? '—' }))
      tr.appendChild(el('td', { className: `state state-${row.stateLabel.includes('inferred') ? 'inferred' : 'observed'}`, text: row.stateLabel }))
      tr.appendChild(el('td', { text: row.since }))
      tr.appendChild(el('td', { text: row.currentTool ?? '—' }))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    this.listSection.appendChild(table)
    refocus?.focus()
  }
}

function viewFromHash(): ViewName {
  return location.hash === '#list' ? 'list' : 'office'
}

const appRoot = document.getElementById('app')
if (appRoot) {
  const app = new App(appRoot)

  const source = new EventSource('./events')
  source.addEventListener('open', () => app.setConnection('live'))
  source.addEventListener('error', () => app.setConnection('disconnected'))
  source.addEventListener('world', (event) => {
    app.setConnection('live')
    try {
      const world = JSON.parse((event as MessageEvent<string>).data) as World
      app.setWorld(world)
    } catch {
      // a malformed SSE payload is a server bug the page cannot usefully recover from
    }
  })
}
