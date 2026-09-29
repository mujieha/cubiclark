// Where the hook source and the transcript source meet (PLAN.md phase 2 §2.6). Hook events go
// straight to the reducer. A transcript event passes through this gate first, judged against the
// World as it stands when the event is applied: hooks win on timing (they arrive live and say
// exactly when a turn starts, a tool opens, a permission is asked), transcripts fill in what
// hooks cannot know (the model, compactions, a manual denial, an interrupt, background kind).
// Pure: no I/O, no clock.

import type { AgentEvent, World } from './types.js'

function isBefore(ts: string, than: string): boolean {
  return Date.parse(ts) < Date.parse(than)
}

/** The event to apply, changed or not, or undefined when hooks already own it. */
export function gateTranscriptEvent(world: World, event: AgentEvent): AgentEvent | undefined {
  if (event.t === 'diagnostics') return event
  const hooked = world.agents[event.agentId]?.hooked
  if (!hooked) return event

  switch (event.t) {
    // UserPromptSubmit and Stop / SubagentStop own the turn boundaries.
    case 'prompt':
    case 'turn_end':
      return undefined
    // The model and token count only: never a state change (fillOnly).
    case 'assistant':
      return { ...event, fillOnly: true }
    // With tools recorded by hooks, PreToolUse and PostToolUse are the source. Without (`hooks
    // on --no-tools`) transcripts are the only tool source, but a line older than the newest
    // hook event is history the hooks have already moved past.
    case 'tool_start':
      return hooked.tools || isBefore(event.ts, hooked.lastTs) ? undefined : event
    // A manual denial is invisible to hooks (PostToolUseFailure does not fire for one).
    case 'tool_end':
      return event.denied || !hooked.tools ? event : undefined
    // Stop never fires on a user interrupt, and StopFailure is the hook side of an API error:
    // the transcript stays a valid source for these, unless the hooks are already past it.
    case 'interrupted':
    case 'api_error':
      return isBefore(event.ts, hooked.lastTs) ? undefined : event
    default:
      return event
  }
}
