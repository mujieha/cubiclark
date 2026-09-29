# Cubiclark

A local view of live Claude Code agents and their states, read from transcripts and, optionally,
from a small hooks collector. Runs entirely on your machine, on `127.0.0.1`; it never calls a
model and never sends anything off the machine.

The project so far is the data spine (a transcript parser, a hook collector, a state reducer, two
tailing sources that merge into one world), a plain list page, and the commands to install,
remove and check the collector. The pixel-art office described in the design comes later.

## Two ways to see agents

- **Transcripts only (nothing to install).** Cubiclark tails Claude Code's own transcript files
  (`~/.claude/projects/**/*.jsonl`). It changes no settings at all. It cannot see a permission
  prompt, a compaction in progress, or the moment a session ends.
- **With hooks (live and precise).** `cubiclark hooks on` adds a collector to Claude Code's user
  `settings.json`. Claude Code then tells Cubiclark about session starts and ends, prompts, tool
  calls, permission requests, compactions, failures and subagents as they happen. Transcripts stay
  in use for what hooks do not carry (the model, compactions, a manual denial, an interrupt).

Verified against Claude Code **2.1.284** and its hooks reference. `cubiclark doctor` says which
version you run and whether it is the one the hook events were checked on.

## Hooks

```
cubiclark hooks on [--no-tools]   # install the collector
cubiclark hooks off [--purge]     # remove it
cubiclark hooks status            # what is installed, and whether it is paused
cubiclark hooks pause             # soft-off: the collector exits 0 and writes nothing
cubiclark hooks resume
cubiclark doctor                  # the version, each source, and what failed to parse
```

**What `hooks on` does.** It parses `~/.claude/settings.json` (or `--config-dir <dir>`/
`CLAUDE_CONFIG_DIR`) and refuses, changing nothing, if the file does not parse. Otherwise it keeps a
backup of the original bytes under `~/.cubiclark/backups/`, copies the collector to
`~/.cubiclark/bin/`, and adds one entry per event to `settings.json`, written through a temp file
and a rename (a symlinked `settings.json` stays a symlink). Running it twice adds the entries once.
It touches only entries that run `cubiclark-collector.js`; every other hook and setting stays as
it was.

**What `hooks off` does.** If `settings.json` is exactly what `hooks on` wrote, the original file
comes back byte for byte. If something else has edited it since, only Cubiclark's entries are
removed and every other edit is kept. The installed copy goes with it. Events already collected
and the backups stay in `~/.cubiclark` unless you pass `--purge`.

**`--no-tools`** installs the 11 lifecycle events only (no `PreToolUse`, `PostToolUse` or
`PostToolUseFailure`), for people who do not want any tool activity recorded. Transcripts then
remain the only source of tool activity.

**What the collector stores.** One line per event in `~/.cubiclark/events.jsonl` (rotated at 5 MB,
one old file kept): the event name, a timestamp, the session id, the subagent id and type, the
working directory, the tool name and its id, and a *reduced* target (a file's basename, a command's
first word, a URL's host, a subagent type), plus a few enum values (why a session ended, a
compaction's trigger, an API error's kind, the permission mode, the effort level, a session's
starting model). It never stores prompt text, tool input or output, error text, assistant text or
anything it does not recognise. `test/whitelist.test.ts` feeds it payloads full of fake secrets and
checks that none survives.

**What it never does.** The collector exits 0 with empty stdout on every path, including
malformed input, so it adds nothing to any session's context. It never answers a permission
request. If it breaks, Claude Code carries on exactly as before. Ten of the events are installed
as `async` hooks, so Claude Code does not wait for the collector at all; the four that fire as a
turn or session ends (`Stop`, `StopFailure`, `SubagentStop`, `SessionEnd`) are synchronous with a
5 second timeout, because an async hook may be killed at teardown.

**Speed.** Starting Node alone takes about 90 ms on the development Mac, before any of our code
runs. The collector is one small file with no imports beyond `node:` built-ins, and `npm run
bench:hook` measures what it adds over an empty Node script: about 6 ms there, against a limit of
30 ms. It needs `node` on the `PATH` that Claude Code runs hooks with.

## Commands

```
npm test              # vitest: unit tests, no build needed
npm run typecheck
npm run lint
npm run build         # tsc + vite; writes dist/
npm run test:hooks    # builds, then spawns the real collector and CLI against fixture dirs
npm run test:e2e      # builds, then runs the Playwright end-to-end tests
npm run bench:hook    # collector overhead over Node's own start-up
npm run fixtures        # regenerate the synthetic fixtures under test/fixtures/
npm run fixtures:check  # verify the checked-in fixtures still match the generator

node dist/cli.js [--port <n>] [--no-open] [--fixture-home <dir>] [--since-hours <n>] [--state-dir <dir>]
```

Every test uses fixture directories under a temp dir and never reads or writes the real
`~/.claude` or `~/.cubiclark`. `--fixture-home <dir>` points the CLI at a stand-in Claude config
directory (`test/fixtures/home` is one), and `--state-dir <dir>` at a stand-in state directory
(`test/fixtures/state`). Fixture mode disables the age window and freezes the page's clock at the
newest record found, so a fixture world never looks stale just because the checkout is old.

## What the page shows

A table of every agent (kind, parent, project, model, state, since, current tool), a line naming
each source and its health, a diagnostics line (unparsed lines, unknown record types and hook
shapes, Claude Code versions seen, source errors), and four distinct empty screens: no data yet,
the transcripts folder is unreadable, no transcripts found and no collector installed, or no
agents active right now. A subagent appears under the agent that started it, and a permission
wait reported by a hook reads "waiting for permission" while a guess from transcripts alone reads
"waiting for permission? (inferred)".

## Known limits

- **An approved permission still reads "waiting for permission" until the tool finishes.** No hook
  fires when you approve, only when the request is made and when the tool ends.
- **Nested subagents are parented to the session** until the transcript's sidecar file says
  otherwise; hooks report a subagent's session, not which subagent started it.
- **The rotated `events.1.jsonl` is not read at start-up.** Only the current file is.
- **Two collectors rotating at the same instant can lose a few lines.** Rare, and only at the
  5 MB boundary.
- **Model and effort.** Hook payloads carry the model only on `SessionStart` (and not always), so
  the model still comes from transcripts.
- **Background-session detection depends on an undocumented field** (`sessionKind: "bg"`). The key
  exists in real 2.1.284 transcripts; its value is unverified, and the hooks reference offers no
  background marker. If it is wrong, a background worker shows as an ordinary session: wrong, but
  harmless. Every guessed transcript value lives in `src/core/transcript/guesses.ts`.
- **The transcript format is not documented and is pinned to Claude Code 2.1.284.** Every
  assumption about it lives under `src/core/transcript/` and is checked against a fixture; an
  unrecognised shape is counted, never guessed at.
- **Without hooks, the permission wait is a guess and `compacting`/`ended` are never shown.**
- **File paths are never shown in full**, only basenames.
- **Tested on macOS and Linux.** Windows is untested.

## Development

TypeScript, ESM, Node 22.12+, no runtime dependencies. `node:http` and Server-Sent Events for the
server (no web framework); Vite for the client; Vitest for tests; ESLint with a rule banning
`innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write`, and another banning `console`
in the collector. See `SECURITY.md` for the threat model.

MIT licensed; see `LICENSE`.
