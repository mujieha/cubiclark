# Cubiclark

A local view of live Claude Code agents and their states, read from transcripts and, optionally,
from a small hooks collector. Runs entirely on your machine, on `127.0.0.1`; it never calls a
model and never sends anything off the machine.

The page is a pixel-art office: every agent is a character at a desk, and what it is doing shows
in its pose, its speech bubble and its desk lamp. Behind it are a transcript parser, a hook
collector, a state reducer and two tailing sources that merge into one world, plus the commands to
install, remove and check the collector. A plain list of the same agents is one click away.

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
npm run test:e2e      # builds, then runs the Playwright end-to-end tests (Chromium)
npm run test:e2e:firefox   # optional: the behaviour specs in Firefox, screenshots ignored
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

## The office

The page opens on the office; the button in the header (or `#list` at the end of the URL) switches
to the list. Both show the same World, and an end-to-end test compares them agent by agent.

**Rooms.** An orchestrator (a session that started background sessions, or one an adapter names)
sits in the *manager's office*; a planner (or an agent whose task is in its planning phase) in the
*planning room*; a reviewer in the *review corner*. Everyone else sits at a desk on the *project
floor*, one cluster of desks per project. A subagent or teammate sits on a *stool* beside its
parent's desk (three stools per desk, then a bench); a subagent of a subagent sits beside the
top-level agent. An agent that has finished or ended walks out of the door and leaves a tag on the
board in the *lobby*, so nobody the list shows is missing from the office. Seats stay put as the
world changes: an agent that leaves does not make everyone shuffle up.

**Characters.** The shirt colour is the model family (Opus purple, Sonnet blue, Haiku green, Fable
pink, anything else grey); the accessory is the role (a tie for an orchestrator, a clipboard for a
planner, a magnifier for a reviewer, headphones for a builder, a cap for an explorer). New agents
walk in from the door, and a subagent walks to the stool beside its parent.

**What each state looks like.** No two states look alike, and the shape of the bubble icon (not
only its colour) tells them apart:

| State | Character | Bubble | Desk |
|---|---|---|---|
| starting | settles in, looks around | spark | screen still dark |
| thinking | types slowly, head bobs | `…` | |
| reading, searching, browsing | leans toward the screen | book, magnifier or globe, and the file or host | |
| editing | types fast | pencil and the file | |
| running | types | `>_` and the command's first word | screen flickers |
| delegating | turns toward the helper's stool | arrow toward it, and its label | |
| waiting for permission | stands and waves | red `?`, pulsing | red lamp |
| waiting for you | leans back, hands behind the head | none | amber lamp |
| compacting | shuffles papers | stack | |
| stuck | frozen, dimmed | grey `!` and how long it has been quiet | |
| rate limited | asleep | `zzz` and the time until the quota resets | dark screen |
| failed | slumped | red cross | red screen |
| finished, ended | walks out | none | a check or an exit tag on the lobby board |

The status line under the office counts agents, busy ones, permission waits and rate limits. Above
50 agents it suggests the list view.

**Around the picture.** Hover an agent, or Tab to it, for a tooltip with who it is, its state, its
tool and its model; Escape dismisses it. Every agent is a real button over the canvas with a screen
reader label in the list view's own words. The four empty screens are four different empty offices
(lights out, a padlocked cabinet, an unplugged cable, an open door), each with its message.

**Reduced motion.** With the operating system's "reduce motion" setting on, nothing moves: the
office draws once when the world changes, characters hold their first frame, nobody walks and the
bubble does not pulse. The states are still told apart by pose, bubble and lamp. Changing the
setting while the page is open takes effect at once.

**Performance.** The canvas is capped at 30 frames a second, pauses while the tab is hidden, draws
at a whole-number scale (so pixels stay crisp) and stops entirely while the list is showing. With
50 agents a draw takes about a millisecond.

## What else the page shows

A line naming each source and its health, a diagnostics line (unparsed lines, unknown record types
and hook shapes, Claude Code versions seen, source errors), and the list: a table of every agent
(kind, parent, project, model, state, since, current tool). A subagent appears under the agent that
started it, and a permission wait reported by a hook reads "waiting for permission" while a guess
from transcripts alone reads "waiting for permission? (inferred)".

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
- **The office's screenshot baselines are macOS and Chromium.** The tests compare canvas pixels with
  no tolerance, and the system font behind the text in bubbles and signs decides some of them. On
  another system, regenerate them with `npx playwright test --update-snapshots` and look at them
  before committing. Only Chromium is in CI; `npm run test:e2e:firefox` is a manual extra.
- **Bubble text is cut to 12 characters** with an ellipsis, and is drawn in the system monospace
  font, not a pixel font. The full text is in the tooltip.
- **The wall meter and whiteboard are drawn but empty of data** until a later phase feeds them: the
  meter needs quota samples and the whiteboard a task timeline.
- **Tested on macOS and Linux.** Windows is untested.

## Development

TypeScript, ESM, Node 22.12+, no runtime dependencies. `node:http` and Server-Sent Events for the
server (no web framework); Vite and Canvas 2D for the client; Vitest for tests; ESLint with a rule
banning `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` (and a test that proves
it fires), another banning `console` in the collector, and another keeping `src/core` pure (no DOM,
no `Date.now`). See `SECURITY.md` for the threat model.

The office is drawn entirely in code, with no image files: sprites are grids of characters over one
16-colour palette (`src/client/office/art/`), baked to canvases at load. What is drawn where is
decided by pure functions in `src/core/office/` (`layout`, the state table, motion, the tile map),
which the unit tests check without a browser; `src/client/office/` only draws what they decide.
The end-to-end tests feed fixture worlds (`test/fixtures/worlds/`, generated by
`scripts/world-fixture-lib.ts`) to the real page through a fake `EventSource`.

MIT licensed; see `LICENSE`.
