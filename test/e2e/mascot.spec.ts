// Morty, the office corgi, on the real page. He wanders, naps, drinks and plays ball, each shown
// against a baseline; an agent playing with him is a different picture from one asking for a
// permission, and is still "waiting for you" in every word the page says; he is not an agent (no
// button, no row, no count); with reduced motion he is asleep in his basket and nothing moves.
// The page clock is paused, so he is at an exact frame and a baseline is exactly reproducible.

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { worldSessionId as s } from '../../scripts/world-fixture-lib.js'
import { DAY } from '../../src/core/theme/index.js'
import { hexToRgb } from '../../src/core/theme/colour.js'
import { loadWorld, openWithFakeWorld, pushWorld, saveEvidence } from './fake-world.js'
import { stopOnFailure } from './helpers.js'

test.setTimeout(180_000)

const CLOCK_AT = '2026-01-15T10:30:00.000Z'

interface Reading {
  activity: string
  phase: string
  withId: string
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const canvasOf = (page: Page): Locator => page.locator('canvas.office-canvas')
const agentButton = (page: Page, id: string): Locator => page.locator(`button.office-agent[data-agent-id="${id}"]`)

async function reading(page: Page): Promise<Reading> {
  const canvas = canvasOf(page)
  return {
    activity: (await canvas.getAttribute('data-mascot')) ?? '',
    phase: (await canvas.getAttribute('data-mascot-phase')) ?? '',
    withId: (await canvas.getAttribute('data-mascot-with')) ?? '',
  }
}

/** Lets page time pass, half a second at a time, until what Morty is doing matches. */
async function advanceUntil(page: Page, wanted: (r: Reading) => boolean, maxMs = 600_000): Promise<Reading> {
  let last: Reading = await reading(page)
  for (let waited = 0; waited <= maxMs; waited += 500) {
    last = await reading(page)
    if (wanted(last)) return last
    await page.clock.runFor(500)
  }
  throw new Error(`Morty never got there in ${maxMs} ms of page time; last seen ${JSON.stringify(last)}`)
}

/** How many canvas pixels inside `box` (page px) are exactly this colour. */
async function pixelsIn(page: Page, box: Box, hex: string): Promise<number> {
  const [r, g, b] = hexToRgb(hex)
  return page.evaluate(
    ({ box, r, g, b }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.office-canvas')
      const context = canvas?.getContext('2d')
      if (!canvas || !context) return -1
      const rect = canvas.getBoundingClientRect()
      const k = canvas.width / rect.width
      const data = context.getImageData(Math.round((box.x - rect.left) * k), Math.round((box.y - rect.top) * k), Math.round(box.width * k), Math.round(box.height * k)).data
      let count = 0
      for (let i = 0; i < data.length; i += 4) if (data[i] === r && data[i + 1] === g && data[i + 2] === b) count++
      return count
    },
    { box, r, g, b }
  )
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('no box')
  return box
}

/** A page with the Morty office on it, at the paused clock. */
async function openOffice(page: Page, mascot = true): Promise<{ stop: () => Promise<void> }> {
  const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT, mascot })
  // Before the caller's try: a failure here must stop the server itself.
  return stopOnFailure(cli, async () => {
    await pushWorld(page, await loadWorld('mascot-play'), 100)
    await expect(page.locator('button.office-agent')).toHaveCount(4)
    return cli
  })
}

async function withPage<T>(browser: Browser, mascot: boolean, run: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const cli = await openOffice(page, mascot)
  try {
    return await run(page)
  } finally {
    await cli.stop()
    await context.close()
  }
}

/** What the page says in words about the agents: the list, and the panel with `id` selected. */
async function words(page: Page, id: string): Promise<{ table: string; hud: string }> {
  await agentButton(page, id).click()
  await expect(page.locator('#hud-card')).toHaveAttribute('data-agent-id', id)
  return page.evaluate(() => ({
    table: document.querySelector('#list-view')?.textContent ?? '',
    hud: document.querySelector('#hud')?.textContent ?? '',
  }))
}

test.describe('Morty\'s day', () => {
  test('he naps, walks, drinks and plays ball, each against a baseline', { tag: '@pixels' }, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cli = await openOffice(page)
    try {
      const canvas = canvasOf(page)
      // He starts the day asleep in his basket.
      expect(await reading(page)).toMatchObject({ activity: 'nap', phase: 'stay', withId: '' })
      await saveEvidence('mascot-nap', await canvas.screenshot())
      await expect(canvas).toHaveScreenshot('mascot-nap.png')

      // Then whatever the seed deals: the first walk, a moment in.
      await advanceUntil(page, (r) => r.phase === 'walk')
      await page.clock.runFor(300)
      await saveEvidence('mascot-walk', await canvas.screenshot())
      await expect(canvas).toHaveScreenshot('mascot-walk.png')

      await advanceUntil(page, (r) => r.activity === 'drink' && r.phase === 'stay')
      await page.clock.runFor(300)
      await saveEvidence('mascot-drink', await canvas.screenshot())
      await expect(canvas).toHaveScreenshot('mascot-drink.png')

      const playing = await advanceUntil(page, (r) => r.activity === 'play' && r.phase === 'stay')
      expect(playing.withId).toBe(s(1))
      await page.clock.runFor(400)
      await saveEvidence('mascot-play', await canvas.screenshot())
      await expect(canvas).toHaveScreenshot('mascot-play.png')
    } finally {
      await cli.stop()
    }
  })
})

