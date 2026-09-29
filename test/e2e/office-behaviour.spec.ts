// What the office does, not just how it looks: arrivals walk in from the door, a subagent walks to
// its parent, departures walk out to the board, the keyboard walks the agents, hovering says who
// is who, the toggle swaps views, and the four empty screens are four different rooms.

import { createHash } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { worldSessionId as s, worldSubagentId as sub } from '../../scripts/world-fixture-lib.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'

const CLOCK_AT = '2026-01-15T10:30:00.000Z'
const TILE_PX = 16

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox()
  if (!found) throw new Error('element has no box')
  return found
}

const agentButton = (page: Page, id: string): Locator => page.locator(`button.office-agent[data-agent-id="${id}"]`)
const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

async function scale(page: Page): Promise<number> {
  return Number(await page.locator('canvas.office-canvas').getAttribute('data-scale'))
}

test.describe('transitions', () => {
  test('a new builder walks in from the door, a subagent walks to its parent, and both end up seated', async ({ page }) => {
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
    try {
      await pushWorld(page, await loadWorld('arrive-before'), 200)
      const parentBefore = await box(agentButton(page, s(1)))
      await pushWorld(page, await loadWorld('arrive-after'), 50)

      // Just after the update, the newcomer is at the door: the bottom-left corner of the office.
      const canvas = await box(page.locator('canvas.office-canvas'))
      const px = (await scale(page)) * TILE_PX
      const newcomer = centre(await box(agentButton(page, s(2))))
      expect(newcomer.x - canvas.x, 'near the hallway').toBeLessThan(3 * px)
      expect(canvas.y + canvas.height - newcomer.y, 'near the bottom wall').toBeLessThan(4 * px)
      const helperNow = centre(await box(agentButton(page, sub(1))))
      expect(helperNow.x - canvas.x, 'the subagent also starts at the door').toBeLessThan(3 * px)

      // Five seconds later everyone has arrived: the builder at a desk, the subagent on the stool beside its parent.
      await page.clock.runFor(5000)
      const seated = await box(agentButton(page, s(2)))
      expect(seated.width, 'a desk box, not a walking box').toBe(3 * px)
      await expect(agentButton(page, s(2))).toHaveAttribute('data-kind', 'desk')

      const helper = await box(agentButton(page, sub(1)))
      const parent = await box(agentButton(page, s(1)))
      await expect(agentButton(page, sub(1))).toHaveAttribute('data-kind', 'stool')
      expect(parent, 'the parent did not move').toEqual(parentBefore)
      expect(helper.x, 'the stool is right beside the parent desk').toBe(parent.x + parent.width)
      expect(centre(helper).y).toBeGreaterThanOrEqual(parent.y)
      expect(centre(helper).y).toBeLessThanOrEqual(parent.y + parent.height)
    } finally {
      await cli.stop()
    }
  })

  test('an agent that finished walks out from its desk to the lobby board', async ({ page }) => {
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
    try {
      await pushWorld(page, await loadWorld('depart-before'), 200)
      const before = await box(agentButton(page, s(2)))
      const other = await box(agentButton(page, s(1)))
      const px = (await scale(page)) * TILE_PX

      await pushWorld(page, await loadWorld('depart-after'), 50)
      await expect(agentButton(page, s(2))).toHaveAttribute('data-state', 'finished')
      // Still near its desk a moment after the update: walking, not teleporting.
      const walking = centre(await box(agentButton(page, s(2))))
      expect(Math.abs(walking.y - centre(before).y), 'still in the floor area').toBeLessThan(2 * px)

      await page.clock.runFor(5000)
      await expect(agentButton(page, s(2))).toHaveAttribute('data-room', 'lobby')
      await expect(agentButton(page, s(2))).toHaveAttribute('data-kind', 'board')
      const tag = await box(agentButton(page, s(2)))
      expect(tag.width, 'a board tag tile').toBe(px)
      expect(tag.y, 'below every desk on the floor').toBeGreaterThan(other.y + other.height)
      expect(await box(agentButton(page, s(1))), 'the agent that stayed did not move').toEqual(other)
    } finally {
      await cli.stop()
    }
  })
})

