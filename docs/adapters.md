# Adapters

Cubiclark shows what Claude Code does from its transcripts and, optionally, from hooks. **Adapters**
add what those cannot know: how the work is organised. They are all optional, they only read, and the
app is complete without any of them.

| Adapter | Reads | Adds |
|---|---|---|
| `task-folders` | a folder of task folders (`TASK.md`, `STATUS.md`, `LOG.md`, `session`) | tasks, their phase and timeline, the model and effort of each session, which session belongs to which task, and the orchestrator |
| `quota-samples` | a JSONL file of quota samples, such as the status line writes | the quota on the wall meter and in the status bar |
| `claude-agents` | the output of the local `claude agents --json` | which background sessions are busy, waiting or idle, and what they wait for |

Nothing here calls a model or leaves the machine. `claude-agents` is the only adapter that runs a
program, so it is off unless the configuration turns it on.

## The interface

An adapter is an object with this shape (`src/core/adapters/types.ts`, design §4):

```ts
interface OrchestrationAdapter {
  readonly id: string
  /** How often the host asks for a new snapshot when nothing was watched to change. */
  readonly pollMs: number
  /** Cheap; never throws; false when the source is absent. */
  detect(env: AdapterEnv): Promise<boolean>
  snapshot(): Promise<AdapterSnapshot>
  /** Optional file watching; returns the unsubscribe function. Never throws. */
  watch?(onChange: () => void): () => void
  /** Optional: one line for the status bar and `doctor --adapters`, from the last snapshot. */
  describe?(nowMs: number): { detail: string; failing?: boolean }
}

interface AdapterEnv {
  nowMs: () => number   // the clock the World runs on: real, a fixture's frozen one, or a replay's
  wallMs?: () => number // real time when nowMs is not it; only used to clamp file times
  home: string          // only for expanding `~` in configured paths
}

interface AdapterSnapshot {
  tasks?: Task[]                       // a live adapter with none says so with []
  links?: AgentLink[]                  // { agentId, taskId, role?, effort?, model? }
  orchestratorCwds?: string[]          // top-level sessions in one of these are orchestrators
  quotaSamples?: QuotaSample[]         // sorted by time, oldest first
  cliSessions?: CliSession[]           // from `claude agents --json`
  cliFetchedAt?: string
  diagnostics: { unparsed: number; errors: string[] }
}
```

The rules for an adapter:

- **`detect()` is cheap, never throws, and is `false` when its source is absent** (a folder that
  does not exist, a file that is a directory, a program that cannot run). `test/adapter-detect.test.ts`
  checks eleven kinds of absent or broken source for the three first-party adapters.
- **`snapshot()` should not throw either.** What could not be read goes into `diagnostics.errors`
  (name the task and file, never an absolute path). A snapshot that does reject marks the adapter
  `failing` and keeps its previous snapshot.
- **An adapter never writes** to its source, and never puts a filesystem path into what it returns:
  paths are reduced to their last segment before they reach a `Task`.
- `pollMs` is a ceiling on staleness, not a promise: `watch()` may refresh sooner.

The **host** (`src/server/adapters/host.ts`) calls `detect()` on every configured adapter at start,
takes a first snapshot of the ones found and merges their latest snapshots (`mergeSnapshots`). An
adapter whose source is absent is `missing` and looked for again every 30 seconds. Each adapter
refreshes on its own schedule, and refreshes of one adapter never overlap (a request that arrives
mid-refresh asks for one more pass).

### How a snapshot reaches the World

The store keeps the latest merged snapshot and re-applies it on every tick
(`applyAdapters`, `src/core/adapters/apply.ts`), so the quota reset rule needs no new snapshot. The
result is the same whether applied once or many times.

1. **Tasks.** `world.tasks` is the snapshot's tasks by id.
2. **Links.** For each agent named by a link (the agent id is the session id): `taskId` is set;
   `effort` and `model` are filled only where the agent has none (the transcript wins). `role` is set
   from the link only when the agent's role is undefined, `builder`, `planner` or `reviewer`; an
   `orchestrator` or `explorer` is never overwritten. If an agent has several links, the task with the
   newest activity wins.
3. **The orchestrator.** A session or background worker with no parent whose working directory equals
   one of `orchestratorCwds` (trailing slashes ignored) gets the role `orchestrator`.
4. **`claude agents`.** Each listed session that is an agent in the World keeps what the CLI said
   (`Agent.cli`); a session the CLI calls `background` becomes kind `background`; its name is a label
   when the agent has none. A session that leaves the list forgets what it said.
