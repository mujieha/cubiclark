// Turns what was observed about a source into the one word `doctor` and the page show for it:
// live, missing (nothing is wrong, it is just not there) or failing (something is broken), plus
// a reason a person can act on. Pure: the inputs are the inspections the I/O layers already made.

import type { HooksInspection, HooksSourceStatus, TranscriptSourceStatus } from '../types.js'

export type SourceHealth = 'live' | 'missing' | 'failing'

export interface SourceCheck {
  status: SourceHealth
  reason: string
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function classifyTranscripts(s: TranscriptSourceStatus): SourceCheck {
  if (s.status === 'live') {
    // A folder that does not exist yet is nothing wrong: Claude Code has not run here.
    if (s.rootMissing) return { status: 'missing', reason: `no transcripts folder at ${s.root}` }
    return { status: 'live', reason: `${plural(s.files, 'transcript file')}, ${s.inWindow} read (${s.root})` }
  }
  if (s.status === 'unreadable') {
    const error = s.error ?? 'unknown error'
    // Node's fs error messages start with the code.
    if (error.startsWith('ENOENT')) return { status: 'missing', reason: `no transcripts folder at ${s.root}` }
    return { status: 'failing', reason: `cannot read ${s.root}: ${error}` }
  }
  return { status: 'failing', reason: 'the transcript source did not finish starting' }
}

function ago(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))
  if (Number.isNaN(seconds)) return 'unknown time'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/** `dirname` without importing node:path, so this file stays free of any I/O module. */
function offFileOf(eventsFile: string): string {
  const cut = eventsFile.lastIndexOf('/')
  return `${cut >= 0 ? eventsFile.slice(0, cut) : '.'}/off`
}

export function classifyHooks(i: HooksInspection, nowMs: number): SourceCheck {
  if (i.settingsState === 'unparseable') {
    return { status: 'failing', reason: `settings.json does not parse: ${i.parseError ?? 'unknown error'}` }
  }
  if (i.events.length === 0) {
    return { status: 'missing', reason: 'not installed: run `cubiclark hooks on`' }
  }
  if (!i.collectorExists) {
    return {
      status: 'failing',
      reason: `the collector copy is missing (${i.collectorPath ?? 'unknown path'}); run \`cubiclark hooks on\` again`,
    }
  }
  if (i.paused) {
    return { status: 'missing', reason: `paused by ${offFileOf(i.eventsFile)}; run \`cubiclark hooks resume\`` }
  }
  const installed = `${i.events.length} events (tools ${i.tools ? 'on' : 'off'})`
  return {
    status: 'live',
    reason: i.lastEventTs ? `${installed}; last event ${ago(i.lastEventTs, nowMs)} ago` : `${installed}; no events recorded yet`,
  }
}

/** The hooks entry of World.sources. `stats` is what the running HookSource has seen. */
export function hooksSourceStatus(
  i: HooksInspection,
  stats: { events: number; lastEventTs?: string; error?: string },
  nowMs: number
): HooksSourceStatus {
  const check = classifyHooks(i, nowMs)
  const installed = i.events.length > 0 || i.settingsState === 'unparseable'
  let status: HooksSourceStatus['status'] = !installed ? 'not_installed' : check.status === 'failing' ? 'failing' : 'live'
  let reason = check.reason
  if (installed && stats.error) {
    status = 'failing'
    reason = `cannot read the events file: ${stats.error}`
  }
  return {
    status,
    reason,
    eventsFile: i.eventsFile,
    events: stats.events,
    lastEventTs: stats.lastEventTs ?? i.lastEventTs,
    tools: i.tools,
    paused: i.paused,
  }
}
