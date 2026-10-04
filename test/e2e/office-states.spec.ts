// Design §6, drawn: every one of the 16 states from a fixture world, compared with a committed
// baseline, and then all 16 compared with each other, because "two different situations never
// render the same way" (design §3.1) is a claim about pixels. The page clock is paused, so an
// animation is at an exact frame and a baseline is exactly reproducible.

import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { worldSessionId } from '../../scripts/world-fixture-lib.js'
import { AGENT_STATES } from '../../src/core/types.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'

const CLOCK_AT = '2026-01-15T10:30:00.000Z'

/** The agent's seat, with room around it for a wide bubble and a helper on its stool. */
async function cropAround(page: Page, agentId: string): Promise<Buffer> {
  const box = await page.locator(`button.office-agent[data-agent-id="${agentId}"]`).boundingBox()
  if (!box) throw new Error(`no box for ${agentId}`)
  return page.screenshot({ clip: { x: box.x - 8, y: box.y - 8, width: box.width + 176, height: box.height + 16 } })
}

test.describe('the 16 states', () => {
  test.setTimeout(120_000)

  test('each state renders against its baseline, and no two states render alike', { tag: '@pixels' }, async ({ browser }) => {
    const seen = new Map<string, string>()
    for (const state of AGENT_STATES) {
      // A fresh context per state: each gets its own paused clock, starting from the same instant.
      const context = await browser.newContext()
      const page = await context.newPage()
      // Compared with a pre-Morty baseline: Morty off.
      const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT, mascot: false })
      try {
        await pushWorld(page, await loadWorld(`state-${state}`), 400)
        const crop = await cropAround(page, worldSessionId(1))
        await saveEvidence(`state-${state}`, crop)
        expect.soft(crop, `state ${state}`).toMatchSnapshot(`state-${state}.png`)
        seen.set(state, createHash('sha256').update(crop).digest('hex'))
      } finally {
        await cli.stop()
        await context.close()
      }
    }

    // Pairwise different: name any two states that came out identical.
    const byHash = new Map<string, string[]>()
    for (const [state, hash] of seen) byHash.set(hash, [...(byHash.get(hash) ?? []), state])
    const twins = [...byHash.values()].filter((states) => states.length > 1)
    expect(twins, `states that render identically: ${JSON.stringify(twins)}`).toEqual([])
    expect(seen.size).toBe(AGENT_STATES.length)
  })
})

test('all 16 states in one office, against a baseline', { tag: '@pixels' }, async ({ page }) => {
  // Compared with a pre-Morty baseline: Morty off.
  const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT, mascot: false })
  try {
    await pushWorld(page, await loadWorld('all-states'), 400)
    const canvas = page.locator('canvas.office-canvas')
    await saveEvidence('all-states', await canvas.screenshot())
    await expect(canvas).toHaveScreenshot('all-states.png')
  } finally {
    await cli.stop()
  }
})
