// The words for an agent in the office: the tooltip, and the screen-reader label on its overlay
// button. Built from the same helpers as the list view, so the two never word a state differently.

import type { Agent, World } from '../types.js'
import { agentStateLabel, relativeSince, shortId } from '../view.js'

/** "Explore 00000003 · demo": what the agent is, the tail of its id, and its project. */
export function agentWho(agent: Agent): string {
  return `${agent.label ?? agent.kind} ${shortId(agent.id)} · ${agent.project}`
}

/** One line per fact: who, state and how long, the current tool, the model, and (only for a failed
 * agent) the error text. Times are measured against `world.clock`, like the rest of the page. */
export function tooltipLines(agent: Agent, world: World): string[] {
  const since = relativeSince(agent.stateSince, Date.parse(world.clock))
  const lines = [agentWho(agent), since === '' ? agentStateLabel(agent) : `${agentStateLabel(agent)} · ${since}`]
  if (agent.currentTool) {
    lines.push(agent.currentTool.target ? `${agent.currentTool.name} ${agent.currentTool.target}` : agent.currentTool.name)
  }
  if (agent.model) lines.push(agent.model)
  if (agent.state === 'failed' && agent.error?.message) lines.push(agent.error.message)
  return lines
}

export function ariaLabel(agent: Agent, world: World): string {
  return tooltipLines(agent, world).join(' — ')
}