5. **A permission prompt the CLI reports** makes the agent `waiting_permission` (observed) when the
   agent is not hooked, is not finished, and the fetch is newer than its last activity. This happens
   once per fetch, so a later transcript event is never overridden by the same stale answer.
6. **Quota.** `world.quota` is the quota at the World's clock (see below).

The planning room fills from this: an agent whose task is in `planning` is a planner (rule 2 above
gives it the role, and `effectiveRole` in `src/core/office/roles.ts` puts planners in the planning
room).

## Configuration

`~/.cubiclark/config.json` (the state directory's `config.json`; `--state-dir` or `CUBICLARK_HOME`
move it, `--config <file>` names another). **A missing file means no adapters.** A fixture home
(`--fixture-home`) without `--state-dir` or `--config` reads none, so a test never touches the real one.

```json
{
  "adapters": {
    "task-folders": {
      "roots": ["~/work/orchestrator/tasks"],
      "orchestratorCwd": "~/work/orchestrator",
      "windowHours": 72
    },
    "quota-samples": { "file": "~/.claude/metrics/samples-*.jsonl" },
    "claude-agents": { "enabled": true, "bin": "claude", "pollSeconds": 15 }
  }
}
```

| Key | Meaning |
|---|---|
| `task-folders.roots` | Required: a non-empty array of folders. Each direct subfolder with a `TASK.md` is a task. |
| `task-folders.orchestratorCwd` | A path or an array of paths. Default: the parent folder of each root. |
| `task-folders.windowHours` | Only tasks active within this many hours are shown. Default 72; `null` shows every task. (A fixture home has no window unless the file sets one.) |
| `quota-samples.file` | Required. A path, or a path whose last segment is a glob (`*` and `?`): see below. |
| `claude-agents.enabled` | Must be `true`, or the adapter does not exist. |
| `claude-agents.bin` | The program to run. A bare name is looked up on `PATH`; anything with a slash is a path. Default `claude`. |
| `claude-agents.pollSeconds` | How often to ask. Never below 15. |

`~` and `~/…` expand to the home directory; a relative path resolves against the folder the config
file is in. A problem with the file (not JSON, an unknown key or adapter, a section missing what it
needs) is a warning shown by `cubiclark doctor --adapters` and on the sources line under the office,
and never stops the app. **A config file that someone else could have written keeps `task-folders`
and `quota-samples` but drops `claude-agents`**, because that section names a program to run.
"Could have written" is: the group or world write bit is set, the file is owned by another user, or
its folder is owned by another user (other than root) or can be changed by group or others (a folder
with the sticky bit set, like `/tmp`, is fine when root or you own it). The file is opened once and
checked and read through that one descriptor.

`cubiclark doctor --adapters` detects and reads each configured adapter once and says what it found:

```
task-folders  live      5 tasks (1 planning, 1 building, 1 review, 1 blocked, 1 done) in 1 root · 0 unparsed log lines
quota-samples live      5h 62% · 7d 40% · newest sample 2026-01-16T17:30:00.000Z
claude-agents live      4 sessions · fetched 0s ago
```

## The task-folder format

A **root** is a folder. Each direct subfolder that contains a `TASK.md` is a **task**, and its
folder name is the task's id. Anything else in the root (files, folders without a `TASK.md`) is
ignored. Nothing else about the folder is assumed; anyone can write these files.

| File | Written by | Content |
|---|---|---|
| `TASK.md` | whoever creates the task | see below |
| `STATUS.md` | the worker | its first non-blank line is `state: planned`, `in_progress`, `done` or `blocked` (any other value reads as unknown). Optionally a mention of the pull request. |
| `LOG.md` | the orchestrator's scripts and the orchestrator | one line per event, see below |
| `session` | the orchestrator's scripts | the current worker session id, one line |

**`TASK.md`.** The first `# ` heading is the heading. These keys are read from lines that start with
them (the first such line wins): `Goal:` (the task's title, at most 160 characters), `Project:` (or
`Project dir:`; only its last segment is kept), `Model:`, `PlanModel:` (the model that plans; a
dispatch with it means the task is being planned) and `Effort:`.

**`STATUS.md`.** The state is the first non-blank line, matched as `state: <value>` in any case. A
pull request is the first match of `PR #12`, `pull request #12` or a `/pull/12` link anywhere in the
file.

**`LOG.md`.** Blank lines, `#` headings and `---` rules are skipped. Every other line is one of:

