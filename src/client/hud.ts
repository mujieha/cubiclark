// The HUD panel (design §8): a terminal-style column with the legend and connection state, the
// selected agent's card, the session log, the task timeline and the status bar. What each part
// says is decided by src/core/hud.ts; this only prints it. Every string reaches the page through
// textContent, never as markup, and swatch colours are set through the CSSOM (CSP: style-src 'self').

import { agentCard, LEGEND, logFilterOptions, logRows, statusBar, timelineView, type LogFilter, type StageState } from '../core/hud.js'
import type { Task, World } from '../core/types.js'
import { PALETTE, shirtKey } from './office/palette.js'

export interface HudHandlers {
  /** A task chosen in the timeline's select, or undefined for "auto". */
  onSelectTask: (taskId: string | undefined) => void
  onFilter: (filter: LogFilter) => void
  /** A log row was clicked: select that agent. */
  onSelectAgent: (agentId: string) => void
}

export interface HudState {
  selectedAgentId: string | undefined
  /** What the timeline shows: the chosen task, or the automatic one. */
  taskId: string | undefined
  /** True when `taskId` was chosen in the select rather than picked automatically. */
  taskChosen: boolean
  filter: LogFilter
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts: { className?: string; text?: string; id?: string } = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (opts.className) node.className = opts.className
  if (opts.id) node.id = opts.id
  if (opts.text !== undefined) node.textContent = opts.text
  return node
}

const STAGE_MARK: Record<StageState, string> = { past: '✓', current: '▶', future: '·', blocked: '✖' }
const AUTO = 'auto'
const ALL = 'all'
/** The log follows new lines unless the person has scrolled up by more than this. */
const STICK_TO_BOTTOM_PX = 24

function timeOf(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB', { hour12: false })
}

