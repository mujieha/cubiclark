// The quiet office (cubiclark-quiet-office): only the agents that matter now are in the office, the
// list and the panel. Every agent that works, the five sessions waiting for you that were active most
// recently, and the ones that left a moment ago. The others leave without a sound, come back through
// the door the moment they are active again, and are counted in the status bar. The World is the
// crowd-250-idle fixture: 40 working, 200 waiting for you, 10 that left.

import { expect, test, type Locator, type Page } from '@playwright/test'
import { worldSessionId as s } from '../../scripts/world-fixture-lib.js'
import type { Agent, World } from '../../src/core/types.js'
import { listAgents, loadWorld, openWithFakeWorld, pushWorld } from './fake-world.js'

const CLOCK_AT = '2026-01-15T10:30:00.000Z'
const TILE_PX = 16

const agentButton = (page: Page, id: string): Locator => page.locator(`button.office-agent[data-agent-id="${id}"]`)
const hiddenSegment = (page: Page): Locator => page.locator('#hud-status [data-segment="hidden"]')

/** The World with one agent changed. */
function withAgent(world: World, id: string, patch: Partial<Agent>): World {
  return { ...world, agents: { ...world.agents, [id]: { ...(world.agents[id] as Agent), ...patch } } }
}

/** Only the sessions numbered `from` to `to`. */
function onlySessions(world: World, from: number, to: number): World {
  const keep = new Set(Array.from({ length: to - from + 1 }, (_, i) => s(from + i)))
  return { ...world, agents: Object.fromEntries(Object.entries(world.agents).filter(([id]) => keep.has(id))) }
}

async function scale(page: Page): Promise<number> {
  return Number(await page.locator('canvas.office-canvas').getAttribute('data-scale'))
}

test('the rule: the working, five idle sessions and the ones that just left; the rest counted, not shown', async ({ page }) => {
  const cli = await openWithFakeWorld(page)
  try {
    await pushWorld(page, await loadWorld('crowd-250-idle'))
    await expect(page.locator('button.office-agent')).toHaveCount(49)
    await expect(page.locator('canvas.office-canvas')).toHaveAttribute('data-actors', '49')
    expect(await listAgents(page)).toHaveLength(49)
    // the five most recently active idle sessions have a desk, the sixth does not
    for (let k = 31; k <= 35; k++) await expect(agentButton(page, s(k))).toHaveCount(1)
    await expect(agentButton(page, s(36))).toHaveCount(0)
    // and the trace: the status bar and the line under the office say what is not shown
    await expect(hiddenSegment(page)).toHaveText('195 idle not shown · 6 finished not shown')
    await expect(page.locator('.office-status')).toContainText('49 agents')
    await expect(page.locator('.office-status')).toContainText('195 idle not shown · 6 finished not shown')
  } finally {
    await cli.stop()
  }
})

test('an idle agent that becomes active is in the office on that very update, and walks in from the door', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
  try {
    const world = await loadWorld('crowd-250-idle')
    await pushWorld(page, world, 200)
    await expect(page.locator('button.office-agent')).toHaveCount(49)
    await expect(agentButton(page, s(100))).toHaveCount(0)

    // Session 100 was idle for 69 minutes and is hidden. It gets a prompt.
    const awake = withAgent(world, s(100), { state: 'thinking', stateSince: world.clock, lastActivity: world.clock })
    await pushWorld(page, awake, 50)
    await expect(page.locator('button.office-agent')).toHaveCount(50)
    await expect(agentButton(page, s(100))).toHaveCount(1)

    // Just after the update it is at the door, a walking box; five seconds later it sits at a desk.
    const px = (await scale(page)) * TILE_PX
    const canvas = await page.locator('canvas.office-canvas').boundingBox()
    const walking = await agentButton(page, s(100)).boundingBox()
    expect(canvas && walking).toBeTruthy()
    expect((walking?.x ?? 0) - (canvas?.x ?? 0), 'near the hallway').toBeLessThan(3 * px)
    expect(walking?.width, 'a walking box').toBe(px)
    await page.clock.runFor(5000)
    expect((await agentButton(page, s(100)).boundingBox())?.width, 'a desk box').toBe(3 * px)
    await expect(agentButton(page, s(100))).toHaveAttribute('data-kind', 'desk')
    await expect(agentButton(page, s(100))).toHaveAttribute('data-state', 'thinking')
    // it was not squeezed in at somebody's expense: the idle desks are the same five
    for (let k = 31; k <= 35; k++) await expect(agentButton(page, s(k))).toHaveCount(1)
    await expect(hiddenSegment(page)).toHaveText('194 idle not shown · 6 finished not shown')
  } finally {
    await cli.stop()
  }
})

