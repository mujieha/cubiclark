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
and the backups stay in `~/.cubiclark` unless you pass `--purge`, which also deletes the events
files and the soft-off flag (and the directory, if that leaves it empty). `--purge` never deletes
anything else in that directory: `config.json`, `assets/` and `backups/` stay (a backup may be the
only copy of your settings from before Cubiclark), and it refuses `/` and your home directory.

**After an upgrade, run `cubiclark hooks on` again**: it adds the entries a newer version needs
(this phase added `PostModelSwitch`, so the model of a running session follows a model switch) and
keeps the backup of your original settings. `PreModelSwitch` is never installed, because a hook on
it can block a model switch.

**`--no-tools`** installs the 12 lifecycle events only (no `PreToolUse`, `PostToolUse` or
`PostToolUseFailure`), for people who do not want any tool activity recorded. Transcripts then
remain the only source of tool activity.

**What the collector stores.** One line per event in `~/.cubiclark/events.jsonl` (rotated at 5 MB,
one old file kept): the event name, a timestamp, the session id, the subagent id and type, the
working directory, the tool name and its id, and a *reduced* target (a file's basename, a command's
first word, a URL's host, a subagent type), plus a few enum values (why a session ended, a
compaction's trigger, an API error's kind, the permission mode, the effort level, a session's
starting model, the model a session switched to). It never stores prompt text, tool input or output, error text, assistant text or
anything it does not recognise. `test/whitelist.test.ts` feeds it payloads full of fake secrets and
checks that none survives.

**What it never does.** The collector exits 0 with empty stdout on every path, including
malformed input, so it adds nothing to any session's context. It never answers a permission
request. If it breaks, Claude Code carries on exactly as before. Eleven of the events are installed
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

node dist/cli.js [--port <n>] [--no-open] [--fixture-home <dir>] [--since-hours <n>] [--state-dir <dir>] [--config <file>] [--assets <file>] [--no-mascot] [--idle-desks <n>]
node dist/cli.js replay --since <duration> [--speed <n>] [--fixture-home <dir>] [--state-dir <dir>] [--assets <file>] [--no-mascot] [--idle-desks <n>]
node dist/cli.js doctor --adapters --fixture-home test/fixtures/day/home --state-dir test/fixtures/day/state
node dist/cli.js doctor --fixture-home <an empty folder> --assets <manifest.json>   # checks a custom-assets pack; exit 1 if invalid
```

Every test uses fixture directories under a temp dir and never reads or writes the real
`~/.claude` or `~/.cubiclark`. `--fixture-home <dir>` points the CLI at a stand-in Claude config
directory (`test/fixtures/home` is one), and `--state-dir <dir>` at a stand-in state directory
(`test/fixtures/state`). Fixture mode disables the age window and freezes the page's clock at the
newest record found, so a fixture world never looks stale just because the checkout is old.

## The office

The page opens on the office; the button in the header (or `#list` at the end of the URL) switches
to the list. Both show the same agents (see *Who is in the office*), and an end-to-end test compares
them agent by agent.

**Rooms.** An orchestrator (a session that started background sessions, or one an adapter names)
sits in the *manager's office*; a planner (or an agent whose task is in its planning phase) in the
*planning room*; a reviewer in the *review corner*. Everyone else sits at a desk on the *project
floor*, one cluster of desks per project. A subagent or teammate sits on a *stool* beside its
parent's desk (three stools per desk, then a bench); a subagent of a subagent sits beside the
top-level agent. An agent that has finished or ended walks out of the door and leaves a tag on the
board in the *lobby* for a while, so nobody the list shows is missing from the office. Seats stay put as the
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

**Performance.** The canvas is capped at 30 frames a second, pauses while the tab is hidden, and
stops entirely while the list is showing. The office fills its column in tiles of a whole number of
CSS pixels (16 to 56); its pixel art is drawn at a whole number of canvas pixels per art pixel and
stretched by the browser, so it stays crisp, and every word is on a second canvas laid exactly over
it, drawn at the display's own resolution (10 to 20 CSS px) and redrawn only when a word changes. With
50 agents a draw takes about a millisecond, and with 100 (`test/e2e/office-perf.spec.ts`, which fails
under 30 frames a second) about two. A crowd of 250 agents (40 working, 200 idle, 10 gone) shows 49
of them and holds 30 frames a second with no task over 200 ms while the World is pushed every second
for 30; the same crowd with every idle session given a desk (`--idle-desks 1000`) is over 300 rows
tall, and the canvas is then drawn at a lower pixel density rather than past the size a GPU keeps a
canvas in (16384 px a side).

