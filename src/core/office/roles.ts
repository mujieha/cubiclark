// Which room an agent works in, what it wears and where its helpers sit (PLAN.md phase 3 §2.3).
// Pure functions over Agent and World: the same rules drive layout() and the tests.

import { ownEntry } from '../keys.js'
import type { Agent, AgentRole, World } from '../types.js'

export type RoomId = 'manager' | 'planning' | 'review' | 'floor' | 'lobby'
export type Assignment = 'manager' | 'planning' | 'review' | 'floor' | 'helper' | 'board'
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'
export type Accessory = 'tie' | 'clipboard' | 'magnifier' | 'headphones' | 'cap' | 'none'

/** How many parent links a helper may climb before it counts as unanchored. */
const MAX_ANCESTOR_STEPS = 8

export function modelFamily(model: string | undefined): ModelFamily {
  if (!model) return 'other'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  if (/haiku/i.test(model)) return 'haiku'
  if (/fable/i.test(model)) return 'fable'
  return 'other'
}

export function isHelperKind(kind: Agent['kind']): boolean {
  return kind === 'subagent' || kind === 'teammate'
}

/** The role an agent plays in the office. First match wins:
 * 1. an explicit orchestrator, planner or reviewer role;
 * 2. a session that started a background session is an orchestrator;
 * 3. an agent whose task is in its planning phase is a planner;
 * 4. a label that says review or verify makes a reviewer;
 * 5. any other explicit role (builder, explorer, other);
 * 6. a session or background worker is a builder; a helper without a role has none. */
export function effectiveRole(agent: Agent, world: World): AgentRole | undefined {
  if (agent.role === 'orchestrator' || agent.role === 'planner' || agent.role === 'reviewer') return agent.role
  const startedBackground = Object.values(world.agents).some((other) => other.kind === 'background' && other.parentId === agent.id)
  if (startedBackground) return 'orchestrator'
  if (agent.taskId !== undefined && ownEntry(world.tasks, agent.taskId)?.phase === 'planning') return 'planner'
  if (agent.label !== undefined && /review|verif/i.test(agent.label)) return 'reviewer'
  if (agent.role !== undefined) return agent.role
  return agent.kind === 'session' || agent.kind === 'background' ? 'builder' : undefined
}

export function accessoryFor(role: AgentRole | undefined): Accessory {
  switch (role) {
    case 'orchestrator':
      return 'tie'
    case 'planner':
      return 'clipboard'
    case 'reviewer':
      return 'magnifier'
    case 'builder':
      return 'headphones'
    case 'explorer':
      return 'cap'
    default:
      return 'none'
  }
}

/** Everything about an agent's room except whether it is a helper by someone's desk. */
type Base = 'board' | 'manager' | 'planning' | 'review' | 'candidate'

function baseAssignment(agent: Agent, world: World): Base {
  if (agent.state === 'finished' || agent.state === 'ended') return 'board'
  const role = effectiveRole(agent, world)
  if (role === 'orchestrator') return 'manager'
  if (role === 'planner') return 'planning'
  if (role === 'reviewer') return 'review'
  return 'candidate'
}

/** The agent in `agent`'s chain (itself included) that owns a desk, or 'blocked' when the chain
 * runs into a departed agent, a cycle or the step limit. */
function deskOwner(agent: Agent, world: World, visited: ReadonlySet<string>): string | 'blocked' {
  if (visited.has(agent.id) || visited.size > MAX_ANCESTOR_STEPS) return 'blocked'
  const base = baseAssignment(agent, world)
  if (base === 'board') return 'blocked'
  if (base !== 'candidate') return agent.id
  if (!isHelperKind(agent.kind)) return agent.id
  const parent = agent.parentId === undefined ? undefined : world.agents[agent.parentId]
  // A helper whose parent is not in the world is an orphan: it has a desk of its own.
  if (!parent) return agent.id
  return deskOwner(parent, world, new Set([...visited, agent.id]))
}

/** The id of the agent whose desk this helper sits beside: the nearest ancestor that has a desk.
 * A helper of a helper sits by the root desk. Undefined for anything that is not a helper, and
 * when the chain reaches a departed agent, a cycle or a missing parent, so it goes to the floor. */
export function helperAnchor(agent: Agent, world: World): string | undefined {
  if (!isHelperKind(agent.kind)) return undefined
  if (baseAssignment(agent, world) !== 'candidate') return undefined
  const parent = agent.parentId === undefined ? undefined : world.agents[agent.parentId]
  if (!parent) return undefined
  const owner = deskOwner(parent, world, new Set([agent.id]))
  return owner === 'blocked' ? undefined : owner
}

/** Where an agent belongs. First match wins:
 * 1. finished and ended agents are on the lobby board (a failed agent stays slumped at its desk);
 * 2. an orchestrator goes to the manager's office, a planner to planning, a reviewer to review;
 * 3. a subagent or teammate with an anchor is a helper by that desk;
 * 4. everything else sits on the project floor. */
export function assignRoom(agent: Agent, world: World): Assignment {
  const base = baseAssignment(agent, world)
  if (base !== 'candidate') return base
  if (helperAnchor(agent, world) !== undefined) return 'helper'
  return 'floor'
}
