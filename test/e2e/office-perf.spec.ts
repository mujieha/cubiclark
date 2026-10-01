// 50 agents (design §7: "readable up to ~50") and 100 (phase 5: "100 agents stay at 30 fps or better")
// must render at 30 fps or better. Real clock, real requestAnimationFrame, motion on: the loop reports
// its own frame rate and the cost of a draw on the canvas, and the test counts frames from the outside
// as a second opinion.

import { expect, test, type Page } from '@playwright/test'
import { MAX_BACKING_AREA_PX, MAX_BACKING_SIDE_PX } from '../../src/core/office/geometry.js'
import type { World } from '../../src/core/types.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'
import { canvasSize, LONG_TASKS, longTasksSince, pageNow, pushEverySecond, textCanvasSize } from './perf.js'

// The quiet office (cubiclark-quiet-office). A real home builds up a crowd like crowd-250-idle over a
// day, and the page once froze for a minute at a time on one. It must not: with the defaults the office
// holds the 49 agents that matter, and the page keeps 30 fps and never blocks for over 200 ms while the
// World is pushed once a second for 30 s (as the real server does).
const LONG_TASK_LIMIT_MS = 200

test('crowd-250-idle: 49 of 250 in view, 30 fps or better, and no long task over 200 ms in 30 s of updates', async ({ page }) => {
  test.setTimeout(120_000)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(LONG_TASKS)
  const cli = await openWithFakeWorld(page)
  try {
    const world = await loadWorld('crowd-250-idle')
    const canvas = page.locator('canvas.office-canvas')
    const startedAt = await pageNow(page)
    await pushWorld(page, world)
    await expect(page.locator('button.office-agent')).toHaveCount(49)
    await expect(canvas).toHaveAttribute('data-actors', '49')
    await expect(canvas).not.toHaveAttribute('data-mascot', 'off')

    await page.waitForTimeout(2000)
    const framesBefore = Number(await canvas.getAttribute('data-frames'))
    const timeBefore = Date.now()
    await pushEverySecond(page, world, 30)
    const framesAfter = Number(await canvas.getAttribute('data-frames'))
    const measured = (framesAfter - framesBefore) / ((Date.now() - timeBefore) / 1000)

    const fps = Number(await canvas.getAttribute('data-fps'))
    const p95 = Number(await canvas.getAttribute('data-draw-p95'))
    const longTasks = await longTasksSince(page, startedAt)
    console.log(
      `office perf: crowd-250-idle 49 shown, loop fps ${fps}, counted ${measured.toFixed(1)} fps, draw p95 ${p95} ms, canvas ${await canvasSize(page)}, long tasks ${JSON.stringify(longTasks.slice(0, 8))} (${longTasks.length} in all)`
    )
    await saveEvidence('crowd-250-idle', await canvas.screenshot())

    expect(await canvas.getAttribute('data-actors')).toBe('49')
    expect(fps, 'the loop reports at least 30 fps').toBeGreaterThanOrEqual(30)
    expect(measured, 'counted from outside, within a frame of 30').toBeGreaterThanOrEqual(29)
    expect(longTasks[0] ?? 0, `the longest of ${longTasks.length} long tasks`).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS)
  } finally {
    await cli.stop()
  }
})

