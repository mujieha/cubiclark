# Security

Cubiclark runs entirely on your own machine. It never calls a model and never sends anything
off the machine. This file describes the threat model for what exists today (design §9: the
transcript source, the hooks collector, the commands that install and remove it, the optional
adapters, the panel, replay, themes and the custom-assets manifest) and what the code does about
each threat. Each claim below names the test or the code that enforces it; what the code does not
enforce is under [Known limits](#known-limits). A first security review (round 1) was done on
phases 1 to 4; every finding was fixed with a test, or is a Known limit here.

## Threat model

### Another local process or web page reading the event stream

Anything running on the same machine can, in principle, try to reach a server bound to
`127.0.0.1`. Mitigated by:

- The server binds `127.0.0.1` only, never `0.0.0.0` or `::` (a code-level guarantee, not just a
  default — see `src/server/http.ts`).
- Every route (the page, `world.json`, `events`, `custom-assets.json`, `page-options.json` and the built assets) requires
  a random, per-run token in the URL path (`http://127.0.0.1:<port>/<token>/`), generated fresh with
  `node:crypto`'s `randomBytes(32)` each time the CLI starts and compared with a timing-safe check
  (including the redirect from `/<token>`; `test/http.test.ts` fails if a plain comparison returns).
- The `Host` header must match `127.0.0.1:<port>` or `localhost:<port>` exactly; anything else is
  rejected with 403 before the token is even checked, so a DNS-rebinding attempt cannot reach the
  token check at all.
- If a request carries an `Origin` header, it must match the server's own origin or the request
  is rejected with 403. No `Access-Control-*` header is ever sent, so no other origin's page can
  read a response even if it could get one.
- Every response carries a strict Content-Security-Policy (`default-src 'none'`, script and style
  restricted to `'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, and `X-Frame-Options: DENY`.

### A malicious or malformed transcript line injecting markup into the page

Transcript files are, in principle, attacker-controlled input (anything that can write to
`~/.claude/projects/` could try this). Mitigated by:

- The client renders every piece of text with `textContent` or by building DOM nodes with
  `createElement`, never with `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
  `document.write`. This is enforced structurally by an ESLint rule
  (`no-restricted-properties` in `eslint.config.js`), not just by convention.
- The office puts untrusted text (file names, subagent labels, project names, commands' first
  words) in three more places, and none of them parses markup: text on the canvas (bubbles, room
  names, cluster signs) is drawn with `fillText`; the tooltip is built line by line with
  `textContent`; and each agent's screen-reader label is set as an attribute value. Overlay
  positions are written through the CSSOM (`element.style`), which the page's
  `style-src 'self'` policy allows, so the policy stays strict.
- The lint rule is not taken on trust: `test/lint-rules.test.ts` lints code from memory and fails
  if `innerHTML`, `outerHTML` or `insertAdjacentHTML` stop being errors, in the client and in
  `src/core` alike, or if `textContent` is flagged by mistake.
- Bubble text is cut to 12 characters and tooltips show only fields the World already holds
  (basenames, never full paths), so a long or hostile string cannot grow the page.
- A record that is not valid JSON, is not an object, or has an unrecognised `type` is counted as
  a diagnostic and never reaches the page as content.

### Path traversal against the built client's asset files

Mitigated by an allowlist: `/assets/<file>` is only ever served for a filename that appears in an
actual directory listing of the built `dist/client/assets/` folder, taken once at server start.
A traversal attempt (`../../../etc/passwd`, URL-encoded or not) can never match an entry in that
list, so it 404s the same as any other unknown path.

### Prompt text, file contents, or other private data leaking into the page or the stored World

- The World (and the public snapshot sent to the browser) never stores prompt text, thinking
  text, or tool output. A tool's "target" is reduced to a file basename, a command verb, or a URL
  host — never a full path, a search pattern, or a search query
  (`src/core/transcript/tools.ts`).
- File paths are shown as basenames only; there is no `--full-paths` flag yet (a later phase, see
  README's Known limits).
- `test/personal-data.test.ts` proves every fixture file is free of real paths, e-mail addresses,
  this machine's name, and prose outside a fixed lorem vocabulary — the same shape of check the
  hygiene tool runs on the whole repository before anything is published.

### A very large or fast-growing transcript file slowing the collector or exhausting memory

- The tailer (`src/server/tail.ts`) reads only the bytes appended since its last read, in pieces of
  1 MiB and at most 8 MiB per poll (it polls again while there is more), so a first read of a huge
  file is many small ones. A line longer than 4 MiB is dropped up to its newline, counted as an
  unparsed line with the reason `too_long`, and never held in memory
  (`test/tail.test.ts`, `test/transcript-source.test.ts`).
- The World's log is capped at 500 lines, its diagnostics' source-error list at 50, and the record
  types and versions it counts at 50 names each (the rest under `(other)`); all drop or merge once
  full, so none grows without bound while the process runs.
- **The server does not die from what it reads.** An id such as `constructor` or `__proto__` (a
  transcript file named that, or a hook line) is ignored, not looked up as an object property; a
  file that is a symlink to a directory is skipped and said once; an error thrown by a reader, a
  clock tick or a client's socket is caught and shown as a source error; and `serve` and `replay`
  log an unhandled rejection (its name only) and keep serving
  (`test/prototype-keys.test.ts`, `test/store.test.ts`, `test/transcript-source.test.ts`).
- **A busy config folder cannot exhaust the server's memory.** The transcript source lists only
  `projects/<dir>/` and each session's `subagents/` folder (a project folder that is a symlink is not
  followed; a `subagents` folder is listed by its path, and its files must still be regular files to
  be read), runs one pass at a time, and rescans at most once every 5 seconds; file-system events
  outside `projects/` start nothing. Before this, every event started a full walk of the whole
  config folder, and walks piled up until the heap was gone
  (`test/transcript-source.test.ts`, `test/transcript-source-stress.test.ts`: 500 events over 5 000
  files, one scan at a time, the heap unchanged).

### The collector leaking prompt text, file contents or secrets

The collector (`src/hook/collector.ts`) runs once per Claude Code event and sees the whole hook
payload, including prompts, tool inputs and tool outputs. It stores none of that.

- **A whitelist, not a blocklist.** `src/core/hooks/whitelist.ts` builds each stored line field by
  field. A field is an id or name that matches a strict pattern, a value from a fixed enum, or a
  reduced target (a file's basename, a command's first word, a URL's host, a subagent type,
  under 100 characters with no path separator or control character). A value that fails its rule
  is dropped, not stored, and every field it does not name is never read. Unknown event names
  are recorded as `_unknown` with the name only, and anything that is not a JSON object as
  `_malformed`.
- **The secrets test.** `test/whitelist.test.ts` and `test/hooks/collector.test.ts` push payloads
  stuffed with fake credentials (API keys, tokens, passwords, a private-key header, an e-mail
  address, secrets inside commands, URLs, file contents, tool responses, error text,
  notifications, compaction summaries and unknown future fields) through the whitelist and through
  the real collector process, and assert that none of the fake secrets appears in what is stored.
- **A command's first word is kept, and filtered.** A first word that is over 40 characters, holds
  `=`, `:` or `@`, or starts like a credential (`sk-`, `ghp_`, `xox`, `AKIA`, ...) is not stored
  (`test/tools.test.ts`, `test/whitelist.test.ts`). Environment assignments in front of a command
  are skipped, so `TOKEN=x cmd` stores `cmd`. The filter is a list of shapes, not a guarantee: see
  Known limits. `hooks on --no-tools` records no tool activity at all.
- **`PostModelSwitch`** stores only its `to_model`, and only when it matches the same pattern as a
  session's starting model (letters, digits and `._:[]-`, at most 100 characters); `from_model` and
  everything else in the payload are never read. `PreModelSwitch` is never installed: a hook on it
  can block a model switch (`test/whitelist.test.ts`, `test/hooks-settings.test.ts`).
- **Local files are private.** `~/.cubiclark` is created with mode 0700 and `events.jsonl` with
  mode 0600. The state directory holds a copy of the collector that Claude Code runs with your
  rights on every event, so `hooks on` refuses to install into a state directory (or its `bin/`)
  that is a symlink, is owned by another user, or that group or others can write, and says which
  one to fix; it never changes a directory's mode itself. Collector files are placed through a
  temporary file and a rename, so a symlink already sitting at a destination is replaced, never
  followed (`test/hooks-install.test.ts`).

### The collector interfering with Claude Code

- It exits 0 with empty stdout and empty stderr on every path, including malformed input, a
  full disk and an unwritable state directory, so it adds nothing to any session's context
  (stdout on some events becomes context) and never turns a failure into a blocked action. An
  ESLint rule bans `console` in its code.
- It never prints a decision, and never answers a `PermissionRequest`; it only observes.
- It keeps out of Claude Code's way: eleven of the fifteen events are installed as `async` hooks,
  so nothing waits for it, and the four synchronous ones have a 5 second timeout.
  `npm run bench:hook` measures what the collector adds over Node's own start-up and fails above
  30 ms (about 6 ms on the development machine).
- A soft-off file (`~/.cubiclark/off`, created by `cubiclark hooks pause`) makes it exit at once
  without writing anything, with no edit to `settings.json`.
- Its import graph is three files and `node:` built-ins only; `test/collector-imports.test.ts`
  fails if a dependency is added.

### `hooks on` corrupting or clobbering Claude Code's `settings.json`

`src/server/hooks-install.ts` is the only code that reads or writes it, and it:

- parses the file first and refuses, changing nothing anywhere, if it does not parse;
- keeps a backup of the original bytes before the first change;
- writes through a temp file in the same directory (a random name, created exclusively, so a
  symlink planted at a predictable name is never followed) and a rename, so a crash cannot leave a
  half-written file, keeps the file's mode, and follows a symlinked `settings.json` to its target
  without replacing the link;
- touches only handlers that run a file named `cubiclark-collector.js`, and removes only those;
  a settings key called `__proto__` survives a removal;
- restores the original bytes on `hooks off` when the file is exactly what `hooks on` wrote (a
  SHA-256 recorded at install time decides), and otherwise removes only its own entries and keeps
  any edit made since; a backup that itself already runs the collector (the install record was
  lost) is never restored;
- adds its entries once however many times it runs, and `hooks on` again after an upgrade adds the
  entries a newer version needs;
- with `hooks off --purge` removes only the names Cubiclark writes (the events files, the soft-off
  flag, `bin/`, `install.json`), keeps `config.json`, `assets/` and `backups/`, removes the
  directory only if that leaves it empty, and refuses `/`, your home directory or a directory that
  contains it before changing anything.

`test/hooks-install.test.ts` and `test/hooks/hooks-cli.test.ts` check each of these against
fixture settings files in temp directories; no test ever touches the real `~/.claude`.

### A malicious line in the events file

`~/.cubiclark/events.jsonl` is read like a transcript: any line that is not valid, or not a shape
this build knows, is counted (`unparsed`, `unknown hook shapes`) and never reaches the page as
content, and the page still renders every string with `textContent`.

### A configuration file that makes Cubiclark run a program

Only the `claude-agents` adapter runs anything, and only the program its configuration section
names. So:

- It does not exist unless `~/.cubiclark/config.json` says `"enabled": true`; a half-written section
  does not run anything.
- **A config file that someone else could have written keeps its other sections but loses
  `claude-agents`**, with a warning (`src/server/config-file.ts`): the file is writable by group or
  others, or owned by another user, or in a directory owned by another user (other than root) or
  changeable by group or others (a sticky directory such as `/tmp` is fine when root or you own it).
  The file is opened once and checked and read through that one descriptor. Whoever can edit it
  could otherwise choose the program (`test/adapter-config.test.ts`; ownership is tested through a
  `uid` option, since a test cannot be another user).
- The program is started with `execFile` and a fixed argument list (`--version`, or `agents --json`),
  never through a shell, with a timeout and a cap on the size of its output. The adapter asks at most
  once every 15 seconds. A fixture home never reads the real configuration.
- What it prints is not trusted: `parseAgentsJson` keeps a fixed set of fields, each cut to 40
  characters, a session id only if it is a UUID, and a state only from the five documented values.
  The session's working directory stays on the server.
- Tests only ever run the stand-in `test/fixtures/bin/claude`.

### Task folders, quota files and `claude agents` output as untrusted input

Everything an adapter reads can be written by someone else, so the adapters are read-only and the
text they produce is treated like a transcript line:

- Text from `LOG.md`, `TASK.md` and `STATUS.md` has every path-looking token (a Unix path, or a
  Windows path with a drive or a share) reduced to its last segment, extra whitespace collapsed and
  the length capped (160 characters) before it reaches the World; a session id is accepted only if
  it is a UUID. A model, plan model, effort or permission mode is kept only if it is a plain name
  (letters, digits and `._:[]-`, at most 64 characters), and `Project:` is its last `/` or `\`
  segment, at most 60 characters. An unknown or unparseable line is counted (`doctor --adapters`
  shows the count) and never shown as content.
- A task folder cannot make the adapter read more than it should: `LOG.md` is read from its last
  1 MiB, the other files from their first 64 KiB, a task keeps its 50 newest session ids, and a
  symlink named `TASK.md`, `STATUS.md`, `LOG.md` or `session` is not followed
  (`test/task-folders-adapter.test.ts`, `test/task-folder.test.ts`).
- The panel prints all of it with `textContent`, the whiteboard with `fillText`, and the legend's
  swatch colours through the CSSOM, so a hostile task title or log line cannot become markup.
- An adapter's error names a task and a file (`beta-build/LOG.md: EACCES`), never an absolute path.
- The quota reader takes at most the last 256 KiB of a file and 2000 samples; a task folder's files
  are re-read only when their modification time or size changes.

### The unparsed-lines breakdown leaking content

`doctor`'s `unparsed by` line and the page's diagnostics count lines by reason and by record `type`
(`system:<subtype>` for system records) and never print a value from a line. A type that is not a
plain name of at most 40 characters (letters, digits, `_ . : ( ) -`), or that is a name every object
already has (`constructor`), is counted as `(invalid)`, and at most 50 distinct names are kept per
reason. The unknown record types and the Claude Code versions the diagnostics list travel the same
way (a version must look like `2.1.285`, else `(invalid)`), and every line `doctor` and
`hooks status` print has its control characters removed, so a transcript cannot write an escape
sequence to your terminal (`test/parse-diagnostics.test.ts`).

### Paths leaving the machine in the page's data

The page's data (`world.json` and the event stream) is what a screenshot, a saved response or a HAR
file would hold. An agent's working directory is reduced to its basename, the transcripts folder, the
events file and any error text name your home directory as `~`, and a source error names
`<project>/<file>`, never an absolute path (`test/http.test.ts`, `test/view.test.ts`). A path outside
your home directory (a fixture folder, `/tmp`) is shown as it is. Text a transcript itself holds
(an API error message) has control characters removed, paths reduced and its length capped.

### The event stream holding memory for a client that stopped reading

The World is turned into text once per change however many pages are open, and a page that has more
than 8 MiB of that text waiting to be sent is disconnected (it reconnects by itself if it comes back)
(`test/http.test.ts`).

### Themes and the custom-assets manifest

The theme choice (`auto`, `day` or `night`) is remembered in the browser's `localStorage` as a
convenience; what is read back is parsed to one of those three words and anything else is `auto`, and
blocked storage does not break the page (`test/e2e/themes.spec.ts`). Colours reach the page through
the CSSOM, so the content security policy stays as strict as it was.

A custom-assets manifest (`docs/assets.md`) is untrusted input in the same way as a transcript. It is
JSON, never code and never markup: palette colours (`#rrggbb`) and sprites drawn as grids of
characters. It is checked as data before anything is used: at most 256 KiB, a regular file read
through one descriptor, at most 200 sprites, only ids from a fixed catalogue (never an icon, tag, lamp
or monitor, which tell states apart), exact sizes and characters, and every theme palette, with the
pack's colours merged in, must still keep bubble text readable and tell red, amber and green and the
model shirts apart. **A manifest with any error is not applied at all**; its errors are listed on the
page (as text) and by `cubiclark doctor --assets <file>`, which then exits 1. The server sends the
page only a valid pack's palettes and sprites, behind the run token, and the page checks each sprite's
shape again. Its file name (never its path) is all the status shows
(`test/assets-manifest.test.ts`, `test/assets-file.test.ts`, `test/e2e/assets.spec.ts`).

### Replay

`cubiclark replay` reads the same transcripts, hook events and adapter files as the live page,
through the same parsers, and writes nothing. It serves the same page on `127.0.0.1` under the same
token, Host and CSP rules. `--since` is capped at 14 days and `--speed` at 1000.

## Known limits

What the code does not do, so that nothing above is read as more than it is:

- **Cubiclark assumes a single-user machine.** The run token is the only thing between another
  local account and the event stream, and it is in the URL: the browser's command line (on Linux,
  `xdg-open` may put it in the arguments of a process every user can list) and its history show it to
  other local accounts for as long as the run or the history lasts. A one-time code traded for a
  cookie would fix that and is left for a later release. Other processes running as *you* can do
  anything you can, and are out of scope.
- **A command's first word is filtered by shape, not verified.** A secret that does not look like
  one of the shapes the filter knows (over 40 characters, `=`, `:` or `@` in it, a well-known
  credential prefix) and is typed where a command goes would still be stored as the command's
  "verb". `hooks on --no-tools` stores no tool activity at all.
- **`hooks on` keeps `settings.json`'s mode as the umask leaves it** (a `0666` file comes back
  `0644`), and the rename replaces the file, so its owner, group and hard links are those of the new
  file. This is what writing through a temp file and a rename means.
- **The hooks reference documents `StopFailure`'s matcher as `error_type` and shows no payload**,
  so the collector reads `error` or `error_type`; and it shows `PostModelSwitch`'s `from_model` and
  `to_model` only in prose, so `to_model` is read as documented. If a real session names either
  differently, the collector stores no value for it (never something else), and the transcript still
  says the model.
- **A relative path with a slash inside (`projects/demo`) in a task folder's text is kept as
  written**; only absolute Unix and Windows paths are reduced (it names no directory outside the
  task).
- **A manifest and a configuration file are read once, at start.** A change needs a restart.
- **A file's whole history is read on a first start**, in bounded pieces (memory stays bounded, the
  time it takes does not): a very large transcript is read in many polls.
- **Windows is untested**: its path forms, file modes and opening a browser.

## Reporting a vulnerability

This repository is private for now. Once it is public, use GitHub's private vulnerability
reporting on the repository instead of opening a public issue.
