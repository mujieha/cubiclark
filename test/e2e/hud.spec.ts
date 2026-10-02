// The HUD panel over the fixture day, through the real page and the real server: the status bar,
// the selected agent's card, the task timeline with its model change, the session log and its
// filters, the rooms the adapters put agents in, and the panel collapsing. The day's picture is
// written to test-results/day/ for the operator to look at.

import { expect, test, type Page } from '@playwright/test'
import { DAY_HELPER, S, saveDayEvidence, startDay } from './day.js'

// the seven sessions and the builder's Explore helper, less s1 and s5: both ended long before the
// day's end, past the 10 minutes a finished agent stays in view (src/core/visible.ts)
const AGENTS = 6

const agentButton = (page: Page, id: string) => page.locator(`button.office-agent[data-agent-id="${id}"]`)
const segment = (page: Page, id: string) => page.locator(`#hud-status [data-segment="${id}"]`)

async function openDay(page: Page): Promise<() => Promise<void>> {
  const cli = await startDay()
  await page.goto(cli.url)
  await expect(page.locator('button.office-agent')).toHaveCount(AGENTS)
  await expect(segment(page, 'sources')).toContainText('claude agents')
  return cli.stop
}

test('the status bar: sources, busy agents, permission waits, quota and diagnostics', async ({ page }) => {
  const stop = await openDay(page)
  try {
    await expect(segment(page, 'sources')).toHaveText('transcripts live · hooks live · tasks 5 · quota · claude agents')
    await expect(segment(page, 'quota')).toHaveText('5h 62% · 7d 40%')
    await expect(segment(page, 'permission')).toHaveText('permission 1')
    await expect(segment(page, 'agents')).toContainText('busy ')
    // the two agents that ended hours ago are not in view, and the status bar says so
    await expect(segment(page, 'hidden')).toHaveText('2 finished not shown')
    await expect(page.locator('.office-status')).toContainText('2 finished not shown')
    await expect(segment(page, 'diagnostics')).toHaveText('unparsed 0')
    await expect(segment(page, 'replay')).toHaveCount(0)
    // the world's clock, for the replay spec to read the same way
    await expect(page.locator('#hud-status')).toHaveAttribute('data-clock', '2026-01-16T17:59:50.000Z')
  } finally {
    await stop()
  }
})

test('an agent selected in the office: its card, and its task on the timeline with the model change', async ({ page }) => {
  const stop = await openDay(page)
  try {
    await expect(page.locator('#hud-card')).toContainText('Select an agent')
    await agentButton(page, S.s2).click()
    const card = page.locator('#hud-card')
    await expect(card).toContainText('claude-sonnet-5-5')
    await expect(card).toContainText('builder')
    await expect(card).toContainText('high')
    await expect(card).toContainText('demo-login · building')
    await expect(card).toContainText('demo-worker')
    await expect(agentButton(page, S.s2)).toHaveAttribute('aria-pressed', 'true')

    const timeline = page.locator('#hud-timeline')
    await expect(timeline.locator('li[data-stage="building"]')).toHaveAttribute('data-state', 'current')
    await expect(timeline.locator('li[data-stage="planning"]')).toHaveAttribute('data-state', 'past')
    await expect(timeline.locator('li[data-stage="review"]')).toHaveAttribute('data-state', 'future')
    await expect(timeline.locator('.model-change')).toHaveText('opus → sonnet')
    await expect(timeline.locator('li[data-kind="forked"]')).toContainText('forked after 1 compaction')

    // clicking it again clears the selection
    await agentButton(page, S.s2).click()
    await expect(card).toContainText('Select an agent')
    await expect(agentButton(page, S.s2)).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await stop()
  }
})

