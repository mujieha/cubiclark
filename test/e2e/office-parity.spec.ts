// The list view is the ground truth (design §6): the office must report the same agents in the
// same states. Each check compares office and list with the World itself, so neither can drift
// together without the test noticing.

import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { worldSessionId as s, worldSubagentId as sub } from '../../scripts/world-fixture-lib.js'
import type { World } from '../../src/core/types.js'
import { visibleAgents } from '../../src/core/visible.js'
import { runCli } from './helpers.js'
import { listAgents, loadWorld, officeAgents, openWithFakeWorld, pushWorld, type AgentView } from './fake-world.js'

const FIXTURE_HOME = fileURLToPath(new URL('../fixtures/home', import.meta.url))
const FIXTURE_STATE = fileURLToPath(new URL('../fixtures/state', import.meta.url))

const idAndState = (agents: readonly AgentView[]): { id: string; state: string }[] => agents.map(({ id, state }) => ({ id, state }))

/** The agents in view: the World's, less the idle ones past the fifth and the ones that left a while ago
 * (src/core/visible.ts). Office and list must agree with this, and with each other. */
function truth(world: World): { id: string; state: string }[] {
  const shown = visibleAgents(world, Date.parse(world.clock)).ids
  return Object.values(world.agents)
    .filter((agent) => shown.has(agent.id))
    .map((agent) => ({ id: agent.id, state: agent.state }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The state text of each list row and the aria-label of each office button, by agent id. */
async function labels(page: Page): Promise<{ list: Record<string, string>; office: Record<string, string> }> {
  return page.evaluate(() => {
    const list: Record<string, string> = {}
    const office: Record<string, string> = {}
    for (const row of document.querySelectorAll<HTMLElement>('#list-view tbody tr')) {
      list[row.dataset.agentId ?? ''] = row.querySelector('td.state')?.textContent ?? ''
    }
    for (const button of document.querySelectorAll<HTMLElement>('button.office-agent')) {
      office[button.dataset.agentId ?? ''] = button.getAttribute('aria-label') ?? ''
    }
    return { list, office }
  })
}

// Morty is on in every one of these (he is, by default): he is not an agent, so parity is exact with him there.
for (const name of ['all-states', 'rooms', 'crowd-50', 'crowd-100', 'crowd-250-idle', 'mascot-play']) {
  test(`office and list report the same agents and states: ${name}`, async ({ page }) => {
    const cli = await openWithFakeWorld(page)
    try {
      const world = await loadWorld(name)
      const expected = truth(world)
      await pushWorld(page, world)
      await expect(page.locator('button.office-agent')).toHaveCount(expected.length)
      await expect(page.locator('canvas.office-canvas')).not.toHaveAttribute('data-mascot', 'off')

      expect(idAndState(await officeAgents(page))).toEqual(expected)
      expect(idAndState(await listAgents(page))).toEqual(expected)

      // The canvas really drew every one of them (not just the buttons).
      await expect(page.locator('canvas.office-canvas')).toHaveAttribute('data-actors', String(expected.length))

      // Each button says, in words, what its row says.
      const { list, office } = await labels(page)
      for (const { id } of expected) {
        expect(list[id], id).not.toBe('')
        expect(office[id], id).toContain(list[id] as string)
      }
    } finally {
      await cli.stop()
    }
  })
}

test('the same, over the real SSE path: the fixture home and its hook state, eight agents', async ({ page }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--state-dir', FIXTURE_STATE, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('button.office-agent')).toHaveCount(8)
    const office = idAndState(await officeAgents(page))
    const list = idAndState(await listAgents(page))
    expect(office).toHaveLength(8)
    expect(office).toEqual(list)
    await expect(page.locator('canvas.office-canvas')).toHaveAttribute('data-actors', '8')
  } finally {
    await cli.stop()
  }
})

test('the rooms: orchestrator, planner, builder, reviewer and subagent are where the design puts them', async ({ page }) => {
  const cli = await openWithFakeWorld(page)
  try {
    await pushWorld(page, await loadWorld('rooms'))
    // 20 in the World; the ended one that left 20 minutes ago is past its 10 minutes and not in view.
    await expect(page.locator('button.office-agent')).toHaveCount(19)
    const room = new Map((await officeAgents(page)).map((agent) => [agent.id, agent.room]))
    expect(room.get(s(1)), 'orchestrator').toBe('manager')
    expect(room.get(s(2)), 'a session that started a background session').toBe('manager')
    expect(room.get(s(4)), 'planner').toBe('planning')
    expect(room.get(s(6)), 'builder').toBe('floor')
    expect(room.get(sub(1)), 'reviewer').toBe('review')
    expect(room.get(sub(2)), 'subagent: on a stool in its parent room').toBe('floor')
    expect(room.get(s(9)), 'a finished agent').toBe('lobby')

    const kinds = await page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll<HTMLElement>('button.office-agent')].map((b) => [b.dataset.agentId, b.dataset.kind]))
    )
    expect(kinds[sub(2)]).toBe('stool')
    expect(kinds[s(1)]).toBe('desk')
    expect(kinds[s(9)]).toBe('board')
  } finally {
    await cli.stop()
  }
})
