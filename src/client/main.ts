import { agentRows, diagnosticsLine, emptyScreen, emptyScreenText, sourcesLine } from '../core/view.js'
import type { World } from '../core/types.js'
import './style.css'

const CONNECTION_LABELS = {
  connecting: 'connecting…',
  live: 'live',
  disconnected: 'disconnected — retrying…',
} as const

type ConnectionState = keyof typeof CONNECTION_LABELS

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (opts.className) node.className = opts.className
  if (opts.text !== undefined) node.textContent = opts.text
  return node
}

const COLUMN_LABELS = ['Kind', 'Parent', 'Project', 'Model', 'State', 'Since', 'Current tool'] as const

class App {
  private world: World | undefined
  private connection: ConnectionState = 'connecting'

  constructor(private readonly root: HTMLElement) {
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

  private render(): void {
    this.root.textContent = ''
    this.root.appendChild(this.renderHeader())

    const screenId = emptyScreen(this.world)
    if (screenId) {
      this.root.appendChild(this.renderEmptyScreen(screenId))
      return
    }

    const world = this.world
    if (!world) return // unreachable: emptyScreen(undefined) always returns 'no-data'

    this.root.appendChild(this.renderTable(world))
    this.root.appendChild(el('p', { className: 'sources', text: sourcesLine(world) }))
    this.root.appendChild(el('p', { className: 'diagnostics', text: diagnosticsLine(world) }))
  }

  private renderHeader(): HTMLElement {
    const header = el('header', { className: 'header' })
    header.appendChild(el('span', { className: 'title', text: 'Cubiclark' }))
    header.appendChild(
      el('span', {
        className: `connection connection-${this.connection}`,
        text: CONNECTION_LABELS[this.connection],
      })
    )
    return header
  }

  private renderEmptyScreen(screenId: NonNullable<ReturnType<typeof emptyScreen>>): HTMLElement {
    const empty = el('div', { className: 'empty' })
    empty.dataset.empty = screenId
    empty.appendChild(el('p', { text: emptyScreenText(screenId, this.world) }))
    return empty
  }

  private renderTable(world: World): HTMLElement {
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
    return table
  }
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