function stampOf(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Replaces a select's options only when the list really changed, so an open dropdown survives updates. */
function setOptions(select: HTMLSelectElement, values: readonly string[], labels: (value: string) => string, selected: string): void {
  const key = values.join('\u0000')
  if (select.dataset.options !== key) {
    select.dataset.options = key
    select.textContent = ''
    for (const value of values) {
      const option = el('option', { text: labels(value) })
      option.value = value
      select.appendChild(option)
    }
  }
  select.value = values.includes(selected) ? selected : (values[0] ?? '')
}

export class Hud {
  readonly element = el('aside', { className: 'hud', id: 'hud' })
  /** Where the page puts its connection indicator (design §8: the title bar shows it). */
  readonly connectionSlot = el('span', { className: 'hud-connection' })

  private readonly cardEl = el('section', { className: 'hud-section', id: 'hud-card' })
  private readonly logSection = el('section', { className: 'hud-section', id: 'hud-log' })
  private readonly projectSelect = el('select', { id: 'hud-log-project' })
  private readonly taskFilterSelect = el('select', { id: 'hud-log-task' })
  private readonly logList = el('ol', { className: 'hud-log-list' })
  private readonly timelineSection = el('section', { className: 'hud-section', id: 'hud-timeline' })
  private readonly taskSelect = el('select', { id: 'hud-timeline-task' })
  private readonly timelineBody = el('div', { className: 'hud-timeline-body' })
  private readonly statusEl = el('footer', { className: 'hud-status', id: 'hud-status' })
  private logKey = ''
  private filter: LogFilter = {}

  constructor(private readonly handlers: HudHandlers) {
    const title = el('header', { className: 'hud-titlebar', id: 'hud-title' })
    title.appendChild(el('span', { className: 'hud-name', text: '>_ cubiclark' }))
    title.appendChild(this.connectionSlot)

    const legend = el('div', { className: 'hud-legend', id: 'hud-legend' })
    for (const { family, label } of LEGEND.models) {
      const item = el('span', { className: 'legend-item', text: label })
      const swatch = el('span', { className: `legend-swatch legend-${family}` })
      swatch.style.backgroundColor = PALETTE[shirtKey(family)] ?? '#5b6470'
      item.prepend(swatch)
      legend.appendChild(item)
    }
    for (const { role, accessory } of LEGEND.roles) legend.appendChild(el('span', { className: 'legend-item legend-role', text: `${role}: ${accessory}` }))
    title.appendChild(legend)

    this.projectSelect.setAttribute('aria-label', 'Filter the log by project')
    this.taskFilterSelect.setAttribute('aria-label', 'Filter the log by task')
    this.taskSelect.setAttribute('aria-label', 'Task shown in the timeline')
    const onFilter = (): void => {
      const project = this.projectSelect.value === ALL ? undefined : this.projectSelect.value
      const taskId = this.taskFilterSelect.value === ALL ? undefined : this.taskFilterSelect.value
      this.filter = { ...(project !== undefined ? { project } : {}), ...(taskId !== undefined ? { taskId } : {}) }
      handlers.onFilter(this.filter)
    }
    this.projectSelect.addEventListener('change', onFilter)
    this.taskFilterSelect.addEventListener('change', onFilter)
    this.taskSelect.addEventListener('change', () => handlers.onSelectTask(this.taskSelect.value === AUTO ? undefined : this.taskSelect.value))

    const filters = el('div', { className: 'hud-filters' })
    filters.appendChild(el('span', { className: 'hud-label', text: 'log' }))
    filters.appendChild(this.projectSelect)
    filters.appendChild(this.taskFilterSelect)
    this.logSection.appendChild(filters)
    this.logSection.appendChild(this.logList)

    const timelineHead = el('div', { className: 'hud-filters' })
    timelineHead.appendChild(el('span', { className: 'hud-label', text: 'task' }))
    timelineHead.appendChild(this.taskSelect)
    this.timelineSection.appendChild(timelineHead)
    this.timelineSection.appendChild(this.timelineBody)

    this.element.append(title, this.cardEl, this.logSection, this.timelineSection, this.statusEl)
    this.update(undefined, { selectedAgentId: undefined, taskId: undefined, taskChosen: false, filter: {} })
  }

  update(world: World | undefined, state: HudState): void {
    this.renderCard(world, state)
    this.renderLog(world, state)
    this.renderTimeline(world, state)
    this.renderStatus(world)
  }

  // --- The selected agent's card ------------------------------------------------------------

  private renderCard(world: World | undefined, state: HudState): void {
    this.cardEl.textContent = ''
    const card = world ? agentCard(world, state.selectedAgentId, Date.parse(world.clock)) : undefined
    if (!card) {
      this.cardEl.appendChild(el('p', { className: 'hud-hint', text: 'Select an agent in the office or the list' }))
      return
    }
    this.cardEl.dataset.agentId = state.selectedAgentId ?? ''
    this.cardEl.appendChild(el('h2', { className: 'hud-heading', text: card.title }))
    const list = el('dl', { className: 'hud-card-fields' })
    for (const field of card.fields) {
      list.appendChild(el('dt', { text: field.label }))
      list.appendChild(el('dd', { text: field.value }))
    }
    this.cardEl.appendChild(list)
  }

  // --- The session log ----------------------------------------------------------------------

  private renderLog(world: World | undefined, state: HudState): void {
    const options = world ? logFilterOptions(world) : { projects: [], tasks: [] }
    setOptions(this.projectSelect, [ALL, ...options.projects], (value) => (value === ALL ? 'all projects' : value), state.filter.project ?? ALL)
    setOptions(this.taskFilterSelect, [ALL, ...options.tasks], (value) => (value === ALL ? 'all tasks' : value), state.filter.taskId ?? ALL)

    const rows = world ? logRows(world, state.filter) : []
    const last = rows[rows.length - 1]
    const key = `${rows.length}|${last?.ts ?? ''}|${last?.result ?? ''}|${state.filter.project ?? ''}|${state.filter.taskId ?? ''}`
    if (key === this.logKey) return
    this.logKey = key

    const atBottom = this.logList.scrollHeight - this.logList.scrollTop - this.logList.clientHeight <= STICK_TO_BOTTOM_PX
    this.logList.textContent = ''
    if (rows.length === 0) this.logList.appendChild(el('li', { className: 'hud-hint', text: 'No events yet' }))
    for (const row of rows) {
      const item = el('li', { className: 'hud-log-row' })
      item.dataset.agentId = row.agentId
      item.dataset.event = row.event
      item.append(el('time', { text: timeOf(row.ts) }), el('span', { className: 'log-agent', text: row.agent }), el('span', { className: 'log-event', text: row.event }), el('span', { className: 'log-result', text: row.result }))
      item.addEventListener('click', () => this.handlers.onSelectAgent(row.agentId))
      this.logList.appendChild(item)
    }
    if (atBottom) this.logList.scrollTop = this.logList.scrollHeight
  }

  // --- The task timeline --------------------------------------------------------------------

  private renderTimeline(world: World | undefined, state: HudState): void {
    const tasks: Task[] = world ? Object.values(world.tasks).sort((a, b) => a.id.localeCompare(b.id)) : []
    setOptions(this.taskSelect, [AUTO, ...tasks.map((task) => task.id)], (value) => (value === AUTO ? 'auto' : value), state.taskChosen && state.taskId ? state.taskId : AUTO)

    this.timelineBody.textContent = ''
    const task = state.taskId === undefined ? undefined : world?.tasks[state.taskId]
    if (!task) {
      this.timelineBody.appendChild(el('p', { className: 'hud-hint', text: tasks.length === 0 ? 'No tasks: none of the adapters reports any' : 'No task selected' }))
      return
    }
    const view = timelineView(task)
    const head = [view.taskId, view.project, view.model, view.effort ? `effort ${view.effort}` : undefined, view.pr !== undefined ? `PR #${view.pr}` : undefined].filter((part): part is string => part !== undefined)
    this.timelineBody.appendChild(el('h2', { className: 'hud-heading', text: head.join(' · ') }))
    if (view.title) this.timelineBody.appendChild(el('p', { className: 'hud-hint', text: view.title }))

    const stages = el('ol', { className: 'hud-stages' })
    for (const { stage, state: stageState } of view.stages) {
      const item = el('li', { text: `${STAGE_MARK[stageState]} ${stage}` })
      item.dataset.stage = stage
      item.dataset.state = stageState
      stages.appendChild(item)
    }
    this.timelineBody.appendChild(stages)

    const entries = el('ol', { className: 'hud-entries' })
    for (const entry of view.entries) {
      const item = el('li')
      item.dataset.kind = entry.kind
      // The text already says what happened ("forked after 1 compaction"); the kind is data-kind.
      item.append(el('time', { text: stampOf(entry.ts) }), el('span', { className: 'entry-text', text: entry.text }))
      if (entry.modelChange) item.appendChild(el('span', { className: 'model-change', text: entry.modelChange }))
      entries.appendChild(item)
    }
    this.timelineBody.appendChild(entries)
  }

  // --- The status bar -----------------------------------------------------------------------

  private renderStatus(world: World | undefined): void {
    this.statusEl.textContent = ''
    if (!world) {
      this.statusEl.appendChild(el('span', { text: 'waiting for data' }))
      delete this.statusEl.dataset.clock
      return
    }
    this.statusEl.dataset.clock = world.clock
    for (const segment of statusBar(world)) {
      const span = el('span', { text: segment.text })
      span.dataset.segment = segment.id
      this.statusEl.appendChild(span)
    }
  }
}