Machine lines start with an ISO UTC timestamp and a verb: `<2026-01-15T10:00:00Z> <verb> <rest>`.
Inside `<rest>`, `model=<id>`, `effort=<level>`, `perms=<mode>` and `(compactions=<n>)` are read in
any order and removed from the text.

| Verb and shape | Timeline entry |
|---|---|
| `dispatched session <id> in <path> model=… effort=… perms=…` | kind `dispatched`, text `dispatched in <last segment of path> (<perms>)`, the model; `<id>` is the current session |
| `forked <from> -> <to> model=… effort=… (compactions=N) <note>` | kind `forked`, text `forked`, ` after N compactions` when N is above 0, then the note; the model; `<to>` is the current session |
| `resumed <id> model=… effort=… <note>` | kind `resumed`, text `resumed <note>`, the model; `<id>` is the current session |
| `paused <text>` | kind `paused`, text `paused <text>` |
| `verified by orchestrator: <text>` | kind `done`, text `verified: <text>` |
| any other verb | kind `note`, text `<verb> <rest>`, counted as an unknown verb |

Note lines are written by hand: `- 2026-01-15 13:00 <text>`. The date and time are **local time**. They
become kind `note` entries.

A session id counts only if it is a full UUID. Every text is reduced first: any token that looks like
a path (`/home/user/projects/demo`, `~/x/y`, `./rel/z`) becomes its last segment, extra spaces
collapse, and the text is cut to 160 characters. A line that is none of the above is counted as
unparsed, never dropped silently (`doctor --adapters` shows the count).

**The timeline.** The entries of `LOG.md`, plus one entry from `STATUS.md`, dated by the file's
modification time (never later than now): `planned` gives kind `planned` ("plan written"), `blocked`
kind `blocked`, `done` with a pull request kind `pr` ("PR #12"), `done` without one kind `note`
("worker reports done"). `in_progress` adds nothing. Entries are sorted by time (equal times keep
file order) and the newest 200 are kept. A **model change** is an entry whose model differs from the
previous entry that had one; the HUD marks it ("opus → sonnet").

**The task's model and effort** are the newest ones named in `LOG.md`, else `Model:` and `Effort:`
from `TASK.md`. The task's **sessions** are every id named in `LOG.md` (oldest first) plus the `session`
file; the **current** session is the `session` file's, else the newest one in `LOG.md`.

**The phase.** First match wins:

1. a `verified` line newer than every dispatch, resume and fork: `done`;
2. `state: blocked`: `blocked`;
3. `state: planned`: `planning`;
4. `state: in_progress`: `building`;
5. `state: done` (with or without a pull request, and not yet verified): `review`, **unless the
   newest entry on the timeline is more than 24 hours older than the clock: then `done`** (5a: the
   task was accepted by other means, so it does not wait in the review corner for ever);
6. no `STATUS.md`, or an unknown state: the newest dispatch, resume or fork decides, `planning` when
   it ran the task's `PlanModel` and `building` otherwise;
7. otherwise, no phase.

A dispatch after a verification reopens the task (rule 1 no longer holds), and a dispatch after an
old `done` is newer activity, so rule 5a does not fire. Rule 5a is measured against the clock the
page runs on: the replay clock in a replay (a replay's cut of a task is decided by its newest entry
alone). `blocked`, `planned` and `in_progress` are never aged.

**The window.** Only tasks with activity in the last `windowHours` (default 72) are shown: a task whose
newest timeline entry and whose `STATUS.md` are both older than that is left out.

