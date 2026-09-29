// The HUD panel over the fixture day, through the real page and the real server: the status bar,
// the selected agent's card, the task timeline with its model change, the session log and its
// filters, the rooms the adapters put agents in, and the panel collapsing. The day's picture is
// written to test-results/day/ for the operator to look at.

import { expect, test, type Page } from '@playwright/test'
import { DAY_HELPER, S, saveDayEvidence, startDay } from './day.js'

// the seven sessions and the builder's Explore helper
const AGENTS = 8

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
    await expect(agentButton(page, S.s1)).toHaveAttribute('data-room', 'lobby')
    await expect(agentButton(page, S.s5)).toHaveAttribute('data-room', 'lobby')
    await expect(agentButton(page, S.s0)).toHaveAttribute('data-state', 'running')
    await expect(agentButton(page, S.s3)).toHaveAttribute('data-state', 'waiting_permission')
    await expect(page.locator(`button.office-agent[data-kind="stool"]`)).toHaveCount(1)
    expect(DAY_HELPER).toMatch(/^fx/)
  } finally {
    await stop()
  }
})

test('the panel collapses and comes back, and the office does not change size', async ({ page }) => {
  const stop = await openDay(page)
  try {
    const canvas = page.locator('canvas.office-canvas')
    await expect(canvas).toHaveAttribute('data-scale', '2')
    await expect(page.locator('#hud')).toBeVisible()
    await page.locator('#hud-toggle').click()
    await expect(page.locator('#hud')).toBeHidden()
    await expect(page.locator('#hud-toggle')).toHaveText('Show panel')
    await expect(canvas).toBeVisible()
    await expect(canvas).toHaveAttribute('data-scale', '2')
    await page.locator('#hud-toggle').click()
    await expect(page.locator('#hud')).toBeVisible()
    await expect(canvas).toHaveAttribute('data-scale', '2')
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
