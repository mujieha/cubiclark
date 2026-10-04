// `cubiclark replay --since 3h` over the fixture day, on the real clock: the page's replay clock
// runs at 10x, and an agent whose first record is 10 s into the window arrives about a second in.
// The rest of the playback (the whole window, the end state) is test/replay-server.test.ts.

import { expect, test, type Page } from '@playwright/test'
import { S, startDay } from './day.js'

const clockOf = async (page: Page): Promise<number> => Date.parse((await page.locator('#hud-status').getAttribute('data-clock')) ?? '')

test('the replay clock runs at 10x, and the ad hoc session arrives 10 s of replay in', async ({ page }) => {
  const cli = await startDay(['--since', '3h'], ['replay'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('#hud-status [data-segment="replay"]')).toContainText('replay 10×')
    await expect(page.locator('#hud-status [data-segment="replay"]')).toContainText(/\d\d:\d\d:\d\dZ/)
    await expect(page.locator('button.office-agent').first()).toBeVisible()

    // S6's first record is at 15:00:00, ten seconds after the window opens (14:59:50): about a second
    await expect(page.locator(`button.office-agent[data-agent-id="${S.s6}"]`)).toBeAttached({ timeout: 5000 })

    // 3 real seconds later the replay clock is about 30 s further on (the page hears every 250 ms)
    const first = await clockOf(page)
    await page.waitForTimeout(3000)
    const second = await clockOf(page)
    const advanced = (second - first) / 1000
    expect(advanced, `replay seconds in 3 real seconds: ${advanced}`).toBeGreaterThanOrEqual(20)
    expect(advanced, `replay seconds in 3 real seconds: ${advanced}`).toBeLessThanOrEqual(45)

    // it is a replay of the day: the window opened at 14:59:50 and has not reached the end
    expect(first).toBeGreaterThanOrEqual(Date.parse('2026-01-16T14:59:50Z'))
    expect(second).toBeLessThan(Date.parse('2026-01-16T17:59:50Z'))
    await expect(page.locator('#hud-status [data-segment="replay"]')).not.toContainText('done')
  } finally {
    await cli.stop()
  }
})

test('the tasks and the quota in the panel are those of the replay clock, not of the end of the day', async ({ page }) => {
  const cli = await startDay(['--since', '3h'], ['replay'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('#hud-status [data-segment="replay"]')).toBeVisible()
    // shop-cart is dispatched at 17:20: not yet, so it is not among the tasks to choose from
    await expect(page.locator('#hud-timeline-task option')).toHaveText(['auto', 'demo-docs', 'demo-login', 'demo-search', 'shop-export'])
    await expect(page.locator('#hud-status [data-segment="quota"]')).toHaveText(/^5h \d+% · 7d 3\d%$/)
    await expect(page.locator('#hud-status [data-segment="sources"]')).not.toContainText('claude agents')
  } finally {
    await cli.stop()
  }
})
