# Changelog

All notable changes to Cubiclark are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - YYYY-MM-DD

The first release: a local view of live Claude Code agents and their states.

### Added

- **Two ways to see agents.** Transcripts only: Cubiclark tails Claude Code's own transcript files
  and changes no settings. With hooks: `cubiclark hooks on` adds a small collector to Claude Code's
  user `settings.json`, which reports session starts and ends, prompts, tool calls, permission
  requests, compactions, failures and subagents as they happen; `hooks off` removes it, and
  `hooks status`, `pause` and `resume` manage it. `cubiclark doctor` checks every source.
- **The office.** A pixel-art office on `127.0.0.1`: every agent is a character at a desk, and its
  pose, speech bubble and desk lamp show what it is doing. Orchestrators, planners and reviewers have
  rooms of their own; a subagent sits on a stool beside its parent. A plain list of the same agents is
  one click away.
- **Morty**, the office corgi, there just for fun. He is not an agent and is never counted;
  `--no-mascot` leaves him out.
- **The panel**: the selected agent, the session log, tasks and their timelines, the quota, and a
  status bar.
- **The terminal**: `cubiclark tui` shows the same agents as text in the terminal you ran it in, with
  no server, no port and no browser.
- **Adapters**, optional, read-only and off until configured: task folders, quota samples and
  `claude agents`.
- **Replay**: `cubiclark replay --since 3h` plays a stretch of the past on the same page, 10 times as
  fast.
- **Themes and custom assets**: Auto, Day and Night, and a custom-assets manifest (`--assets`) that
  changes the office's colours and redraws characters, accessories and floors, checked as data.
- **The quiet office**: the office, the list and the panel show the agents that are working, the five
  most recently active sessions waiting for you (`--idle-desks <n>` changes the five), and finished,
  failed or stuck agents for a while, and say how many they leave out.

### Security

- **The one-time link.** The address Cubiclark prints works once: the browser trades it for an
  `HttpOnly`, `SameSite=Strict` session cookie, and every route needs that cookie.
- **The collector's whitelist.** The collector stores event names, ids, a reduced target and a few
  enum values; never prompt text, tool input or output, error text or assistant text.
- **The sanitised terminal.** Every string from a transcript, a task folder or a configuration file
  goes through one filter before `cubiclark tui` draws it, and colour comes only from a fixed table.
- **Review round 1**: phases 1 to 4; every finding was fixed with a test, or is a Known limit in
  `SECURITY.md`.
- **Review round 2**: the round-1 fixes and everything added after them; each finding was fixed with
  a test, or is a Known limit in `SECURITY.md`.

### Known limits

Read [Known limits](README.md#known-limits) in the README and in [SECURITY.md](SECURITY.md#known-limits)
before relying on any of the above; [Platforms](README.md#platforms) says where it has been tested.

[0.1.0]: https://github.com/mujieha/cubiclark/releases/tag/v0.1.0
