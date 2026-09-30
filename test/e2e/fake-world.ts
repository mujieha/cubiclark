// The e2e seam: fixture worlds go into the real page through a fake EventSource that Playwright
// installs before the page's scripts run, so no production code exists only for tests. The page
// is served by the real built CLI (over an empty fixture home), the real CSP included.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import type { World } from '../../src/core/types.js'
import { runCli, type RunningCli } from './helpers.js'

const WORLDS_DIR = fileURLToPath(new URL('../fixtures/worlds/', import.meta.url))
const EVIDENCE_DIR = fileURLToPath(new URL('../../test-results/office/', import.meta.url))

/** Runs in the page before any of its scripts: replaces EventSource, exposes __cubiclarkPush(json). */
export const FAKE_EVENT_SOURCE = (): void => {
  const w = window as unknown as Record<string, unknown>
  class FakeEventSource {
    listeners: Record<string, ((event: unknown) => void)[]> = {}
    constructor() {
      w.__cubiclarkFake = this
      setTimeout(() => this.emit('open', {}), 0)
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      ;(this.listeners[type] ??= []).push(listener)
    }
    emit(type: string, event: unknown): void {
      for (const listener of this.listeners[type] ?? []) listener(event)
    }
    close(): void {
      // There is no connection to close: worlds only arrive through __cubiclarkPush.
    }
  }
  w.EventSource = FakeEventSource
  w.__cubiclarkPush = (data: string) => (w.__cubiclarkFake as FakeEventSource).emit('world', { data })
}

export interface OpenOptions {
  /** URL hash to open with, e.g. '#list'. */
  hash?: string
  /** Install a paused page clock at this ISO time, so animation is driven by pushWorld's settle time. */
  clockAt?: string
  /** More arguments for the CLI, e.g. `['--assets', file]`. */
  args?: string[]
  /** Morty, the office corgi, is in the page (the default). `false` starts the CLI with
   * `--no-mascot`: the page of every pixel baseline that was committed before he existed. */
  mascot?: boolean
}

/** Pages that openWithFakeWorld gave a paused clock: only there does pushWorld advance time. */
const clockedPages = new WeakSet<Page>()

export interface FakeWorldPage extends RunningCli {
  clocked: boolean
}

/** Opens the built page over an empty fixture home with the fake EventSource, and optionally a paused clock. */
export async function openWithFakeWorld(page: Page, opts: OpenOptions = {}): Promise<FakeWorldPage> {
  const home = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-fake-'))
  const cli = await runCli(['--fixture-home', home, '--no-open', '--port', '0', ...(opts.mascot === false ? ['--no-mascot'] : []), ...(opts.args ?? [])])
  await page.addInitScript(FAKE_EVENT_SOURCE)
  if (opts.clockAt) await page.clock.install({ time: new Date(opts.clockAt) })
  await page.goto(`${cli.url}${opts.hash ?? ''}`)
  if (opts.clockAt) {
    await page.clock.pauseAt(new Date(new Date(opts.clockAt).getTime() + 1000))
    clockedPages.add(page)
  }
  return {
    ...cli,
    clocked: opts.clockAt !== undefined,
    stop: async () => {
      await cli.stop()
      await rm(home, { recursive: true, force: true })
    },
  }
}

export async function loadWorldText(name: string): Promise<string> {
  return readFile(join(WORLDS_DIR, `${name}.json`), 'utf8')
}

export async function loadWorld(name: string): Promise<World> {
  return JSON.parse(await loadWorldText(name)) as World
}

/** The page makes its EventSource only after two requests (page options, custom assets) have answered,
 * so on a busy machine `goto` can return first. Waited for from here, on the real clock, since a page
 * clock that is paused would never fire a timer or a frame inside the page. */
async function waitForEventSource(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await page.evaluate(() => '__cubiclarkFake' in window)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the page never made its EventSource')
}

/** Sends a World to the page as if the server had pushed it, then lets `settleMs` of page time pass (with a paused clock). */
export async function pushWorld(page: Page, world: World, settleMs = 100): Promise<void> {
  await waitForEventSource(page)
  await page.evaluate((data) => (window as unknown as { __cubiclarkPush: (d: string) => void }).__cubiclarkPush(data), JSON.stringify(world))
  if (clockedPages.has(page)) {
    // A new World can change the size of the office, and the page's ResizeObserver then clears the canvas
    // and asks for a frame. The page clock is paused, so that frame only comes from `runFor`: if a busy
    // machine ran the observer *after* the frames, the picture stayed blank. A new observer's first
    // callback runs after the page's own in the same rendering step, so waiting for it (on the real
    // clock, no page time passes) puts every resize before the frames that follow.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect()
            resolve()
          })
          observer.observe(document.body)
        })
    )
    await page.clock.runFor(settleMs)
  }
}

export interface AgentView {
  id: string
  state: string
  room?: string
}

const byId = (a: AgentView, b: AgentView): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** What the office reports: one button per agent, from its data attributes. */
export async function officeAgents(page: Page): Promise<Required<AgentView>[]> {
  const agents = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button.office-agent')].map((button) => ({
      id: button.dataset.agentId ?? '',
      state: button.dataset.state ?? '',
      room: button.dataset.room ?? '',
    }))
  )
  return agents.sort(byId)
}

/** What the list reports: one table row per agent. Switches to the list view to read it, and back. */
export async function listAgents(page: Page): Promise<AgentView[]> {
  await page.evaluate(() => {
    location.hash = '#list'
  })
  await expect(page.locator('#list-view')).toBeVisible()
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#list-view tbody tr')].map((row) => ({
      id: row.dataset.agentId ?? '',
      state: row.dataset.state ?? '',
    }))
  )
  await page.evaluate(() => {
    location.hash = '#office'
  })
  await expect(page.locator('#office-view')).toBeVisible()
  return rows.sort(byId)
}

/** Writes a screenshot where the operator can look at it: test-results/office/<name>.png (gitignored). */
export async function saveEvidence(name: string, png: Buffer): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await writeFile(join(EVIDENCE_DIR, `${name}.png`), png)
}