**Themes.** The button at the left of the header cycles *Auto*, *Day* and *Night*. Auto follows the
operating system's light or dark setting, and changes while the page is open when the setting does.
Day is a light page around the office as it has always been drawn; night is a dark page and an office
with the lights turned down (darker walls and wood; the lamps, marks and shirts stay bright so every
state is still told apart). The choice is remembered per browser; with storage blocked the page still
works and the choice lasts until it is closed. Each theme is one file (`src/core/theme/day.ts`,
`night.ts`) and must pass the same contrast and distinctness rules as a custom palette.

**Custom assets.** `cubiclark --assets <manifest.json>` (or `~/.cubiclark/assets/manifest.json`)
changes the office's colours per theme and redraws characters, accessories and floors, from a JSON
file that is checked as data. `docs/assets.md` has the format, the ids and the rules,
`schema/assets-manifest.v1.json` the JSON Schema and `examples/assets/sunny-office/` an example.
Errors are shown on the page and by `cubiclark doctor --assets <file>`; a manifest with any error is
not applied at all.

**The first run.** With no transcripts folder yet (or none with anything in it) and no collector
installed, the page shows a setup screen instead of an empty office: it explains the two ways of
seeing agents above and gives the command for the second (`cubiclark hooks on`).

## Who is in the office

The office, the list and the panel show only the agents that matter now, and say how many they leave
out. One rule (`src/core/visible.ts`) decides, and the page applies it once to each update:

- **Every agent that is working is shown:** thinking, reading, editing, running, searching, browsing,
  delegating, compacting, starting, waiting for a permission, rate limited or stuck.
- **Of the sessions waiting for you, the five most recently active are shown.** `--idle-desks <n>` (on
  the default command and on `replay`; a whole number from 0 to 1000) changes the five; with 0 no
  idle session has a desk. Background workers count as sessions here. (A subagent finishes when its
  turn ends rather than waiting for you, so in practice it is not among them.) An idle parent of a
  working helper stays, and does not use one of the n, so the helper keeps its stool beside it.
- **An agent that has finished or ended stays for 10 minutes, and one that has failed for 30** (it
  needs a look), counted from when it stopped. After that it is gone.
- **The rest leave without a sound**: no walk-out, no tag on the board, no line in the session log. An
  agent that is hidden and becomes active again is back on that very update, and walks in through the
  door like anyone who arrives.