test.describe('playing is not a state', () => {
  test('an agent playing ball is not one asking for a permission: other pictures, amber not red, and in words still "waiting for you"', async ({ browser, page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cli = await openOffice(page)
    try {
      await advanceUntil(page, (r) => r.activity === 'play' && r.phase === 'stay' && r.withId === s(1))
      await page.clock.runFor(400)
      const player = await boxOf(agentButton(page, s(1)))
      const asker = await boxOf(agentButton(page, s(2)))
      const playerCrop = await page.screenshot({ clip: player })
      const askerCrop = await page.screenshot({ clip: asker })
      await saveEvidence('mascot-player', playerCrop)
      await saveEvidence('mascot-asker', askerCrop)
      expect(playerCrop.equals(askerCrop), 'the two desks look different').toBe(false)

      // The lamp says what the state says: amber for one, red for the other, and never the other's colour.
      // (Amber is also a hair colour, so the lamp is counted in its own 6x8 px, which sits at 37,29 of the desk's 48x48.)
      const lampOf = (desk: Box): Box => {
        const k = desk.width / 48
        return { x: desk.x + 37 * k, y: desk.y + 29 * k, width: 6 * k, height: 8 * k }
      }
      const amber = DAY.palette.b as string
      const red = DAY.palette.a as string
      expect(await pixelsIn(page, lampOf(player), amber), 'the player\'s lamp is amber').toBeGreaterThan(0)
      expect(await pixelsIn(page, lampOf(player), red), 'and not red').toBe(0)
      expect(await pixelsIn(page, lampOf(asker), red), 'the asker\'s lamp is red').toBeGreaterThan(0)
      expect(await pixelsIn(page, lampOf(asker), amber), 'and not amber').toBe(0)
      expect(await pixelsIn(page, player, red), 'nothing red anywhere at the player\'s desk: no bubble, no alert').toBe(0)

      // And in words: both are what the World says, and the list says the same.
      await expect(agentButton(page, s(1))).toHaveAttribute('data-state', 'waiting_user')
      await expect(agentButton(page, s(2))).toHaveAttribute('data-state', 'waiting_permission')
      const row = await page.evaluate((id) => document.querySelector(`#list-view tbody tr[data-agent-id="${id}"] td.state`)?.textContent ?? '', s(1))
      expect(await agentButton(page, s(1)).getAttribute('aria-label')).toContain(row)
      expect(row).toContain('waiting for you')

      // It is a different picture from the same desk with Morty off, where the agent sits and leans back.
      await withPage(browser, false, async (other) => {
        const off = await other.screenshot({ clip: await boxOf(agentButton(other, s(1))) })
        expect(off.equals(playerCrop), 'the throw pose is drawn only while he plays').toBe(false)
      })
    } finally {
      await cli.stop()
    }
  })
})

test.describe('Morty is not an agent', () => {
  test('no button, no row, no count; a label for the pointer; the list and the panel say exactly what they say without him', async ({ browser, page }) => {
    const cli = await openOffice(page)
    try {
      const canvas = canvasOf(page)
      await expect(page.locator('button.office-agent')).toHaveCount(4)
      await expect(canvas).toHaveAttribute('data-actors', '4')

      const marker = page.locator('.office-mascot')
      await expect(marker).toHaveCount(1)
      await expect(marker).toHaveAttribute('role', 'img')
      await expect(marker).toHaveAttribute('aria-label', 'Morty (mascot)')
      await expect(marker).not.toHaveAttribute('data-agent-id', /.*/)
      expect(await marker.evaluate((node) => node.tagName)).toBe('DIV')
      expect(await marker.evaluate((node) => node.getAttribute('tabindex'))).toBeNull()

      // He is asleep in the lobby, away from every desk: the pointer reaches him.
      const tip = page.locator('.office-mascot-tip')
      await expect(tip).toBeHidden()
      await marker.hover()
      await expect(tip).toBeVisible()
      await expect(tip).toHaveText('Morty (mascot)')
      await page.mouse.move(2, 2)
      await expect(tip).toBeHidden()

      // The table is built even while the office is showing: four agents, four rows.
      await expect(page.locator('#list-view tbody tr')).toHaveCount(4)
      const on = await words(page, s(1))
      expect(on.table).not.toContain('Morty')
      expect(on.hud).not.toContain('Morty')

      await withPage(browser, false, async (other) => {
        const off = await words(other, s(1))
        expect(on.table, 'the agents table').toBe(off.table)
        expect(on.hud, 'the panel: card, log, timeline and status').toBe(off.hud)
      })
    } finally {
      await cli.stop()
    }
  })

  test('Tab never stops on him: from the view button the next stop is the first agent', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('mascot-play'))
      await expect(page.locator('button.office-agent')).toHaveCount(4)
      await page.locator('#view-toggle').focus()
      await page.keyboard.press('Tab')
      await expect(page.locator('button.office-agent').first()).toBeFocused()
    } finally {
      await cli.stop()
    }
  })
})