test('selecting from the list selects in the office, and the CLI\'s permission wait shows on the card', async ({ page }) => {
  const stop = await openDay(page)
  try {
    await page.evaluate(() => {
      location.hash = '#list'
    })
    const row = page.locator(`#list-view tbody tr[data-agent-id="${S.s3}"]`)
    await expect(row).toBeVisible()
    await row.click()
    await expect(row).toHaveAttribute('aria-current', 'true')
    const card = page.locator('#hud-card')
    await expect(card).toContainText('00000005 shop-planner')
    await expect(card).toContainText('waiting for permission')
    await expect(card).toContainText('blocked · waiting · permission prompt')
    await expect(card).toContainText('shop-cart · planning')

    // the same agent is the pressed one in the office
    await page.evaluate(() => {
      location.hash = '#office'
    })
    await expect(agentButton(page, S.s3)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#hud-timeline li[data-stage="planning"]')).toHaveAttribute('data-state', 'current')
  } finally {
    await stop()
  }
})

test('the session log follows the task filter, and a row selects its agent', async ({ page }) => {
  const stop = await openDay(page)
  try {
    const rows = page.locator('#hud-log .hud-log-row')
    await expect(rows.first()).toBeVisible()
    const all = await rows.count()

    await page.locator('#hud-log-task').selectOption('demo-login')
    await expect(page.locator('#hud-log-task')).toHaveValue('demo-login')
    const ids = await page.locator('#hud-log .hud-log-row').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.agentId))
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(all)
    for (const id of ids) expect([S.s1, S.s2], `a demo-login row from ${id}`).toContain(id)

    await page.locator('#hud-log-task').selectOption('all')
    await page.locator('#hud-log-project').selectOption('shop')
    const shop = await page.locator('#hud-log .hud-log-row').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.agentId))
    expect(shop.length).toBeGreaterThan(0)
    for (const id of shop) expect([S.s3, S.s5]).toContain(id)

    await page.locator('#hud-log .hud-log-row').first().click()
    await expect(page.locator('#hud-card')).not.toContainText('Select an agent')
  } finally {
    await stop()
  }
})

test('the panel is too narrow for the event column: it is dropped, the result gets the room, and the tooltip has the whole row', async ({ page }) => {
  const stop = await openDay(page)
  try {
    const list = page.locator('#hud-log .hud-log-list')
    await expect(list).toHaveAttribute('data-columns', 'compact')
    const first = page.locator('#hud-log .hud-log-row').first()
    await expect(first.locator('.log-event')).toBeHidden()
    const event = await first.getAttribute('data-event')
    const result = await first.locator('.log-result').textContent()
    expect(event).toBeTruthy()
    expect(result).toBeTruthy()
    const title = await first.getAttribute('title')
    expect(title).toContain(` · ${event ?? ''} · `)
    expect(title).toContain(result ?? '')

    // Full width (the panel below the office in a narrow window): the event column comes back.
    await page.setViewportSize({ width: 1000, height: 1024 })
    await expect(list).toHaveAttribute('data-columns', 'full')
    await expect(first.locator('.log-event')).toBeVisible()
  } finally {
    await stop()
  }
})

test('the log is usable by keyboard: its scroll area and each row\'s agent take focus, and Enter selects that agent', async ({ page }) => {
  const stop = await openDay(page)
  try {
    const list = page.locator('#hud-log .hud-log-list')
    await expect(list).toHaveAttribute('tabindex', '0')
    await expect(list).toHaveAttribute('aria-label', 'Session log')
    const button = page.locator('#hud-log .hud-log-row .log-agent').first()
    const agentId = await page.locator('#hud-log .hud-log-row').first().getAttribute('data-agent-id')
    await button.focus()
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
    // selected exactly once: the row's own click handler did not select a second time (which would clear it)
    await expect(page.locator('#hud-card')).toHaveAttribute('data-agent-id', agentId ?? '')
    await expect(page.locator('#hud-card')).not.toContainText('Select an agent')
    // Space does the same on another row, and selects that one
    const other = page.locator('#hud-log .hud-log-row .log-agent').last()
    const otherId = await page.locator('#hud-log .hud-log-row').last().getAttribute('data-agent-id')
    await other.focus()
    await page.keyboard.press('Space')
    await expect(page.locator('#hud-card')).toHaveAttribute('data-agent-id', otherId ?? '')
    // a click on the button selects once too
    await page.locator('#hud-log .hud-log-row .log-agent').first().click()
    await expect(page.locator('#hud-card')).toHaveAttribute('data-agent-id', agentId ?? '')
  } finally {
    await stop()
  }
})

