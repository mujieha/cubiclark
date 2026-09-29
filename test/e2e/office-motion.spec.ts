// Reduced motion (design §6: "every state has a reduced-motion rendering"): with the OS setting
// on, the office draws each frame once when the world changes and then nothing moves. And the 16
// states must still be told apart with every animation off.

import { createHash } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { worldSessionId } from '../../scripts/world-fixture-lib.js'
import { AGENT_STATES } from '../../src/core/types.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'

async function frames(canvas: Locator): Promise<number> {
  return Number((await canvas.getAttribute('data-frames')) ?? 0)
}

async function drawnOnce(canvas: Locator): Promise<void> {
  await expect.poll(() => frames(canvas)).toBeGreaterThan(0)
}

async function cropAround(page: Page, agentId: string): Promise<Buffer> {
  const box = await page.locator(`button.office-agent[data-agent-id="${agentId}"]`).boundingBox()
  if (!box) throw new Error(`no box for ${agentId}`)
  return page.screenshot({ clip: { x: box.x - 8, y: box.y - 8, width: box.width + 176, height: box.height + 16 } })
}

test.describe('reduced motion', () => {
  test('renders without animation: no frames after it settles, and the picture never changes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('all-states'))
      const canvas = page.locator('canvas.office-canvas')
      await drawnOnce(canvas)
      await expect(canvas).toHaveAttribute('data-reduced-motion', 'true')

      await page.waitForTimeout(300)
      const settled = await frames(canvas)
      const first = await canvas.screenshot()
      await page.waitForTimeout(1500)
      expect(await frames(canvas)).toBe(settled)
      const second = await canvas.screenshot()
      expect(second.equals(first)).toBe(true)

      await saveEvidence('all-states-reduced', second)
      expect(second).toMatchSnapshot('all-states-reduced.png')
    } finally {
      await cli.stop()
    }
  })

  test('with motion on, the office animates', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('all-states'))
      const canvas = page.locator('canvas.office-canvas')
      await drawnOnce(canvas)
      await expect(canvas).toHaveAttribute('data-reduced-motion', 'false')
      const before = await frames(canvas)
      await page.waitForTimeout(600)
      expect(await frames(canvas)).toBeGreaterThan(before + 8)
    } finally {
      await cli.stop()
    }
  })

  test('switching the preference while the page is open stops, and restarts, the animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('all-states'))
      const canvas = page.locator('canvas.office-canvas')
      await drawnOnce(canvas)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(canvas).toHaveAttribute('data-reduced-motion', 'true')
      await page.waitForTimeout(300)
      const settled = await frames(canvas)
      await page.waitForTimeout(800)
      expect(await frames(canvas)).toBe(settled)

      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect(canvas).toHaveAttribute('data-reduced-motion', 'false')
      await page.waitForTimeout(500)
      expect(await frames(canvas)).toBeGreaterThan(settled + 5)
    } finally {
      await cli.stop()
    }
  })

  test('the 16 states are still pairwise different with every animation off', async ({ browser }) => {
    test.setTimeout(120_000)
    const hashes = new Map<string, string[]>()
    for (const state of AGENT_STATES) {
      const context = await browser.newContext({ reducedMotion: 'reduce' })
      const page = await context.newPage()
      const cli = await openWithFakeWorld(page)
      try {
        await pushWorld(page, await loadWorld(`state-${state}`))
        await drawnOnce(page.locator('canvas.office-canvas'))
        await page.waitForTimeout(150)
        const crop = await cropAround(page, worldSessionId(1))
        await saveEvidence(`state-${state}-reduced`, crop)
        const hash = createHash('sha256').update(crop).digest('hex')
        hashes.set(hash, [...(hashes.get(hash) ?? []), state])
      } finally {
        await cli.stop()
        await context.close()
      }
    }
    const twins = [...hashes.values()].filter((states) => states.length > 1)
    expect(twins, `states that render identically in reduced motion: ${JSON.stringify(twins)}`).toEqual([])
    expect(hashes.size).toBe(AGENT_STATES.length)
  })
})
