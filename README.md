# Cubiclark

A local view of live Claude Code agents and their states, read from transcripts and, optionally,
from a small hooks collector. Runs entirely on your machine, on `127.0.0.1`; it never calls a
model and never sends anything off the machine.

The page is a pixel-art office: every agent is a character at a desk, and what it is doing shows
in its pose, its speech bubble and its desk lamp. Beside it a terminal-style panel shows the
selected agent, the session log and how the work is organised: tasks and their timelines, the
quota, what is waiting on you. Behind it are a transcript parser, a hook collector, a state reducer
and two tailing sources that merge into one world, optional adapters that read how your work is
organised (task folders, quota samples, `claude agents`), and the commands to install, remove and
check the collector and to replay a stretch of the past. A plain list of the same agents is one
click away.

## Two ways to see agents

- **Transcripts only (nothing to install).** Cubiclark tails Claude Code's own transcript files
  (`~/.claude/projects/**/*.jsonl`). It changes no settings at all. It cannot see a permission
  prompt, a compaction in progress, or the moment a session ends.
- **With hooks (live and precise).** `cubiclark hooks on` adds a collector to Claude Code's user
  `settings.json`. Claude Code then tells Cubiclark about session starts and ends, prompts, tool
  calls, permission requests, compactions, failures and subagents as they happen. Transcripts stay
  in use for what hooks do not carry (the model, compactions, a manual denial, an interrupt).

Verified against Claude Code **2.1.285** and its hooks reference. `cubiclark doctor` says which
version you run and whether it is the one the hook events were checked on.

## Hooks

```
cubiclark hooks on [--no-tools]   # install the collector
cubiclark hooks off [--purge]     # remove it
cubiclark hooks status            # what is installed, and whether it is paused
cubiclark hooks pause             # soft-off: the collector exits 0 and writes nothing
cubiclark hooks resume
cubiclark doctor                  # the version, each source, and why lines did not parse
cubiclark doctor --adapters       # also: what each configured adapter found
cubiclark replay --since 3h       # play back the last three hours, 10 times as fast
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

node dist/cli.js [--port <n>] [--no-open] [--fixture-home <dir>] [--since-hours <n>] [--state-dir <dir>] [--config <file>]
node dist/cli.js replay --since <duration> [--speed <n>] [--fixture-home <dir>] [--state-dir <dir>]
node dist/cli.js doctor --adapters --fixture-home test/fixtures/day/home --state-dir test/fixtures/day/state
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

## The panel

On the right of the page (below the office on a narrow window), in monospace, collapsible with
"Hide panel" (remembered per browser). Click an agent in the office, a row of the list or a row of
the log to select it; click it again to clear.

- **Title bar:** the legend (shirt colour by model family, the accessory of each role) and whether
  the page is connected.
- **Agent card:** kind, role, model, effort (when an adapter knows it), task and its phase, state
  and since when, counters, what `claude agents` says about it, and its error.
- **Session log:** `time · agent · event · result`, oldest at the top and newest at the bottom, by
  time. Prompts, tool results (the tool, a file's basename or a command's first word, and ok, error
  or denied), turns, sessions starting and ending, subagents starting, permission waits, errors. Never
  a prompt or a tool's content. Filter by project or by task.
- **Task timeline:** for the selected agent's task, else the newest live one (or pick one): planning,
  building, review and done with where the task is, and its entries, with a mark where the model
  changed ("opus → sonnet"). The **whiteboard** in the planning room shows the same task in small.
- **Status bar:** sources and adapters live, agents busy out of total, permission waits (always
  shown, zero too), quota, unparsed lines, and during a replay its speed and clock.

The **wall meter** in the manager's office shows the 5-hour quota over the 7-day quota (green, amber
from 70%, red from 90%; ringed red while an agent is rate limited).

## Adapters

Optional, read-only, and off until `~/.cubiclark/config.json` names them. Three come with
Cubiclark; `docs/adapters.md` is the reference for the interface, the configuration and every file
format.

- **Task folders.** A folder of task folders (`TASK.md`, `STATUS.md`, `LOG.md`, `session`) gives
  tasks with a phase (planning, building, review, done, blocked), a timeline with the model and
  effort of each session, and which session belongs to which task. An agent whose task is being
  planned sits in the planning room; the orchestrator is found by its working directory. The format
  is documented so that anyone can write it.
- **Quota samples.** A JSONL file of `limit_5h_pct` / `limit_7d_pct` samples (or a glob of daily
  files) feeds the wall meter and the status bar. A sample whose reset time has passed reads as zero.
- **`claude agents`.** Runs the local `claude agents --json` (no model is called) to learn which
  background sessions are busy, waiting or idle, and what a waiting one waits for. Never more than
  once every 15 seconds, and only when the configuration says `"enabled": true`.

`cubiclark doctor --adapters` says what each configured adapter found and why one is missing.

## Replay

`cubiclark replay --since 3h [--speed 10]` plays the last three hours (`90m`, `1h30m`, `2d`; at most
14 days) on the same page. Everything that happened before the window is applied at once, so the
agents that were already there are in the office when it opens; the rest arrives 10 times as fast.
The quota is the sample at that time and each task's timeline is cut there. It reads the same files
as the live page and never writes anything. `claude agents` is not asked in a replay, since it
describes the present.

## What else the page shows

A line naming each source and adapter and its health, a diagnostics line (unparsed lines with the
reasons, unknown record types and hook shapes, Claude Code versions seen, source errors), and the list:
a table of every agent (kind, parent, project, model, state, since, current tool). A subagent appears
under the agent that started it, and a permission wait reported by a hook reads "waiting for
permission" while a guess from transcripts alone reads "waiting for permission? (inferred)".

**When lines do not parse.** `cubiclark doctor` prints an `unparsed by` line: how many transcript
lines were not turned into events, by reason (`not_json`, `not_object`, `no_type`, `no_timestamp`,
`unknown_type`, `unknown_subtype`, `handler_rejected`) and by record type, never any value from the
lines. Bookkeeping records that Claude Code writes without a timestamp (`mode`, `last-prompt`,
`permission-mode`, ...) borrow the file's newest one, so they do not count.

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
  exists in real 2.1.284 and 2.1.285 transcripts; its value is unverified, and the hooks reference offers no
  background marker. If it is wrong, a background worker shows as an ordinary session: wrong, but
  harmless. Every guessed transcript value lives in `src/core/transcript/guesses.ts`.
- **The transcript format is not documented and is pinned to Claude Code 2.1.285.** Every
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
- **The quota file's format is read tolerantly.** The status line's own keys are documented in
  `docs/adapters.md`; other spellings of the reset times are accepted, and a reset it cannot read only
  means the sample is treated as stale after its window.
- **`claude agents` is polled, so what it says can be 15 seconds old.** It only ever adds a permission
  wait, once per fetch, and never for an agent that hooks report on.
- **Notes in a task's `LOG.md` (`- 2026-01-15 13:00 …`) are read as local time**, and the entry that
  `STATUS.md` adds is dated by the file's modification time.
- **The panel takes 380 px, so the office stays at scale 2 only in a window at least 1580 px wide.**
  Below that the office steps down to scale 1 (with the panel hidden it fits again); below 1100 px
  the panel goes under the office.
- **A replay of adapter data is approximate.** A task's timeline is cut at the replay clock, but a
  file's contents are read as they are now.
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
