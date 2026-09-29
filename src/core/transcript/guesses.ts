// Every transcript value phase 1 had to guess, in one place. Keys marked "key verified" were
// seen in real Claude Code 2.1.284 transcripts (key paths and `type` values only, no values);
// the values themselves are not documented anywhere, including the hooks reference. When one of
// these turns out wrong, this is the only file to change.
//
// Seen in 2.1.285 (types only): bookkeeping records (`last-prompt`, `mode`, `atis-latch`,
// `ai-title`, `permission-mode`, `cost-state`, ...) may have no top-level `timestamp`, and the
// parser lends them the file's newest one; `continued-in` carries `continuedInSessionId`;
// `pr-link`, `warning`, `update` and the system subtype `bridge_status` change no agent state.
// Seen on a real home (2026-09-30): `bridge-session`, `artifact-autoreact-ledger` and
// `artifact-comment-monitor` (ignored), and `permission-mode` / `agent-name` records before the
// file's first timestamp, which wait for it (parse.ts, MAX_PENDING).

import type { ErrorKind } from '../types.js'

export const TRANSCRIPT_GUESSES = {
  verifiedOn: '2.1.285',
  /** Key `sessionKind` verified (only the background worker transcript has it); the value is not. */
  backgroundSessionKind: 'bg',
  /** The undocumented sidecar `agent-<id>.meta.json`: the key names are unverified. */
  subagentMetaKeys: {
    agentType: 'agentType',
    description: 'description',
    toolUseId: 'toolUseId',
    model: 'model',
    name: 'name',
    spawnDepth: 'spawnDepth',
  },
  /** Key verified. Any non-empty string counts as a denial, so its values are never needed. */
  toolDenialKey: 'toolDenialKind',
  /** The values match the documented StopFailure `error` enum; that the transcript field shares
   * that enum is assumed. */
  apiErrorKindByField: { rate_limit: 'rate_limit', overloaded: 'overloaded' } as Record<string, ErrorKind>,
} as const
