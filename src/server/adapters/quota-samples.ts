// The quota-samples adapter: reads the tail of a JSONL samples file. The configured path may end
// in a glob (`samples-*.jsonl`, one file per day): the newest matching file by mtime is read, and
// the directory is listed again on every poll, so a new day's file is picked up. Read-only, and
// detect() and snapshot() never throw.

import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AdapterConfig } from '../../core/adapters/config.js'
import { parseQuotaText } from '../../core/adapters/quota.js'
import type { AdapterEnv, AdapterSnapshot, OrchestrationAdapter, QuotaSample } from '../../core/adapters/types.js'

type QuotaConfig = NonNullable<AdapterConfig['quotaSamples']>

/** Only this much of a file's end is read: a day of samples is far smaller. */
export const TAIL_BYTES = 256 * 1024
/** When the newest file has no samples yet (just after midnight), this many files are tried. */
const MAX_FILES = 2

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? ((err as NodeJS.ErrnoException).code as string)
    : 'read error'
}

export class QuotaSamplesAdapter implements OrchestrationAdapter {
  readonly id = 'quota-samples'
  readonly pollMs = 10_000
  /** Lines with no percentages in the last snapshot (other metric samples), for the status line. */
  lastSkipped = 0
  lastSampleCount = 0
  /** The file the last snapshot read from, by name only. */
  lastFileName: string | undefined
  private readonly cache = new Map<string, { mtimeMs: number; size: number; text: string }>()

  constructor(
    private readonly config: QuotaConfig,
    private readonly env: AdapterEnv
  ) {}

  /** The files to read, newest first by mtime (ties by name, descending). */
  private async candidates(): Promise<{ path: string; mtimeMs: number }[]> {
    const name = basename(this.config.file)
    if (!/[*?]/.test(name)) {
      try {
        const info = await stat(this.config.file)
        return info.isFile() ? [{ path: this.config.file, mtimeMs: info.mtimeMs }] : []
      } catch {
        return []
      }
    }
    const dir = dirname(this.config.file)
    const pattern = globToRegExp(name)
    let names: string[]
    try {
      names = (await readdir(dir)).filter((entry) => pattern.test(entry))
    } catch {
      return []
    }
    const found: { path: string; mtimeMs: number; name: string }[] = []
    for (const entry of names) {
      try {
        const info = await stat(join(dir, entry))
        if (info.isFile()) found.push({ path: join(dir, entry), mtimeMs: info.mtimeMs, name: entry })
      } catch {
        // vanished between the listing and the stat
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  }

  async detect(): Promise<boolean> {
    try {
      return (await this.candidates()).length > 0
    } catch {
      return false
    }
  }

  /** The end of the file: the first, possibly partial, line is dropped when the read did not start at 0. */
  private async readTail(path: string, mtimeMs: number): Promise<string> {
    const info = await stat(path)
    const cached = this.cache.get(path)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === info.size) return cached.text
    const start = Math.max(0, info.size - TAIL_BYTES)
    const handle = await open(path, 'r')
    let text: string
    try {
      const buffer = Buffer.alloc(info.size - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    this.cache.set(path, { mtimeMs, size: info.size, text })
    return text
  }

  async snapshot(): Promise<AdapterSnapshot> {
    const errors: string[] = []
    let unparsed = 0
    let skipped = 0
    const samples: QuotaSample[] = []
    this.lastFileName = undefined
    try {
      const files = await this.candidates()
      const live = new Set(files.map((file) => file.path))
      for (const path of this.cache.keys()) if (!live.has(path)) this.cache.delete(path)
      if (files.length === 0) errors.push('no samples file found')
      for (const file of files.slice(0, MAX_FILES)) {
        try {
          const parsed = parseQuotaText(await this.readTail(file.path, file.mtimeMs), this.env.nowMs())
          unparsed += parsed.unparsed
          skipped += parsed.skipped
          samples.push(...parsed.samples)
          this.lastFileName ??= basename(file.path)
        } catch (err) {
          errors.push(`cannot read ${basename(file.path)}: ${errorCode(err)}`)
        }
        if (samples.length > 0) break
      }
    } catch (err) {
      errors.push(`cannot read the samples file: ${errorCode(err)}`)
    }
    samples.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    this.lastSkipped = skipped
    this.lastSampleCount = samples.length
    return { quotaSamples: samples, diagnostics: { unparsed, errors } }
  }
}