**Limits (a hostile or huge folder cannot hurt the page).** `LOG.md` is read from its last 1 MiB (the
first, cut line of that tail is dropped), `TASK.md`, `STATUS.md` and `session` from their first 64 KiB.
A task keeps its 50 newest session ids (and always the current one), and 200 timeline entries. A
symlink named `TASK.md`, `STATUS.md`, `LOG.md` or `session` is not followed, and a task folder that is
a symlink is skipped. `Model:`, `PlanModel:`, `Effort:`, `model=`, `effort=` and `perms=` are kept
only when they are a plain name (letters, digits and `._:[]-`, at most 64 characters); `Project:` is
its last `/` or `\` segment, at most 60 characters. Text with a Windows path (`C:\Users\x\y`) is
reduced like a Unix one. **Known gap:** a relative path with a slash inside (`projects/demo`) in a
timeline text is kept as written, since it names no directory outside the task.

**Roles.** Every session a task names gets a role from the task's phase: `planning` gives `planner`,
`building` gives `builder`, `review` gives `reviewer`; `done`, `blocked` and no phase give none.

## Quota samples

One JSON object per line. The status line that Cubiclark was built beside writes them like this, one
file per day (`samples-<date>.jsonl`), **with times in epoch seconds**:

```json
{"ts":1768570200,"limit_5h_pct":62,"limit_7d_pct":40,"limit_5h_resets":1768575600,"limit_7d_resets":1768795200}
```

- **Lines without both percentages are other metrics** and are skipped silently (counted as
  `skipped`, not `unparsed`). Only a line that is not JSON, not an object, or has percentages but no
  readable time is unparsed.
- The reader is tolerant, because the writer is not Cubiclark's: a time may also be an ISO string or
  epoch milliseconds (`ts`, `timestamp` or `time`); the resets may be `limit_5h_resets` /
  `limit_7d_resets`, `resets_5h` / `resets_7d`, `resets_5h_at` / `resets_7d_at`, or a `resets` object
  with keys `5h`/`7d` or `five_hour`/`seven_day`; percentages may be numeric strings and are clamped
  to 0 to 100.
- **`quota-samples.file` may end in a glob** (`~/.claude/metrics/samples-*.jsonl`). The directory is
  listed again on every poll and the newest matching file by modification time is read, so a new day's
  file is picked up. If the newest file has no samples yet (just after midnight), the one before it
  is read too.
- Only the last 256 KiB of a file is read, and a partial first line is dropped, not counted.
  Samples older than eight days are ignored; at most the newest 2000 are kept.

**The reset rule.** The quota at a moment is the newest sample at or before it. For each window (5
hours, 7 days): if the sample's reset time has passed, the window reads **0** and has no reset time;
if it has no reset time and the sample is older than the window, it reads 0 as well. So a stale
sample never shows as current usage. The wall meter draws the 5-hour bar over the 7-day bar, green,
amber from 70% and red from 90%.

## `claude agents`

`claude agents --json` prints the active sessions as a JSON array (documented at
code.claude.com/docs/en/agent-view). These fields are used and no others; each string is cut to 40
characters:

| Field | Used as |
|---|---|
| `sessionId` | the agent id (kept only if it is a UUID); an entry without one cannot be matched |
| `kind` | `interactive` or `background` |
| `state` | `working`, `blocked`, `done`, `failed` or `stopped`; any other value is `other` |
| `status` | `busy`, `waiting` or `idle`, while the process is alive |
| `waitingFor` | what a waiting session is blocked on; `permission prompt` is the one Cubiclark acts on |
| `name` | a label for the agent, if it has none |
| `startedAt`, `cwd` | read, but not shown (`cwd` never leaves the server) |

The adapter runs `<bin> --version` to detect (3 s timeout) and `<bin> agents --json` to snapshot (5 s
timeout, 1 MiB of output), and **asks at most once per `pollSeconds`, never more often than every 15
seconds**, however often the host calls it. It is created only when the configuration says
`"enabled": true`. A failed run, a non-zero exit or output that is not an array is an error in the
adapter's diagnostics, and the adapter shows as failing; nothing throws.

## Replay

`cubiclark replay --since 3h` reads the same transcripts and hook events, applies what happened before
the window at once and plays the rest on a clock that runs 10 times as fast (`--speed`). Adapter data
follows that clock: the quota is the sample at that time, and a task's timeline is cut there (a task
with no entry yet does not exist, and its phase follows what remains). **`claude agents` is not asked
in a replay**, because it describes the present.

## Writing an adapter

1. Put the parsing in a pure module under `src/core/adapters/` (text in, values out, no clock and no
   files) and test it against a fixture written by hand from your format. Fixtures live under
   `test/fixtures/`, are generated by a script in `scripts/`, and are scanned for personal data by
   `test/personal-data.test.ts`.
2. Put the reading in a class under `src/server/adapters/` that implements `OrchestrationAdapter`.
   Cache what has not changed (compare mtime and size), name errors by file and task rather than by
   path, and make `detect()` false for every way the source can be absent.
3. Add its configuration to `src/core/adapters/config.ts` and register it in
   `src/server/adapters/registry.ts` (`createAdapters`, and the id in `ADAPTER_IDS`). If it needs to
   change the World, extend `AdapterSnapshot` and `applyAdapters`, and keep it idempotent.
4. Test `detect()` against absent and broken sources (`test/adapter-detect.test.ts` is the model) and
   check that a snapshot of the same sources resolves rather than rejects.
