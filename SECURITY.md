# Security

Cubiclark runs entirely on your own machine. It never calls a model and never sends anything
off the machine. This file describes the threat model for what exists today (design §9: the
transcript source, the hooks collector, and the commands that install and remove it) and what the
code does about each threat.

## Threat model

### Another local process or web page reading the event stream

Anything running on the same machine can, in principle, try to reach a server bound to
`127.0.0.1`. Mitigated by:

- The server binds `127.0.0.1` only, never `0.0.0.0` or `::` (a code-level guarantee, not just a
  default — see `src/server/http.ts`).
- Every route requires a random, per-run token in the URL path (`http://127.0.0.1:<port>/<token>/`),
  generated fresh with `node:crypto`'s `randomBytes(32)` each time the CLI starts and compared with
  a timing-safe check, never a plain string comparison.
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

- The tailer (`src/server/tail.ts`) reads only the bytes appended since its last read, in
  whatever chunk size that is, and never holds a whole file in memory at once.
- The World's log is capped at 300 lines and its diagnostics' source-error list at 50; both drop
  the oldest entry once full, so neither grows without bound while the process runs.

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
- **A known limit.** A command's first word is kept, as the design says, so a command that
  *starts* with a secret (`sk-... --flag`) would store that first word. Environment assignments
  in front of a command are skipped, so `TOKEN=x cmd` stores `cmd`. Set `hooks on --no-tools` to
  record no tool activity at all.
- **Local files are private.** `~/.cubiclark` is created with mode 0700 and `events.jsonl` with
  mode 0600. The state directory holds a copy of the collector that Claude Code runs with your
  rights on every event, so keep it as private as the directory it is in.

### The collector interfering with Claude Code

- It exits 0 with empty stdout and empty stderr on every path, including malformed input, a
  full disk and an unwritable state directory, so it adds nothing to any session's context
  (stdout on some events becomes context) and never turns a failure into a blocked action. An
  ESLint rule bans `console` in its code.
- It never prints a decision, and never answers a `PermissionRequest`; it only observes.
- It keeps out of Claude Code's way: ten of the fourteen events are installed as `async` hooks,
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
- writes through a temp file in the same directory and a rename, so a crash cannot leave a
  half-written file, keeps the file's mode, and follows a symlinked `settings.json` to its target
  without replacing the link;
- touches only handlers that run a file named `cubiclark-collector.js`, and removes only those;
- restores the original bytes on `hooks off` when the file is exactly what `hooks on` wrote (a
  SHA-256 recorded at install time decides), and otherwise removes only its own entries and keeps
  any edit made since;
- adds its entries once however many times it runs.

`test/hooks-install.test.ts` and `test/hooks/hooks-cli.test.ts` check each of these against
fixture settings files in temp directories; no test ever touches the real `~/.claude`.

### A malicious line in the events file

`~/.cubiclark/events.jsonl` is read like a transcript: any line that is not valid, or not a shape
this build knows, is counted (`unparsed`, `unknown hook shapes`) and never reaches the page as
content, and the page still renders every string with `textContent`.

## Reporting a vulnerability

This repository is private for now. Once it is public, use GitHub's private vulnerability
reporting on the repository instead of opening a public issue.
