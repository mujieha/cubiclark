import { defaultTaskId, type LogFilter } from '../core/hud.js'
import { ownEntry } from '../core/keys.js'
import { agentRows, diagnosticsLine, emptyScreen, emptyScreenText, officeStatusLine, setupScreen, sourcesLine, type EmptyScreenId } from '../core/view.js'
import { THEMES, nextThemeChoice, resolveThemeId, themeButtonText, type Theme, type ThemeChoice } from '../core/theme/index.js'
import type { World } from '../core/types.js'
import { visibleAgents, withVisibleAgents, type HiddenCounts } from '../core/visible.js'
import { Hud } from './hud.js'
import { assetsText, type PublicAssets } from '../core/assets/status.js'
import { applyPageTheme, fetchCustomAssets, lookFor, readThemeChoice, writeThemeChoice } from './theme.js'
import { fetchPageOptions, readMascotChoice, writeMascotChoice, type PageOptions } from './mascot-choice.js'
import { mascotButtonText } from '../core/office/mascot.js'
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
  /** The World as it is in view (src/core/visible.ts): what the office, the list and the panel show. */
  private inView: World | undefined
  private connection: ConnectionState = 'connecting'
  private view: ViewName = viewFromHash()
  private shownView: ViewName | undefined
  private selectedAgentId: string | undefined
  private chosenTaskId: string | undefined
  private filter: LogFilter = {}
  private hudCollapsed = readHudCollapsed()

  private themeChoice: ThemeChoice = readThemeChoice()
  private readonly darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  private readonly themeToggle = el('button', { id: 'theme-toggle' })
  private readonly mascotToggle = el('button', { id: 'mascot-toggle' })
  /** Morty is shown: the server allows him (no --no-mascot) and this browser has not turned him off. */
  private mascotOn = false
  private readonly connectionEl = el('span', { className: 'connection' })
  private readonly toggle = el('button', { id: 'view-toggle' })
  private readonly hudToggle = el('button', { id: 'hud-toggle' })
  private readonly main = el('div', { className: 'page-main' })
  private readonly officeSection = el('section', { id: 'office-view' })
  private readonly officeStatus = el('p', { className: 'office-status' })
  private readonly listSection = el('section', { id: 'list-view' })
  private readonly assetErrorsEl = el('section', { className: 'asset-errors', id: 'asset-errors' })
  private readonly emptyEl = el('div', { className: 'empty' })
  private readonly sourcesEl = el('p', { className: 'sources' })
  private readonly diagnosticsEl = el('p', { className: 'diagnostics' })
  private readonly office: OfficeView
  private readonly hud: Hud

  constructor(
    private readonly root: HTMLElement,
    private readonly custom: PublicAssets,
    // How the server was started; Morty's button arrives in a later step.
    readonly options: PageOptions
  ) {
    const header = el('header', { className: 'header' })
    header.appendChild(el('span', { className: 'title', text: 'Cubiclark' }))
    // Tab order is DOM order: the theme toggle comes first, then the panel toggle, so that after the
    // view toggle the next stop is the office.
    this.themeToggle.type = 'button'
    this.themeToggle.addEventListener('click', () => {
      this.themeChoice = nextThemeChoice(this.themeChoice)
      writeThemeChoice(this.themeChoice)
      this.applyTheme()
    })
    header.appendChild(this.themeToggle)
    // Morty's button, right after the theme's; started with --no-mascot there is no button at all.
    if (this.options.mascot) {
      this.mascotToggle.type = 'button'
      this.mascotToggle.addEventListener('click', () => {
        this.mascotOn = !this.mascotOn
        writeMascotChoice(this.mascotOn)
        this.applyMascot()
      })
      header.appendChild(this.mascotToggle)
    }
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

    this.assetErrorsEl.setAttribute('role', 'status')
    this.assetErrorsEl.setAttribute('aria-label', 'Problems in the custom-assets manifest')
    this.main.append(this.assetErrorsEl, this.emptyEl, this.officeSection, this.listSection, this.sourcesEl, this.diagnosticsEl)
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

    const theme = this.currentTheme()
    applyPageTheme(document.documentElement, theme)
    this.hud.setPalette(lookFor(theme, this.custom).palette)
    this.office = new OfficeView(officeHost, browserEnv(), { onSelect: (agentId) => this.select(agentId) }, lookFor(theme, this.custom))
    // Morty is in the page unless the server was started with --no-mascot or this browser chose otherwise.
    this.mascotOn = this.options.mascot && readMascotChoice()
    this.applyMascot()
    this.themeToggle.textContent = themeButtonText(this.themeChoice, theme.id)
    this.root.dataset.themeChoice = this.themeChoice
    // `auto` follows the operating system while the page is open.
    this.darkQuery.addEventListener('change', () => {
      if (this.themeChoice === 'auto') this.applyTheme()
    })
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

  private currentTheme(): Theme {
    return THEMES[resolveThemeId(this.themeChoice, this.darkQuery.matches)]
  }

  /** The page's colours, the office's palette and the toggle's text, for the theme now in force. */
  private applyTheme(): void {
    const theme = this.currentTheme()
    applyPageTheme(document.documentElement, theme)
    this.hud.setPalette(lookFor(theme, this.custom).palette)
    this.office.setLook(lookFor(theme, this.custom))
    this.themeToggle.textContent = themeButtonText(this.themeChoice, theme.id)
    this.root.dataset.themeChoice = this.themeChoice
  }

  /** Morty on or off: the office, the button's text and what it says about itself. */
  private applyMascot(): void {
    this.office.setMascot(this.mascotOn)
    // Started with --no-mascot, the page has no button and says nothing of him.
    if (!this.options.mascot) return
    this.mascotToggle.textContent = mascotButtonText(this.mascotOn)
    this.mascotToggle.setAttribute('aria-pressed', String(this.mascotOn))
    this.root.dataset.mascot = this.mascotOn ? 'on' : 'off'
  }

  /** Clicking the selected agent again clears the selection. */
  private select(agentId: string): void {
    // A line of the log can name an agent that is not in view any more: there is nothing to select.
    if (this.inView && !this.inView.agents[agentId]) return
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

    // Who is in view is decided once, here, and every part of the page gets the same answer: the
    // office, the list, the panel and every count. The World itself is not changed by it.
    const shown = this.world ? visibleAgents(this.world, Date.parse(this.world.clock), { idleDesks: this.options.idleDesks }) : undefined
    const inView = this.world && shown ? withVisibleAgents(this.world, shown) : undefined
    const hidden = shown?.hidden
    this.inView = inView

    // A selection that points at an agent that has left the World, or is not in view, is dropped.
    if (this.selectedAgentId !== undefined && inView && !inView.agents[this.selectedAgentId]) this.selectedAgentId = undefined

    // The timeline shows the chosen task, else the selected agent's, else the newest one that is live.
    const chosen = this.chosenTaskId !== undefined && inView && ownEntry(inView.tasks, this.chosenTaskId) ? this.chosenTaskId : undefined
    const taskId = chosen ?? (inView ? defaultTaskId(inView, this.selectedAgentId) : undefined)

    const screenId = emptyScreen(inView)
    this.renderAssetErrors(inView)
    this.renderEmpty(screenId, inView, hidden)
    // The whiteboard shows the same task as the timeline.
    this.office.setSelectedTask(inView ? ownEntry(inView.tasks, taskId) : undefined)
    this.office.setWorld(inView, screenId)
    this.office.setSelected(this.selectedAgentId)

    const world = screenId ? undefined : inView
    this.officeStatus.hidden = !world
    this.officeStatus.textContent = world ? officeStatusLine(world, hidden) : ''
    this.renderTable(world)
    this.sourcesEl.hidden = !world
    this.sourcesEl.textContent = world ? sourcesLine(world) : ''
    this.diagnosticsEl.hidden = !world
    this.diagnosticsEl.textContent = world ? diagnosticsLine(world) : ''
    this.applyView()
    this.applyHud()

    this.hud.update(inView, { selectedAgentId: this.selectedAgentId, taskId, taskChosen: chosen !== undefined, filter: this.filter, hidden })
  }

  /** The problems in a custom-assets manifest, above everything else (also on the empty screens): the
   * pack was not applied, and the person who wrote it needs to see why. Text only. */
  private renderAssetErrors(world: World | undefined): void {
    const status = world?.sources.assets
    const invalid = status !== undefined && status.status === 'invalid'
    this.assetErrorsEl.hidden = !invalid
    // Rebuilt only when the text changes, so a screen reader is not read the same list again.
    const key = invalid ? `${status.file ?? ''}|${status.errorCount}|${status.errors.join('\n')}` : ''
    if (this.assetErrorsEl.dataset.key === key) return
    this.assetErrorsEl.dataset.key = key
    this.assetErrorsEl.textContent = ''
    if (!invalid) return
    this.assetErrorsEl.appendChild(el('p', { className: 'asset-errors-title', text: `Custom assets not applied: ${assetsText(status)}${status.file ? ` (${status.file})` : ''}` }))
    const list = el('ul', { className: 'asset-errors-list' })
    for (const error of status.errors) list.appendChild(el('li', { text: error }))
    if (status.errorCount > status.errors.length) list.appendChild(el('li', { text: `…and ${status.errorCount - status.errors.length} more` }))
    this.assetErrorsEl.appendChild(list)
  }

  private renderEmpty(screenId: EmptyScreenId | null, world: World | undefined, hidden: HiddenCounts | undefined): void {
    this.emptyEl.hidden = screenId === null
    this.emptyEl.textContent = ''
    if (screenId === null) {
      delete this.emptyEl.dataset.empty
      return
    }
    this.emptyEl.dataset.empty = screenId
    if (screenId === 'no-collector') {
      this.renderSetup(world)
      return
    }
    this.emptyEl.appendChild(el('p', { text: emptyScreenText(screenId, world, hidden) }))
  }

  /** The first run: how to begin, and the two ways of seeing agents explained. Text only. */
  private renderSetup(world: World | undefined): void {
    const setup = setupScreen(world)
    const wrap = el('div', { className: 'setup' })
    wrap.appendChild(el('h2', { className: 'setup-title', text: setup.title }))
    wrap.appendChild(el('p', { text: setup.intro }))
    for (const mode of setup.modes) {
      const card = el('article', { className: 'setup-mode' })
      card.dataset.mode = mode.id
      card.appendChild(el('h3', { text: mode.title }))
      card.appendChild(el('p', { text: mode.body }))
      if (mode.command) card.appendChild(el('code', { className: 'setup-command', text: mode.command }))
      wrap.appendChild(card)
    }
    wrap.appendChild(el('p', { className: 'setup-footer', text: setup.footer }))
    this.emptyEl.appendChild(wrap)
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
  // The valid pack, fetched before the first frame so the office is never drawn in art it is about to replace.
  const [custom, options] = await Promise.all([fetchCustomAssets(), fetchPageOptions()])
  const app = new App(appRoot, custom, options)

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
