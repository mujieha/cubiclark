import { agentRows, diagnosticsLine, emptyScreen, emptyScreenText, officeStatusLine, sourcesLine, type EmptyScreenId } from '../core/view.js'
import type { World } from '../core/types.js'
import { OfficeView, browserEnv } from './office/office-view.js'
import './style.css'

const CONNECTION_LABELS = {
  connecting: 'connecting…',
  live: 'live',
  disconnected: 'disconnected — retrying…',
} as const

type ConnectionState = keyof typeof CONNECTION_LABELS
type ViewName = 'office' | 'list'

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

/** The page is one skeleton, built once: the office's canvas must survive every update of the World. */
class App {
  private world: World | undefined
  private connection: ConnectionState = 'connecting'
  private view: ViewName = viewFromHash()
  private shownView: ViewName | undefined

  private readonly connectionEl = el('span', { className: 'connection' })
  private readonly toggle = el('button', { id: 'view-toggle' })
  private readonly officeSection = el('section', { id: 'office-view' })
  private readonly officeStatus = el('p', { className: 'office-status' })
  private readonly listSection = el('section', { id: 'list-view' })
  private readonly emptyEl = el('div', { className: 'empty' })
  private readonly sourcesEl = el('p', { className: 'sources' })
  private readonly diagnosticsEl = el('p', { className: 'diagnostics' })
  private readonly office: OfficeView

  constructor(private readonly root: HTMLElement) {
    const header = el('header', { className: 'header' })
    header.appendChild(el('span', { className: 'title', text: 'Cubiclark' }))
    this.toggle.type = 'button'
    this.toggle.addEventListener('click', () => {
      location.hash = this.view === 'office' ? '#list' : '#office'
    })
    header.appendChild(this.toggle)
    header.appendChild(this.connectionEl)

    const officeHost = el('div', { className: 'office-host' })
    this.officeSection.appendChild(officeHost)
    this.officeSection.appendChild(this.officeStatus)

    root.appendChild(header)
    root.appendChild(this.emptyEl)
    root.appendChild(this.officeSection)
    root.appendChild(this.listSection)
    root.appendChild(this.sourcesEl)
    root.appendChild(this.diagnosticsEl)

    this.office = new OfficeView(officeHost, browserEnv())
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

    const screenId = emptyScreen(this.world)
    this.renderEmpty(screenId)
    this.office.setWorld(this.world, screenId)

    const world = screenId ? undefined : this.world
    this.officeStatus.hidden = !world
    this.officeStatus.textContent = world ? officeStatusLine(world) : ''
    this.renderTable(world)
    this.sourcesEl.hidden = !world
    this.sourcesEl.textContent = world ? sourcesLine(world) : ''
    this.diagnosticsEl.hidden = !world
    this.diagnosticsEl.textContent = world ? diagnosticsLine(world) : ''
    this.applyView()
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
    for (const row of agentRows(world, nowMs)) {
      const tr = document.createElement('tr')
      tr.dataset.agentId = row.id
      tr.dataset.state = row.state
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