test.describe('the empty offices', () => {
  test('he is not in one: the picture there says why the office is empty; he comes with the first agent', async ({ page }) => {
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
    try {
      await pushWorld(page, await loadWorld('empty-no-agents'), 200)
      await expect(page.locator('[data-empty]')).toHaveAttribute('data-empty', 'no-agents')
      await expect(canvasOf(page)).toHaveAttribute('data-mascot', 'off')
      await expect(page.locator('.office-mascot')).toHaveCount(0)
      expect(await pixelsIn(page, await boxOf(canvasOf(page)), DAY.mascot.g as string), 'no coat on the canvas').toBe(0)

      await pushWorld(page, await loadWorld('mascot-play'), 100)
      await expect(page.locator('button.office-agent')).toHaveCount(4)
      expect((await reading(page)).activity).toBe('nap')
      await expect(page.locator('.office-mascot')).toHaveCount(1)
    } finally {
      await cli.stop()
    }
  })
})

test.describe('reduced motion', () => {
  test('he is asleep in his basket, there is no ball, and nothing moves', { tag: '@pixels' }, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const cli = await openWithFakeWorld(page)
    try {
      await pushWorld(page, await loadWorld('mascot-play'))
      const canvas = canvasOf(page)
      await expect.poll(async () => Number((await canvas.getAttribute('data-frames')) ?? 0)).toBeGreaterThan(0)
      await expect(canvas).toHaveAttribute('data-reduced-motion', 'true')
      expect(await reading(page)).toEqual({ activity: 'nap', phase: 'stay', withId: '' })

      await page.waitForTimeout(300)
      const settled = Number(await canvas.getAttribute('data-frames'))
      const first = await canvas.screenshot()
      await page.waitForTimeout(1500)
      expect(Number(await canvas.getAttribute('data-frames')), 'no frame is drawn').toBe(settled)
      const second = await canvas.screenshot()
      expect(second.equals(first), 'the picture never changes').toBe(true)
      expect(await reading(page)).toEqual({ activity: 'nap', phase: 'stay', withId: '' })

      await saveEvidence('mascot-reduced', second)
      await expect(canvas).toHaveScreenshot('mascot-reduced.png')
    } finally {
      await cli.stop()
    }
  })

  test('switched on while he is walking or playing, he is asleep at once', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cli = await openOffice(page)
    try {
      await advanceUntil(page, (r) => r.activity === 'play' && r.phase === 'stay')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(canvasOf(page)).toHaveAttribute('data-reduced-motion', 'true')
      await page.clock.runFor(100) // the redraw it asks for is a frame, and the page clock is paused
      expect(await reading(page)).toEqual({ activity: 'nap', phase: 'stay', withId: '' })
      const settled = Number(await canvasOf(page).getAttribute('data-frames'))
      await page.clock.runFor(2000)
      expect(Number(await canvasOf(page).getAttribute('data-frames')), 'no frames after it settles').toBe(settled)
    } finally {
      await cli.stop()
    }
  })
})

test.describe('the door', () => {
  test('an arrival makes him go to the door and wag', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
    try {
      await pushWorld(page, await loadWorld('arrive-before'), 200)
      expect((await reading(page)).activity).not.toBe('off')
      await pushWorld(page, await loadWorld('arrive-after'), 50)
      await advanceUntil(page, (r) => r.activity === 'greet', 30_000)
      await advanceUntil(page, (r) => r.activity === 'greet' && r.phase === 'stay', 30_000)
      await saveEvidence('mascot-greet', await canvasOf(page).screenshot())
      // The newcomers are agents like any other, with a button each; he has none.
      const world = await loadWorld('arrive-after')
      await expect(page.locator('button.office-agent')).toHaveCount(Object.keys(world.agents).length)
    } finally {
      await cli.stop()
    }
  })
})
