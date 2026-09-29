// Quota samples: the JSONL the status line writes (docs/adapters.md, "Quota samples"). Pure.
//
// The real writer's line, one per sample, times in epoch SECONDS:
//   {"ts":1768570200,"limit_5h_pct":62,"limit_7d_pct":40,"limit_5h_resets":1768575600,"limit_7d_resets":1768795200}
// The file also holds other metric samples that carry no percentages: those are skipped silently
// (counted as `skipped`, never as `unparsed`). Times are also accepted as ISO strings or epoch
// milliseconds, and the resets under a few other spellings, because the writer is not ours.

import type { Quota } from '../types.js'
import type { QuotaSample } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const WINDOW_5H_MS = 5 * 60 * 60 * 1000
export const WINDOW_7D_MS = 7 * DAY_MS
/** Samples older than this (against the clock) are not kept. */
export const KEEP_SAMPLES_MS = 8 * DAY_MS
export const MAX_SAMPLES = 2000

export type QuotaLine = { kind: 'sample'; sample: QuotaSample } | { kind: 'skipped' } | { kind: 'unparsed' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An ISO string, epoch seconds (below 1e12) or epoch milliseconds, as an ISO string. */
function toIso(value: unknown): string | undefined {
  let ms: number | undefined
  if (typeof value === 'number' && Number.isFinite(value)) ms = value >= 1e12 ? value : value * 1000
  else if (typeof value === 'string' && value.trim() !== '') {
    ms = /^\d+(\.\d+)?$/.test(value.trim()) ? toMs(Number(value.trim())) : Date.parse(value)
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function toMs(n: number): number {
  return n >= 1e12 ? n : n * 1000
}

function percent(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key]
  return undefined
}

export function parseQuotaLine(line: string): QuotaLine {
  const trimmed = line.trim()
  if (trimmed === '') return { kind: 'skipped' }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { kind: 'unparsed' }
  }
  if (!isRecord(value)) return { kind: 'unparsed' }

  // Lines without both percentages are other metric samples.
  const p5h = percent(value.limit_5h_pct)
  const p7d = percent(value.limit_7d_pct)
  if (p5h === undefined || p7d === undefined) return { kind: 'skipped' }

  const ts = toIso(firstDefined(value, ['ts', 'timestamp', 'time']))
  if (ts === undefined) return { kind: 'unparsed' }

  const resets = isRecord(value.resets) ? value.resets : {}
  const resets5h = toIso(firstDefined(value, ['limit_5h_resets', 'resets_5h', 'resets_5h_at']) ?? firstDefined(resets, ['5h', 'five_hour']))
  const resets7d = toIso(firstDefined(value, ['limit_7d_resets', 'resets_7d', 'resets_7d_at']) ?? firstDefined(resets, ['7d', 'seven_day']))

  return {
    kind: 'sample',
    sample: { ts, p5h, p7d, ...(resets5h ? { resets5h } : {}), ...(resets7d ? { resets7d } : {}) },
  }
}

export interface ParsedQuota {
  /** Sorted by time, oldest first, at most MAX_SAMPLES (the newest). */
  samples: QuotaSample[]
  unparsed: number
  skipped: number
}

/** Every sample not older than eight days before `nowMs`. Later ones are kept: replay asks for
 * the quota at a clock that runs through them, and quotaAt() only ever uses those at or before it. */
export function parseQuotaText(text: string, nowMs: number): ParsedQuota {
  const samples: QuotaSample[] = []
  let unparsed = 0
  let skipped = 0
  for (const line of text.split('\n')) {
    const parsed = parseQuotaLine(line)
    if (parsed.kind === 'unparsed') unparsed += 1
    else if (parsed.kind === 'skipped') {
      if (line.trim() !== '') skipped += 1
    } else if (Date.parse(parsed.sample.ts) >= nowMs - KEEP_SAMPLES_MS) samples.push(parsed.sample)
  }
  samples.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  return { samples: samples.length > MAX_SAMPLES ? samples.slice(-MAX_SAMPLES) : samples, unparsed, skipped }
}

/** The quota at `nowMs`, from the newest sample at or before it, with the reset rule:
 * a window whose reset time has passed reads 0 (and has no reset time). With no reset time known,
 * a sample older than its window (5 h, 7 d) reads 0 as well. Undefined without a sample. */
export function quotaAt(samples: readonly QuotaSample[], nowMs: number): Quota | undefined {
  let sample: QuotaSample | undefined
  for (const candidate of samples) {
    const ms = Date.parse(candidate.ts)
    if (ms <= nowMs && (!sample || ms >= Date.parse(sample.ts))) sample = candidate
  }
  if (!sample) return undefined
  const sampledMs = Date.parse(sample.ts)

  const window = (pct: number | undefined, resets: string | undefined, windowMs: number): { pct: number; resets?: string } => {
    if (resets !== undefined) {
      const resetMs = Date.parse(resets)
      if (!Number.isNaN(resetMs)) return resetMs <= nowMs ? { pct: 0 } : { pct: pct ?? 0, resets }
    }
    return nowMs - sampledMs > windowMs ? { pct: 0 } : { pct: pct ?? 0 }
  }
  const five = window(sample.p5h, sample.resets5h, WINDOW_5H_MS)
  const seven = window(sample.p7d, sample.resets7d, WINDOW_7D_MS)
  return {
    p5h: five.pct,
    p7d: seven.pct,
    ...(five.resets ? { resets5h: five.resets } : {}),
    ...(seven.resets ? { resets7d: seven.resets } : {}),
    sampledAt: sample.ts,
  }
}
