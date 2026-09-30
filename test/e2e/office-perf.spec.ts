// 50 agents (design §7: "readable up to ~50") and 100 (phase 5: "100 agents stay at 30 fps or better")
// must render at 30 fps or better. Real clock, real requestAnimationFrame, motion on: the loop reports
// its own frame rate and the cost of a draw on the canvas, and the test counts frames from the outside
// as a second opinion.

import { expect, test } from '@playwright/test'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'

for (const [name, agents] of [
  ['crowd-50', 50],
  ['crowd-100', 100],
] as const) {
  test(`${agents} agents render at 30 fps or better, and a draw costs a fraction of a frame`, async ({ page }) => {
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