test('the rooms the adapters put agents in: orchestrator, planner, reviewer and builder', async ({ page }) => {
  const stop = await openDay(page)
  try {
    await expect(agentButton(page, S.s0)).toHaveAttribute('data-room', 'manager')
    await expect(agentButton(page, S.s3)).toHaveAttribute('data-room', 'planning')
    await expect(agentButton(page, S.s4)).toHaveAttribute('data-room', 'review')
    await expect(agentButton(page, S.s2)).toHaveAttribute('data-room', 'floor')
    // the two that ended hours ago would be on the lobby board; past their 10 minutes they are not in view
    await expect(agentButton(page, S.s1)).toHaveCount(0)
    await expect(agentButton(page, S.s5)).toHaveCount(0)
    await expect(agentButton(page, S.s0)).toHaveAttribute('data-state', 'running')
    await expect(agentButton(page, S.s3)).toHaveAttribute('data-state', 'waiting_permission')
    await expect(page.locator(`button.office-agent[data-kind="stool"]`)).toHaveCount(1)
    expect(DAY_HELPER).toMatch(/^fx/)
  } finally {
    await stop()
  }
})

test('the panel collapses and comes back, and the office fills the column each time', async ({ page }) => {
  const stop = await openDay(page)
  try {
    const canvas = page.locator('canvas.office-canvas')
    /** How much of its column the office uses, as the page lays it out now. */
    const widthUse = (): Promise<number> =>
      page.evaluate(() => {
        const art = document.querySelector('canvas.office-canvas') as HTMLCanvasElement
        const host = document.querySelector('.office-host') as HTMLElement
        return art.getBoundingClientRect().width / host.clientWidth
      })
    /** The text canvas is exactly over the art canvas: same place, same CSS size. */
    const textOverArt = (): Promise<boolean> =>
      page.evaluate(() => {
        const art = (document.querySelector('canvas.office-canvas') as HTMLCanvasElement).getBoundingClientRect()
        const text = (document.querySelector('canvas.office-text') as HTMLCanvasElement).getBoundingClientRect()
        return art.x === text.x && art.y === text.y && art.width === text.width && art.height === text.height
      })
    // 1600 px window, panel open: a 1172 px column, 32 px tiles, scale 2.
    await expect(canvas).toHaveAttribute('data-scale', '2')
    await expect.poll(widthUse).toBeGreaterThanOrEqual(0.9)
    await expect.poll(textOverArt).toBe(true)
    await expect(page.locator('#hud')).toBeVisible()
    await page.locator('#hud-toggle').click()
    await expect(page.locator('#hud')).toBeHidden()
    await expect(page.locator('#hud-toggle')).toHaveText('Show panel')
    await expect(canvas).toBeVisible()
    // Panel hidden: a 1568 px column, 43 px tiles. The office grew into it.
    await expect(canvas).toHaveAttribute('data-scale', String(43 / 16))
    await expect.poll(widthUse).toBeGreaterThanOrEqual(0.9)
    await expect.poll(textOverArt).toBe(true)
    await page.locator('#hud-toggle').click()
    await expect(page.locator('#hud')).toBeVisible()
    await expect(canvas).toHaveAttribute('data-scale', '2')
    await expect.poll(widthUse).toBeGreaterThanOrEqual(0.9)
    await expect.poll(textOverArt).toBe(true)
  } finally {
    await stop()
  }
})

test('the day, as a picture: three tasks mid-flight, the planning room occupied, the meter and whiteboard filled', async ({ page }) => {
  const stop = await openDay(page)
  try {
    await agentButton(page, S.s2).click()
    await expect(page.locator('#hud-timeline .model-change')).toHaveText('opus → sonnet')
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await saveDayEvidence('fixture-day', await page.screenshot({ fullPage: true }))
    await saveDayEvidence('fixture-day-office', await page.locator('canvas.office-canvas').screenshot())
    await saveDayEvidence('fixture-day-hud', await page.locator('#hud').screenshot())
  } finally {
    await stop()
  }
})
