// The adapters this build knows, and how a configuration turns into instances. An adapter that is
// not configured is not created: the app is complete without any of them, and `claude-agents`
// (which runs a program) exists only when the configuration says `"enabled": true`.

import type { AdapterConfig } from '../../core/adapters/config.js'
import type { AdapterEnv, OrchestrationAdapter } from '../../core/adapters/types.js'
import { ClaudeAgentsAdapter, type CommandRunner } from './claude-agents.js'
import { QuotaSamplesAdapter } from './quota-samples.js'
import { TaskFoldersAdapter } from './task-folders.js'

export const ADAPTER_IDS = ['task-folders', 'quota-samples', 'claude-agents'] as const
export type AdapterId = (typeof ADAPTER_IDS)[number]

export interface AdapterDeps {
  /** How `claude-agents` runs its program; tests inject a counting or failing one. */
  run?: CommandRunner
}

export function createAdapters(config: AdapterConfig, env: AdapterEnv, deps: AdapterDeps = {}): OrchestrationAdapter[] {
  const adapters: OrchestrationAdapter[] = []
  if (config.taskFolders) adapters.push(new TaskFoldersAdapter(config.taskFolders, env))
  if (config.quotaSamples) adapters.push(new QuotaSamplesAdapter(config.quotaSamples, env))
  if (config.claudeAgents) adapters.push(new ClaudeAgentsAdapter(config.claudeAgents, env, deps.run))
  return adapters
}