test.describe('the keyboard, the mouse and the toggle', () => {
  test('Tab walks the agents in reading order, shows their tooltip and rings them; Escape dismisses it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('rooms'))
      const canvas = page.locator('canvas.office-canvas')
      await expect(page.locator('button.office-agent')).toHaveCount(20)
      await page.waitForTimeout(200)
      const unfocused = await canvas.screenshot()

      await page.locator('#view-toggle').focus()
      await page.keyboard.press('Tab')
      await expect(agentButton(page, s(1))).toBeFocused()
      const tooltip = page.locator('#office-tooltip')
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toContainText('waiting for you')
      await expect(tooltip).toContainText('claude-opus-5-5')
      await page.waitForTimeout(200)
      expect((await canvas.screenshot()).equals(unfocused), 'the focused agent is ringed on the canvas').toBe(false)

      await page.keyboard.press('Tab')
      await expect(agentButton(page, s(2))).toBeFocused()
      await expect(tooltip).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(tooltip).toBeHidden()
    } finally {
      await cli.stop()
    }
  })

  test('hovering an agent names it, its state and its model', async ({ page }) => {
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('rooms'))
      await expect(page.locator('button.office-agent')).toHaveCount(20)
      const tooltip = page.locator('#office-tooltip')
      await expect(tooltip).toBeHidden()
      await agentButton(page, sub(1)).hover()
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toContainText('code-reviewer')
      await expect(tooltip).toContainText('reading')
      await expect(tooltip).toContainText('Read index.ts')
      await page.mouse.move(2, 2)
      await expect(tooltip).toBeHidden()
    } finally {
      await cli.stop()
    }
  })

  test('the toggle swaps the office and the list, and the URL hash remembers which', async ({ page }) => {
    const cli = await openWithFakeWorld(page, { hash: '#list' })
    try {
      await pushWorld(page, await loadWorld('rooms'))
      await expect(page.locator('#list-view')).toBeVisible()
      await expect(page.locator('#office-view')).toBeHidden()
      await expect(page.locator('#list-view tbody tr')).toHaveCount(20)
      const toggle = page.locator('#view-toggle')
      await expect(toggle).toHaveText('Office view')
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')

      // While the list is showing, the office is not drawing.
      const canvas = page.locator('canvas.office-canvas')
      const frames = Number(await canvas.getAttribute('data-frames'))
      await page.waitForTimeout(500)
      expect(Number(await canvas.getAttribute('data-frames'))).toBe(frames)

      await toggle.click()
      await expect(page.locator('#office-view')).toBeVisible()
      await expect(page.locator('#list-view')).toBeHidden()
      expect(new URL(page.url()).hash).toBe('#office')
      await expect(toggle).toHaveText('List view')
      await expect(toggle).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(async () => Number(await canvas.getAttribute('data-frames'))).toBeGreaterThan(frames)

      await toggle.click()
      expect(new URL(page.url()).hash).toBe('#list')
      await expect(page.locator('#list-view')).toBeVisible()
    } finally {
      await cli.stop()
    }
  })
})

test('the rooms, as one picture', async ({ page }) => {
  const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
  try {
    await pushWorld(page, await loadWorld('rooms'), 400)
    const canvas = page.locator('canvas.office-canvas')
    await saveEvidence('rooms', await canvas.screenshot())
    await expect(canvas).toHaveScreenshot('rooms.png')
  } finally {
    await cli.stop()
  }
})

test.describe('the four empty screens', () => {
  const SCREENS = [
    ['empty-starting', 'no-data'],
    ['empty-unreadable', 'unreadable'],
    ['empty-no-collector', 'no-collector'],
    ['empty-no-agents', 'no-agents'],
  ] as const

  test('are four different rooms with four different messages', async ({ browser }) => {
    test.setTimeout(60_000)
    const pictures = new Map<string, string>()
    const messages = new Set<string>()
    for (const [world, screen] of SCREENS) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
      try {
        await pushWorld(page, await loadWorld(world), 200)
        const empty = page.locator('[data-empty]')
        await expect(empty).toHaveAttribute('data-empty', screen)
        await expect(empty).toBeVisible()
        messages.add((await empty.innerText()).trim())

        const canvas = page.locator('canvas.office-canvas')
        await expect(canvas).toHaveAttribute('data-scene', screen)
        await expect(canvas).toHaveAttribute('data-actors', '0')
        const picture = await canvas.screenshot()
        await saveEvidence(`empty-${screen}`, picture)
        expect.soft(picture, screen).toMatchSnapshot(`empty-${screen}.png`)
        pictures.set(screen, createHash('sha256').update(picture).digest('hex'))
        // Nobody is in it: no agent buttons at all.
        await expect(page.locator('button.office-agent')).toHaveCount(0)
      } finally {
        await cli.stop()
        await context.close()
      }
    }
    expect(new Set(pictures.values()).size, 'four different pictures').toBe(4)
    expect(messages.size, 'four different messages').toBe(4)
  })

  test('before the first snapshot arrives the page already shows the no-data screen', async ({ page }) => {
    const cli = await openWithFakeWorld(page)
    try {
      await expect(page.locator('[data-empty]')).toHaveAttribute('data-empty', 'no-data')
      await expect(page.locator('canvas.office-canvas')).toHaveAttribute('data-scene', 'no-data')
    } finally {
      await cli.stop()
    }
  })

  test('the office fills up when agents appear after an empty start', async ({ page }) => {
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
    try {
      await pushWorld(page, await loadWorld('empty-no-agents'), 100)
      await expect(page.locator('[data-empty]')).toHaveAttribute('data-empty', 'no-agents')
      await pushWorld(page, await loadWorld('state-thinking'), 100)
      await expect(page.locator('[data-empty]')).toBeHidden()
      await expect(page.locator('canvas.office-canvas')).toHaveAttribute('data-scene', 'office')
      await expect(page.locator('button.office-agent')).toHaveCount(1)
      // The first agent after an empty office walks in through the door.
      const canvas = await box(page.locator('canvas.office-canvas'))
      const px = (await scale(page)) * TILE_PX
      const walker = centre(await box(agentButton(page, s(1))))
      expect(canvas.y + canvas.height - walker.y).toBeLessThan(4 * px)
    } finally {
      await cli.stop()
    }
  })
})
