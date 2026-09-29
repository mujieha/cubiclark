// The pure view layer between World and anything that shows it to a person or sends it off the
// machine: the HTTP/SSE layer (publicWorld) and, from step 8 on, the list page's table and its
// four empty screens. No I/O, same as the rest of core/.

import { projectName } from './transcript/paths.js'
import type { Agent, World } from './types.js'

/** The World as it is safe to hand to the browser: real tool_use ids are never useful to a
 * viewer and are a needless thing to leak, and a full cwd would show more of the filesystem
 * than the page needs (design §4/§9: file paths are shown as basenames unless the user turns
 * full paths on — full paths are a later phase; for now the raw cwd never leaves the server). */
export function publicWorld(world: World): World {
  const agents: Record<string, Agent> = {}
  for (const [id, agent] of Object.entries(world.agents)) {
    agents[id] = {
      ...agent,
      cwd: projectName(agent.cwd),
      spawnToolUseId: undefined,
      openTools: agent.openTools.map((tool) => ({ ...tool, id: '' })),
    }
  }
  return { ...world, agents }
}
