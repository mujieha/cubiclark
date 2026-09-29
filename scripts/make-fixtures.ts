#!/usr/bin/env node
// Regenerates test/fixtures/**. `npm run fixtures` writes; `npm run fixtures:check` (used by CI
// and by this step's own acceptance check) verifies the checked-in files still match what the
// generator produces and exits 1, naming every stale file, if they don't.
//
// Shape learned from Claude Code 2.1.284 transcripts (key paths and `type` values only, from
// the orchestrator-owned planning task folder, not part of this repository) and public docs;
// every id, path, timestamp and word of prose the generator writes is invented — see
// scripts/fixture-lib.ts for the generators and test/personal-data.test.ts for the guard that
// checks this claim against every file on disk.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serialiseStoredLine, toStoredLine } from '../src/core/hooks/whitelist.js'
import { hookFixtureEvents } from './hook-fixture-lib.js'
import { quotaFixtureFiles, taskTreeFiles } from './task-fixture-lib.js'
import { WORLD_FIXTURES } from './world-fixture-lib.js'
import {
  DEMO_CWD,
  SHOP_CWD,
  type Line,
  apiErrorLines,
  backgroundWorkerLines,
  compactionLines,
  exploreScenario,
  interruptedLines,
  mainSessionLines,
  malformedLines,
  permissionDeniedLines,
  permissionWaitLines,
  rateLimitLines,
  recordTypes2185Lines,
  resetFixtureSequence,
  sessionId,
  subagentId,
} from './fixture-lib.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TRANSCRIPTS_DIR = join(REPO_ROOT, 'test/fixtures/transcripts')
const HOME_DIR = join(REPO_ROOT, 'test/fixtures/home')
const STATE_DIR = join(REPO_ROOT, 'test/fixtures/state')
const WORLDS_DIR = join(REPO_ROOT, 'test/fixtures/worlds')
const TASKS_DIR = join(REPO_ROOT, 'test/fixtures/tasks')
const QUOTA_DIR = join(REPO_ROOT, 'test/fixtures/quota')

type FileMap = Map<string, string>

