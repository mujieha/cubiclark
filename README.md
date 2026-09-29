# agent-office

A local, transcript-only view of live Claude Code agents and their states. Runs entirely on your
machine, on `127.0.0.1`; it never calls a model and never sends anything off the machine.

This is phase 1 of the project: the data spine (a transcript parser, a state reducer, a
transcript-tailing source) and a plain list page. The pixel-art office described in the design is
phase 3.

## What exists now

- **A transcript parser** that reads Claude Code's session, background-worker and subagent
  transcripts (`~/.claude/projects/**/*.jsonl` by default) and turns each line into a normalised
  event. A line that does not parse — malformed JSON, an unrecognised record `type`, an
  unrecognised `system` subtype — is counted as a diagnostic instead of throwing, and never
  stops the rest of the file from being read.
- **A pure state reducer** that folds those events into a `World`: one `Agent` per session,
  background worker, subagent or teammate, each with a `state` (an enum, never a boolean —
  `starting`, `thinking`, `reading`, `editing`, `running`, `searching`, `browsing`,
  `delegating`, `waiting_permission`, `waiting_user`, `stuck`, `rate_limited`, `failed`,
  `finished`), a model, a project, counters, and its current tool.
- **A ticking clock** (an injected one, not `Date.now()` directly) that marks an agent `stuck`
  after 10 minutes of silence while it should be working, and infers a `waiting_permission` wait
  when a non-exempt tool has gone quiet for 7 seconds outside `bypassPermissions`/`dontAsk` mode
  — marked `(inferred)` on the page, since transcripts alone cannot see a real permission prompt
  (that arrives with the hooks collector in phase 2).
- **A transcript source** that discovers transcript files under a Claude config directory, tails
  each one by byte offset, and reacts to `fs.watch` events with a polling loop always running
  underneath as the fallback (`fs.watch(recursive)` is unreliable on some file systems).
- **A CLI** (`node dist/cli.js`, or `agent-office` once installed) that serves a plain list page
  over `node:http` and Server-Sent Events, bound to `127.0.0.1` only, behind a random per-run
  token in the URL path and a Host-header check.
- **The list page**: a table of every agent (kind, parent, project, model, state, since, current
  tool), a diagnostics line (unparsed lines, unknown types, Claude Code versions seen, source
  errors), and four distinct empty screens — no data yet, the transcripts folder is unreadable,
  no transcripts found and no collector installed, or no agents active right now.

### Commands

```
npm test         # vitest
npm run typecheck
npm run lint
npm run build    # tsc + vite; writes dist/
npm run test:e2e # builds, then runs the Playwright end-to-end tests
npm run fixtures        # regenerate the synthetic fixtures under test/fixtures/
npm run fixtures:check  # verify the checked-in fixtures still match the generator
node dist/cli.js [--port <n>] [--no-open] [--fixture-home <dir>] [--since-hours <n>]
```

`--fixture-home <dir>` points the CLI at a stand-in Claude config directory instead of the real
one (used by the tests and by `test/fixtures/home` for a demo). Fixture mode also disables the
age window (`--since-hours` is ignored) and freezes the page's clock at the newest record
timestamp found, so a fixture world never looks stale just because the checkout is old.

## Known limits

- **`compacting` and `ended` are never shown.** Transcripts only record a compaction after it has
  already finished, and they never mark a session as having ended. Both need the PreCompact and
  SessionEnd hooks, which arrive in phase 2.
- **The permission wait is a guess.** `waiting_permission (inferred)` is a heuristic over how long
  a tool has been open, not something transcripts record directly. It can misread a long-running,
  already-approved command as a stuck permission prompt; the hooks collector in phase 2 will
  replace it with the real thing.
- **Background-session detection depends on an undocumented field** (`sessionKind: "bg"`). If a
  future Claude Code version stops writing it, a background worker will show as an ordinary
  session — wrong, but harmless (its state is still tracked correctly).
- **The transcript format is not documented and is pinned to Claude Code 2.1.284** (recorded in
  `scripts/fixture-lib.ts`'s header). Every assumption about it lives under
  `src/core/transcript/` and is checked against a fixture; an unrecognised shape is counted, never
  guessed at.
- **No hooks collector yet.** Everything above comes from transcripts alone; `hooks on/off`,
  `doctor`, and live (not just tailed) events arrive in phase 2.
- **File paths are never shown in full**, only basenames — there is no `--full-paths` flag yet.
- **Tested on macOS and Linux.** `fs.watch(recursive)` and the polling fallback are both
  exercised on those platforms; Windows is untested.

## Development

TypeScript, ESM, Node 22.12+. `node:http` and Server-Sent Events for the server (no web
framework); Vite for the client; Vitest for tests; ESLint with a rule banning `innerHTML`,
`outerHTML`, `insertAdjacentHTML` and `document.write`. See `SECURITY.md` for the threat model.

MIT licensed; see `LICENSE`.