test('an agent that drops out of the five leaves without a sound: no walk-out, no board tag, no new log line', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const cli = await openWithFakeWorld(page, { clockAt: CLOCK_AT })
  try {
    // One log line, of an agent that is not in view: the log is history, and nothing is added to it.
    const base = await loadWorld('crowd-250-idle')
    const world: World = { ...base, log: [{ ts: base.clock, agentId: s(100), kind: 'prompt', text: 'prompt' }] }
    await pushWorld(page, world, 200)
    await expect(page.locator('button.office-agent')).toHaveCount(49)
    const logBefore = await page.locator('#hud-log .hud-log-row').allTextContents()
    expect(logBefore).toHaveLength(1)
    const boardBefore = await page.locator('button.office-agent[data-kind="board"]').count()
    expect(boardBefore).toBeGreaterThan(0)
    await expect(agentButton(page, s(35))).toHaveCount(1)

    // Session 200 is active a moment ago: it takes a desk, and session 35, the fifth, is the sixth now.
    const next = withAgent(world, s(200), { lastActivity: new Date(Date.parse(world.clock) - 10_000).toISOString() })
    await pushWorld(page, next, 50)
    await expect(agentButton(page, s(200))).toHaveCount(1)
    await expect(agentButton(page, s(35))).toHaveCount(0)
    await expect(page.locator('button.office-agent')).toHaveCount(49)
    // not on the board, and nobody is walking out: a walker's box is 1 tile wide and 1.5 tall (a stool or
    // a board tag is 1 by 1, a bench seat 1 by 2)
    expect(await page.locator('button.office-agent[data-kind="board"]').count(), 'no new tag on the lobby board').toBe(boardBefore)
    const px = (await scale(page)) * TILE_PX
    const boxes = await page
      .locator('button.office-agent')
      .evaluateAll((buttons) => buttons.map((b) => ({ id: (b as HTMLElement).dataset.agentId, w: parseFloat((b as HTMLElement).style.width), h: parseFloat((b as HTMLElement).style.height) })))
    // only the newcomer, session 200, is walking
    expect(boxes.filter((box) => box.w === px && box.h === 1.5 * px).map((box) => box.id)).toEqual([s(200)])
    expect(await page.locator('#hud-log .hud-log-row').allTextContents(), 'no line about it in the log').toEqual(logBefore)
    await expect(hiddenSegment(page)).toHaveText('195 idle not shown · 6 finished not shown')
  } finally {
    await cli.stop()
  }
})

for (const [desks, shown, hidden] of [
  ['0', 44, '200 idle not shown · 6 finished not shown'],
  ['12', 56, '188 idle not shown · 6 finished not shown'],
  ['1000', 244, '6 finished not shown'],
] as const) {
  test(`--idle-desks ${desks}: ${shown} agents in view`, async ({ page }) => {
    const cli = await openWithFakeWorld(page, { args: ['--idle-desks', desks] })
    try {
      await pushWorld(page, await loadWorld('crowd-250-idle'))
      await expect(page.locator('button.office-agent')).toHaveCount(shown)
      await expect(hiddenSegment(page)).toHaveText(hidden)
      await expect(agentButton(page, s(31))).toHaveCount(desks === '0' ? 0 : 1)
    } finally {
      await cli.stop()
    }
  })
}

test('with every idle session hidden and nothing else going on, the page says so instead of "no agents"', async ({ page }) => {
  const cli = await openWithFakeWorld(page, { args: ['--idle-desks', '0'] })
  try {
    await pushWorld(page, onlySessions(await loadWorld('crowd-250-idle'), 31, 37))
    const empty = page.locator('.empty')
    await expect(empty).toBeVisible()
    await expect(empty).toHaveAttribute('data-empty', 'no-agents')
    await expect(empty).toHaveText('No agents working right now · 7 idle not shown')
    await expect(page.locator('button.office-agent')).toHaveCount(0)
  } finally {
    await cli.stop()
  }
})

test('a selected agent that drops out of view is deselected, and its card goes back to the hint', async ({ page }) => {
  const cli = await openWithFakeWorld(page)
  try {
    const world = await loadWorld('crowd-250-idle')
    await pushWorld(page, world)
    await agentButton(page, s(35)).click()
    await expect(page.locator('#hud-card')).toHaveAttribute('data-agent-id', s(35))
    await expect(agentButton(page, s(35))).toHaveAttribute('aria-pressed', 'true')

    const next = withAgent(world, s(200), { lastActivity: new Date(Date.parse(world.clock) - 10_000).toISOString() })
    await pushWorld(page, next)
    await expect(agentButton(page, s(35))).toHaveCount(0)
    await expect(page.locator('#hud-card')).toContainText('Select an agent in the office or the list')
    await expect(page.locator('#hud-card')).not.toHaveAttribute('data-agent-id', s(35))
  } finally {
    await cli.stop()
  }
})