- **The trace:** the line under the office and the panel's status bar say `195 idle not shown · 6
  finished not shown` (only the parts that are not zero). When nothing at all is in view the page says
  `No agents working right now · 7 idle not shown` and not that there are no agents.

The World itself is not changed: the server, `world.json`, the session log and `cubiclark doctor`
still hold and count every agent. Hiding is only what the page shows. The lines of a hidden agent stay
in the session log as history (under their short id) and are left out when the log is filtered by
project or task; a hidden agent cannot be selected, and one that is selected when it drops out of view
is deselected.

A subagent whose transcript is outside the window (`--since-hours`, 12 by default) does not exist at
all: its sidecar file (`agent-<id>.meta.json`) is read only when the transcript beside it is being
read. A home with hundreds of old sessions used to fill the office with subagents that nothing could
ever update.

## Morty

Morty is the office corgi, there just for fun. He starts the day asleep in his basket in the lobby,
and then gets up to things, one at a time: he walks from room to room by the hallway, naps, drinks
from his bowl in the corner of the project floor, runs to the door and wags his tail when someone
arrives, sits beside an agent that is at work, sniffs the whiteboard in the planning room (when
nobody is sitting under it), and plays ball with an agent that has been *waiting for you* for more
than a minute. What he does next, and
for how long, comes from a seed made from the day's date, so every day is a little different. There
is no sound, and he never has a bubble.

**He is not an agent, and playing is not a state.** The list, the panel and the agents table never
mention him, he has no button and no Tab stop, and he is not counted. An agent that plays ball with
him is still *waiting for you* in every word the page says: it stands up beside its chair, side-on,
with an arm out and a ball in its hand, its lamp stays amber and it has no bubble. It is drawn like
that only while it really is in that state, and it sits back down on the next frame after anything
changes. It cannot be mistaken for an agent asking for a permission (which stands and waves, with a
red lamp and a red bubble), a frozen one or one walking out. He plays only with an agent at its own
desk, never with a helper on a stool.

He is drawn on the floor, under the characters, desks, lamps, monitors, board tags and bubbles, and
the map of where he may stand leaves out every tile any of those touches, so he never covers one
(`test/office-mascot-map.test.ts` checks it in every fixture world, and `test/office-mascot.test.ts`
follows him for half an hour). Hover him for the label *Morty (mascot)*, which a screen reader reads
too. With reduced motion he is asleep in his basket and nothing moves. He is not in the four empty
offices.

**Turning him off.** The *Morty* button in the header, after the theme button, switches him and his
basket and bowl off and on; the choice is remembered in this browser like the theme (with storage
blocked he is on, and the button works until the page is closed). `cubiclark --no-mascot` and
`cubiclark replay --no-mascot` leave him out altogether: no Morty, no basket, no bowl, no button.
Off, the office is exactly the picture it was before him, and an end-to-end test compares both ways
of turning him off with that older screenshot.

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
`unknown_type`, `unknown_subtype`, `handler_rejected`, `too_long`) and by record type, never any value from the
lines. Bookkeeping records that Claude Code writes without a timestamp (`mode`, `last-prompt`,
`permission-mode`, ...) borrow the file's newest one, so they do not count.

## Known limits

- **An approved permission still reads "waiting for permission" until the tool finishes.** No hook
  fires when you approve, only when the request is made and when the tool ends.
- **Nested subagents are parented to the session** until the transcript's sidecar file says
  otherwise; hooks report a subagent's session, not which subagent started it.
- **The rotated `events.1.jsonl` is not read at start-up.** Only the current file is.
- **A brand-new transcript can take up to about seven seconds to appear** when the file system's
  change events do not name it (it is a rescan of `projects/`, at most once every 5 seconds, plus the
  2-second poll). A line added to a transcript already known arrives within the poll, as before, and
  where the events do name the file it is found at once. Nothing outside `projects/` and each
  session's `subagents/` folder is ever listed, so a busy config folder costs nothing.
- **A rescan lists every file under `projects/`, old sessions included,** so its cost grows with the
  history Claude Code keeps there. `cubiclark doctor` prints it (the `scans` line: files walked,
  folders listed, milliseconds).
- **A session waiting for you that is not among the five most recently active is not in the office
  or the list**; only the status bar counts it (`--idle-desks <n>` changes the five). A `stuck` agent
  is shown for as long as it is stuck, however old, since it may need a look.
- **A very tall office is drawn at a lower pixel density.** The canvas is capped at 16384 px a side
  and 16 million px in all (the size a GPU keeps a canvas in); a 300-row office on a display of twice
  the density has its pixel art drawn at half the detail and stretched by a whole number, and its
  words (on their own canvas, under the same limits) at a little over half of the display's
  density, so they are softer.
- **Two collectors rotating at the same instant can lose a few lines.** Rare, and only at the
  5 MB boundary.
- **Model and effort.** Hook payloads carry the model only on `SessionStart` (and not always) and,
  since `PostModelSwitch`, when it changes; the model otherwise comes from transcripts. The
  `PostModelSwitch` payload's field name (`to_model`) is read from the hooks reference's prose, which
  shows no example: until seen on a real session, a different name just stores nothing.
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
  no tolerance, and the system font behind the words (room names, signs, the whiteboard label and
  bubble text, drawn in it at 10 to 20 CSS px on their own canvas at the display's resolution)
  decides those pixels. On another system, regenerate them with `npx playwright test
  --update-snapshots` and look at them before committing. Two of them are pictures at twice the
  density (`test/e2e/readable.spec.ts`). Only Chromium is in CI; `npm run test:e2e:firefox` is a
  manual extra.
- **Words are drawn in the system monospace font, not a pixel font, and are cut to fit.** Bubble
  text is cut to 12 characters with an ellipsis, and again to the room its bubble has when the
  office is small, or when another bubble covers the end of it; a project name too long for its
  sign is cut the same way. The full text is in the tooltip and the list.
- **The quota file's format is read tolerantly.** The status line's own keys are documented in
  `docs/adapters.md`; other spellings of the reset times are accepted, and a reset it cannot read only
  means the sample is treated as stale after its window.
- **`claude agents` is polled, so what it says can be 15 seconds old.** It only ever adds a permission
  wait, once per fetch, and never for an agent that hooks report on.
- **Notes in a task's `LOG.md` (`- 2026-01-15 13:00 …`) are read as local time**, and the entry that
  `STATUS.md` adds is dated by the file's modification time.
- **The office fills its column, in tiles of 16 to 56 CSS px.** The panel takes 380 px, so a 1600 px
  window gives 32 px tiles and a 1280 px one 23 px tiles; below 1100 px the panel goes under the
  office. With the panel hidden, a window wider than 2272 px stops at 56 px tiles and leaves the rest
  of the column empty.
- **Between whole scales, on a display of ratio 1, the art's pixels are not all the same width.**
  A 1280 px window has 23 px tiles, whose art pixels are 1 or 2 device pixels wide, so a checkerboard
  can look uneven. Tiles always line up, edges stay hard, and on a display of twice the density
  the difference is not visible. The art itself is always drawn at a whole number of canvas pixels
  per art pixel.
- **A replay of adapter data is approximate.** A task's timeline is cut at the replay clock, but a
  file's contents are read as they are now.
- **Developed and tested on macOS** (the CI runner is a Mac). Linux and Windows are untested.
- **Helper bubbles can still touch a long desk bubble.** A helper's bubble now sits beside its
  stool, clear of the cluster's sign and of the neighbouring helper's head, but in a packed cluster
  there is sometimes no free place, and it then covers part of a desk's bubble (in the two crowded
  test worlds, 2 of 43 and 6 of 86 bubbles). The tooltip and the list always have the full text.
- **The accessibility checks cover the panel, the list view and the setup screen**, with axe-core in
  both themes (`test/e2e/a11y.spec.ts`: no violations of any impact). The office canvas is decoration
  (`aria-hidden`); its agents are the buttons over it, labelled as the list is, and the
  contrast of text drawn on the canvas is set by the palette rules, not measured by axe.
- **The theme choice is per browser**, and a custom-assets manifest or a configuration file is read
  once, at start: change it and restart.
- **`StopFailure`'s payload is not shown in the hooks reference** (only its matcher, `error_type`),
  so the collector reads the field as `error` or `error_type`. It is unverified on a real failing
  session. `PostModelSwitch`'s `to_model` is read from the reference's prose in the same way.
- **Cubiclark assumes a single-user machine.** The run token is in the URL, so the browser's command
  line and history show it to other local accounts (`SECURITY.md`).
- **A command's first word is kept unless it looks like a credential** (over 40 characters, `=`, `:`
  or `@` in it, `sk-`, `ghp_`, `xox`, `AKIA`, ...): a secret that does not look like one and is typed
  where a command goes would still be stored. `hooks on --no-tools` stores no tool activity.
- **`hooks on` writes `settings.json` through a temp file and a rename**, so its mode is what the
  umask leaves and its owner, group and hard links are those of the new file.
- **A very large transcript is read in full on a first start**, in bounded pieces: memory stays
  bounded, the time it takes does not.
- **A custom-assets pack cannot change Morty**: his frames, his three colours, his basket, bowl and
  ball, and the pose of an agent playing ball are not in the catalogue of what a pack may replace,
  and a pack's palette is not checked against his coat (the rules only keep his coat apart from the
  red and amber lamps in the built-in themes).
- **Where bubbles close every way, Morty walks under them.** They are drawn over him, so he never
  covers one; lamps, monitors and tags are kept clear even then. An agent that has left keeps its
  desk drawn for five seconds, and Morty does not know about it: he is drawn under it.

## Development

TypeScript, ESM, Node 22.12+, no runtime dependencies. `node:http` and Server-Sent Events for the
server (no web framework); Vite and Canvas 2D for the client; Vitest for tests; ESLint with a rule
banning `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` (and a test that proves
it fires), another banning `console` in the collector, and another keeping `src/core` pure (no DOM,
no `Date.now`). See `SECURITY.md` for the threat model.

The office is drawn entirely in code, with no image files: sprites are grids of characters over one
16-colour palette per theme (`src/core/theme/`, `src/client/office/art/`), baked to canvases at load. What is drawn where is
decided by pure functions in `src/core/office/` (`layout`, the state table, motion, the tile map),
which the unit tests check without a browser; `src/client/office/` only draws what they decide.
The end-to-end tests feed fixture worlds (`test/fixtures/worlds/`, generated by
`scripts/world-fixture-lib.ts`) to the real page through a fake `EventSource`.

MIT licensed; see `LICENSE`.
