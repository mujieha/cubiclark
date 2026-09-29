// `cubiclark doctor`: one look at every source, with a reason for anything that is not fine.
// runDoctor() gathers (one-shot reads of the transcripts and the hook events, the settings file,
// `claude --version`); formatDoctorReport() and doctorExitCode() are pure, so the exact output is
// tested without any of that. It never calls a model: the only thing it runs is `claude
// --version`, and only when asked to (--claude-bin lets tests point it at a stand-in).

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gateTranscriptEvent } from '../core/merge.js'
import { reduce } from '../core/reducer.js'
import { classifyHooks, classifyTranscripts, type SourceCheck } from '../core/hooks/status.js'
import { HOOK_EVENTS_VERIFIED_ON, HOOK_EVENT_NAMES } from '../core/hooks/whitelist.js'
import type { UnparsedBreakdown } from '../core/types.js'
import { unparsedReasonTotals, unparsedTypeCounts } from '../core/view.js'
import { emptyWorld } from '../core/world.js'
import { HookSource } from './hook-source.js'
import { inspectHooks } from './hooks-install.js'
import { TranscriptSource } from './transcript-source.js'

const execFileAsync = promisify(execFile)

export interface DoctorReport {
  claude: { version?: string; verified: boolean; error?: string }
  hookEvents: { verifiedOn: string; events: readonly string[] }
  transcripts: SourceCheck
  hooks: SourceCheck
  diagnostics: {
    unparsedLines: number
    unknownHookShapes: number
    unknownTypes: Record<string, number>
    unparsedBy: UnparsedBreakdown
    versions: string[]
    sourceErrors: string[]
  }
}

export interface DoctorOptions {
  /** The transcripts root: a Claude config directory, or a fixture home. */
  root: string
  /** Where settings.json lives (usually the same directory as root). */
  configDir: string
  fixtureMode: boolean
  /** Undefined means "do not look": fixture mode without --state-dir never reads the real one. */
  stateDir: string | undefined
  sinceHours: number
  claudeBin: string
  nowMs: () => number
}

const ONE_SHOT_POLL_MS = 60 * 60 * 1000 // never fires: both sources are stopped right after start()

async function claudeVersion(bin: string): Promise<DoctorReport['claude']> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 3000 })
    const version = /^\s*(\d+\.\d+\.\d+\S*)/.exec(stdout)?.[1]
    if (!version) return { verified: false, error: `unexpected output: ${stdout.trim().slice(0, 80)}` }
    return { version, verified: version === HOOK_EVENTS_VERIFIED_ON }
  } catch (err) {
    return { verified: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function runDoctor(o: DoctorOptions): Promise<DoctorReport> {
  let world = emptyWorld(new Date(o.nowMs()).toISOString(), o.root)
  const sinceMs = o.fixtureMode ? null : o.nowMs() - o.sinceHours * 60 * 60 * 1000

  // The same order and the same gate as the running app: transcript history first, hooks after.
  const transcripts = new TranscriptSource({
    root: o.root,
    sinceMs,
    windowHours: o.fixtureMode ? null : o.sinceHours,
    watch: false,
    pollMs: ONE_SHOT_POLL_MS,
    onEvents: (events) => {
      for (const event of events) {
        const gated = gateTranscriptEvent(world, event)
        if (gated) world = reduce(world, gated)
      }
    },
    nowMs: o.nowMs,
  })
  await transcripts.start()
  const transcriptStatus = transcripts.getStatus()
  transcripts.stop()

  let hooks: SourceCheck
  if (o.stateDir === undefined) {
    hooks = { status: 'missing', reason: 'not checked: fixture mode without --state-dir' }
  } else {
    const hookSource = new HookSource({
      eventsFile: join(o.stateDir, 'events.jsonl'),
      sinceMs,
      watch: false,
      pollMs: ONE_SHOT_POLL_MS,
      onEvents: (events) => {
        for (const event of events) world = reduce(world, event)
      },
      nowMs: o.nowMs,
    })
    await hookSource.start()
    const stats = hookSource.getStats()
    hookSource.stop()

    const inspection = await inspectHooks(o.configDir, o.stateDir)
    hooks = classifyHooks(inspection, o.nowMs())
    if (stats.error && inspection.events.length > 0 && hooks.status !== 'failing') {
      hooks = { status: 'failing', reason: `cannot read the events file: ${stats.error}` }
    }
  }

  const d = world.diagnostics
  return {
    claude: await claudeVersion(o.claudeBin),
    hookEvents: { verifiedOn: HOOK_EVENTS_VERIFIED_ON, events: HOOK_EVENT_NAMES },
    transcripts: classifyTranscripts(transcriptStatus),
    hooks,
    diagnostics: {
      unparsedLines: d.unparsedLines,
      unknownHookShapes: d.unknownHookShapes,
      unknownTypes: d.unknownTypes,
      unparsedBy: d.unparsedBy,
      versions: d.versions,
      sourceErrors: d.sourceErrors,
    },
  }
}

function claudeLine(claude: DoctorReport['claude']): string {
  if (claude.version === undefined) return `not found (${claude.error ?? 'unknown error'})`
  if (claude.verified) return `${claude.version} — hook events verified against the hooks reference for this version`
  return `${claude.version} — not verified; cubiclark's hook events were verified on ${HOOK_EVENTS_VERIFIED_ON}`
}

function sourceLine(label: string, check: SourceCheck): string {
  return `${label.padEnd(14)}${check.status.padEnd(10)}${check.reason}`
}

export function formatDoctorReport(r: DoctorReport): string {
  const d = r.diagnostics
  const unknownNames = Object.keys(d.unknownTypes)
  const parts = [
    `${d.unparsedLines} unparsed lines`,
    `${d.unknownHookShapes} unknown hook shapes`,
    `${unknownNames.length} unknown record types${unknownNames.length > 0 ? ` (${unknownNames.join(', ')})` : ''}`,
    `versions seen: ${d.versions.length > 0 ? d.versions.join(', ') : 'none'}`,
  ]
  if (d.sourceErrors.length > 0) parts.push(`${d.sourceErrors.length} source errors (first: ${d.sourceErrors[0]})`)

  return [
    `${'Claude Code'.padEnd(14)}${claudeLine(r.claude)}`,
    `${'Hook events'.padEnd(14)}${r.hookEvents.events.join(', ')}`,
    sourceLine('transcripts', r.transcripts),
    sourceLine('hooks', r.hooks),
    `${'diagnostics'.padEnd(14)}${parts.join(', ')}`,
    `${'unparsed by'.padEnd(14)}${unparsedByText(d.unparsedBy)}`,
  ].join('\n')
}

/** "no_timestamp 9000 (mode 4000, user 3000), unknown_type 5 (x 5)", or "none". Names and counts
 * only: the record types, never anything from the lines. */
export function unparsedByText(by: UnparsedBreakdown): string {
  const parts = unparsedReasonTotals(by).map(([reason, total]) => {
    const types = unparsedTypeCounts(by, reason)
      .map(([type, count]) => `${type} ${count}`)
      .join(', ')
    return `${reason} ${total}${types ? ` (${types})` : ''}`
  })
  return parts.length > 0 ? parts.join(', ') : 'none'
}

/** 1 only when a source is failing. A source that is merely missing is not a failure. */
export function doctorExitCode(r: DoctorReport): 0 | 1 {
  return r.transcripts.status === 'failing' || r.hooks.status === 'failing' ? 1 : 0
}
