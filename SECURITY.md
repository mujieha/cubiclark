# Security

agent-office runs entirely on your own machine. It never calls a model and never sends anything
off the machine. This file describes the threat model for what exists today (design §9,
restricted to phase 1: transcripts only, no hooks collector yet) and what the code does about
each threat.

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

## Not yet applicable

The hooks collector, `hooks on/off/status`, and any write to Claude Code's `settings.json` do not
exist yet — they are phase 2. Their own threat model (the collector's field whitelist, exit-0
and empty-stdout guarantees, the settings.json backup-and-atomic-write path) will be added to this
file when they land.

## Reporting a vulnerability

This repository is private during phase 1. Once it is public, use GitHub's private vulnerability
reporting on the repository instead of opening a public issue.