// The same crowd with every idle session given a desk (--idle-desks 1000): 244 agents. On the real
// home that froze the page, the agents nobody had ever updated had no project, so all of them sat in
// one cluster and the office was over 300 rows tall. The idle sessions here have no project either.
// Run at the display's own density as well as at 1x, since the canvas's backing store grows with both.
async function unfilteredCrowd(page: Page): Promise<void> {
  test.setTimeout(120_000)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(LONG_TASKS)
  const cli = await openWithFakeWorld(page, { args: ['--idle-desks', '1000'] })
  try {
    const crowd = await loadWorld('crowd-250-idle')
    const world: World = {
      ...crowd,
      agents: Object.fromEntries(Object.entries(crowd.agents).map(([id, agent]) => [id, agent.state === 'waiting_user' ? { ...agent, project: '' } : agent])),
    }
    const canvas = page.locator('canvas.office-canvas')
    const startedAt = await pageNow(page)
    await pushWorld(page, world)
    await expect(page.locator('button.office-agent')).toHaveCount(244)
    await page.waitForTimeout(2000)
    const framesBefore = Number(await canvas.getAttribute('data-frames'))
    const timeBefore = Date.now()
    await pushEverySecond(page, world, 10)
    const measured = (Number(await canvas.getAttribute('data-frames')) - framesBefore) / ((Date.now() - timeBefore) / 1000)
    const longTasks = await longTasksSince(page, startedAt)
    console.log(
      `office perf: crowd-250-idle unfiltered, 244 shown, rows ${await canvas.getAttribute('data-rows')}, counted ${measured.toFixed(1)} fps, canvas ${await canvasSize(page)}, text canvas ${await textCanvasSize(page)}, long tasks ${JSON.stringify(longTasks.slice(0, 8))} (${longTasks.length} in all)`
    )
    expect(longTasks[0] ?? 0, `the longest of ${longTasks.length} long tasks`).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS)
    // The canvas stays under what a GPU keeps a canvas in (src/core/office/geometry.ts backingScale):
    // at twice the density this office, 329 rows, was 21056 px tall and ran at 21 fps with 50 to 85 ms tasks.
    const [, height] = (await canvasSize(page)).split('x').map(Number)
    expect(height, 'the canvas is not taller than a GPU texture').toBeLessThanOrEqual(MAX_BACKING_SIDE_PX)
    // The words are on a canvas of their own, at the display's density: it stays inside the same limits.
    const [textWidth, textHeight] = (await textCanvasSize(page)).split('x').map(Number) as [number, number]
    expect(textWidth, 'the text canvas is not wider than a GPU texture').toBeLessThanOrEqual(MAX_BACKING_SIDE_PX)
    expect(textHeight, 'the text canvas is not taller than a GPU texture').toBeLessThanOrEqual(MAX_BACKING_SIDE_PX)
    expect(textWidth * textHeight, 'nor bigger in all than the limit').toBeLessThanOrEqual(MAX_BACKING_AREA_PX)
    expect(measured, 'counted from outside').toBeGreaterThanOrEqual(24)
  } finally {
    await cli.stop()
  }
}

test('crowd-250-idle with every idle session at a desk (244 agents, 1x): no long task over 200 ms', async ({ page }) => {
  await unfilteredCrowd(page)
})

test.describe('on a display of twice the density', () => {
  test.use({ deviceScaleFactor: 2 })
  test('crowd-250-idle with every idle session at a desk (244 agents, 2x): no long task over 200 ms', async ({ page }) => {
    await unfilteredCrowd(page)
  })
})

// The number of agents each fixture puts in view (src/core/visible.js): crowd-50 and crowd-100 each
// have departed agents past their 10 minutes, which are not drawn (46 and 91 of 50 and 100).
for (const [name, agents] of [
  ['crowd-50', 46],
  ['crowd-100', 91],
] as const) {
  test(`${name}: ${agents} agents in view render at 30 fps or better, and a draw costs a fraction of a frame`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld(name))
      const canvas = page.locator('canvas.office-canvas')
      await expect(page.locator('button.office-agent')).toHaveCount(agents)
      await expect(canvas).toHaveAttribute('data-actors', String(agents))
      // Morty is in the office while it is measured: he is on by default, and costs a frame nothing it cannot spare.
      await expect(canvas).not.toHaveAttribute('data-mascot', 'off')

      // Let the loop run and the loop's own statistics fill their 90-frame window.
      await page.waitForTimeout(3000)
      const framesBefore = Number(await canvas.getAttribute('data-frames'))
      const startedAt = Date.now()
      await page.waitForTimeout(2000)
      const framesAfter = Number(await canvas.getAttribute('data-frames'))
      const seconds = (Date.now() - startedAt) / 1000
      const measured = (framesAfter - framesBefore) / seconds

      // The statistics refresh once a second; wait for one that covers a full window.
      await page.waitForTimeout(1100)
      const fps = Number(await canvas.getAttribute('data-fps'))
      const p95 = Number(await canvas.getAttribute('data-draw-p95'))
      console.log(`office perf: ${agents} agents, loop fps ${fps}, counted ${measured.toFixed(1)} fps, draw p95 ${p95} ms`)

      await saveEvidence(name, await canvas.screenshot())

      expect(fps, 'the loop reports at least 30 fps').toBeGreaterThanOrEqual(30)
      expect(measured, 'counted from outside, within a frame of 30').toBeGreaterThanOrEqual(29)
      expect(p95, 'a draw takes well under half of the 33 ms frame budget').toBeLessThanOrEqual(16)
      expect(await canvas.getAttribute('data-actors')).toBe(String(agents))
    } finally {
      await cli.stop()
    }
  })
}