function jsonlText(lines: Line[]): string {
  return lines.map((line) => ('raw' in line ? line.raw : JSON.stringify(line))).join('\n') + '\n'
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

/** A1 in PLAN.md §1.5: every non-alphanumeric character in the cwd becomes '-'. Lossy, and
 * deliberately never decoded back — the parser reads the project name from each record's own
 * `cwd` field instead (see src/core/transcript/paths.ts). */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function buildFixtures(): { transcripts: FileMap; home: FileMap; state: FileMap; worlds: FileMap; tasks: FileMap; quota: FileMap } {
  resetFixtureSequence()
  const transcripts: FileMap = new Map()
  const home: FileMap = new Map()
  const state: FileMap = new Map()
  const worlds: FileMap = new Map()
  // The task-folder tree (phase 4): plain strings, no uuid counter involved.
  const tasks: FileMap = taskTreeFiles()
  const quota: FileMap = quotaFixtureFiles()

  const START = Date.parse('2026-01-15T10:00:00.000Z')
  const HOUR = 60 * 60 * 1000

  // Standalone scenario files: one per transcript assumption in PLAN.md §1.5 and §1.7. Each
  // starts an hour apart so nothing in one scenario is mistaken for another while debugging.
  transcripts.set('main-session.jsonl', jsonlText(mainSessionLines(START, sessionId('1'), DEMO_CWD)))
  transcripts.set(
    'background-worker.jsonl',
    jsonlText(backgroundWorkerLines(START + HOUR, sessionId('2'), DEMO_CWD))
  )

  const exploreParentSid = sessionId('3')
  const exploreAid = subagentId('e1')
  const explore = exploreScenario(START + 2 * HOUR, exploreParentSid, DEMO_CWD, exploreAid, { full: true })
  transcripts.set(`explore/${exploreParentSid}.jsonl`, jsonlText(explore.parentLines))
  transcripts.set(
    `explore/${exploreParentSid}/subagents/agent-${exploreAid}.jsonl`,
    jsonlText(explore.subagentLines)
  )
  transcripts.set(
    `explore/${exploreParentSid}/subagents/agent-${exploreAid}.meta.json`,
    jsonText(explore.meta)
  )

  transcripts.set('compaction.jsonl', jsonlText(compactionLines(START + 3 * HOUR, sessionId('4'), DEMO_CWD)))
  transcripts.set('rate-limit.jsonl', jsonlText(rateLimitLines(START + 4 * HOUR, sessionId('5'), SHOP_CWD)))
  transcripts.set('api-error.jsonl', jsonlText(apiErrorLines(START + 5 * HOUR, sessionId('6'), DEMO_CWD)))
  transcripts.set(
    'permission-wait.jsonl',
    jsonlText(permissionWaitLines(START + 6 * HOUR, sessionId('7'), DEMO_CWD))
  )
  transcripts.set(
    'permission-denied.jsonl',
    jsonlText(permissionDeniedLines(START + 7 * HOUR, sessionId('8'), DEMO_CWD))
  )
  transcripts.set('interrupted.jsonl', jsonlText(interruptedLines(START + 8 * HOUR, sessionId('9'), DEMO_CWD)))
  transcripts.set('malformed.jsonl', jsonlText(malformedLines(START + 9 * HOUR, sessionId('a'), DEMO_CWD)))

  // The CLI's home world: five agents inside one shared, tight time window. Fixture mode
  // freezes the clock at the newest record seen across the whole world (PLAN.md §1.7), so every
  // file here has to end within a few minutes of the others, or an idle one would wrongly look
  // 'stuck' relative to that shared clock.
  const homeStart = Date.parse('2026-01-15T10:00:00.000Z')
  const demoDir = encodeProjectDir(DEMO_CWD)
  const shopDir = encodeProjectDir(SHOP_CWD)

  const homeMainSid = sessionId('1')
  home.set(`projects/${demoDir}/${homeMainSid}.jsonl`, jsonlText(mainSessionLines(homeStart, homeMainSid, DEMO_CWD)))

  const homeBgSid = sessionId('2')
  home.set(
    `projects/${demoDir}/${homeBgSid}.jsonl`,
    jsonlText(backgroundWorkerLines(homeStart + 20_000, homeBgSid, DEMO_CWD))
  )

  const homeExploreSid = sessionId('3')
  const homeExploreAid = subagentId('e1')
  const homeExplore = exploreScenario(homeStart + 40_000, homeExploreSid, DEMO_CWD, homeExploreAid, {
    full: false,
  })
  home.set(`projects/${demoDir}/${homeExploreSid}.jsonl`, jsonlText(homeExplore.parentLines))
  home.set(
    `projects/${demoDir}/${homeExploreSid}/subagents/agent-${homeExploreAid}.jsonl`,
    jsonlText(homeExplore.subagentLines)
  )
  home.set(
    `projects/${demoDir}/${homeExploreSid}/subagents/agent-${homeExploreAid}.meta.json`,
    jsonText(homeExplore.meta)
  )

  const homeShopSid = sessionId('5')
  home.set(
    `projects/${shopDir}/${homeShopSid}.jsonl`,
    jsonlText(rateLimitLines(homeStart + 90_000, homeShopSid, SHOP_CWD))
  )

  // The state directory the collector would have written: two hook-only sessions, stored through
  // the real whitelist so the fixture is exactly what `cubiclark hook` would have appended.
  state.set(
    'events.jsonl',
    hookFixtureEvents()
      .map((event) => serialiseStoredLine(toStoredLine(event.payload, event.ts)))
      .join('')
  )

  // The office's fixture worlds (phase 3): the World value the browser receives, one file each.
  for (const [name, build] of Object.entries(WORLD_FIXTURES)) worlds.set(`${name}.json`, jsonText(build()))

  // Built last: it draws record uuids from the shared counter, and building it earlier would
  // renumber every file above.
  transcripts.set(
    'record-types-2.1.285.jsonl',
    jsonlText(recordTypes2185Lines(START + 10 * HOUR, sessionId('b'), DEMO_CWD))
  )

  return { transcripts, home, state, worlds, tasks, quota }
}

async function writeAll(base: string, files: FileMap): Promise<void> {
  for (const [rel, content] of files) {
    const full = join(base, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function checkAll(base: string, files: FileMap): Promise<string[]> {
  const stale: string[] = []
  for (const [rel, content] of files) {
    const full = join(base, rel)
    const onDisk = await readIfExists(full)
    if (onDisk !== content) stale.push(full)
  }
  return stale
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const { transcripts, home, state, worlds, tasks, quota } = buildFixtures()
  const total = transcripts.size + home.size + state.size + worlds.size + tasks.size + quota.size

  if (check) {
    const stale = [
      ...(await checkAll(TRANSCRIPTS_DIR, transcripts)),
      ...(await checkAll(HOME_DIR, home)),
      ...(await checkAll(STATE_DIR, state)),
      ...(await checkAll(WORLDS_DIR, worlds)),
      ...(await checkAll(TASKS_DIR, tasks)),
      ...(await checkAll(QUOTA_DIR, quota)),
    ]
    if (stale.length > 0) {
      console.error('fixtures out of date, run `npm run fixtures`:')
      for (const path of stale) console.error(`  ${path}`)
      process.exitCode = 1
      return
    }
    console.log(`fixtures up to date (${total} files)`)
    return
  }

  await writeAll(TRANSCRIPTS_DIR, transcripts)
  await writeAll(HOME_DIR, home)
  await writeAll(STATE_DIR, state)
  await writeAll(WORLDS_DIR, worlds)
  await writeAll(TASKS_DIR, tasks)
  await writeAll(QUOTA_DIR, quota)
  console.log(`wrote ${total} fixture files`)
}

await main()
