// Tails one file by byte offset, holding a partial trailing line across calls until its
// terminating newline arrives. Used for every session and subagent transcript; the transcript
// source calls poll() on a timer (and after a watch event) and feeds the returned lines to the
// parser one at a time.
//
// Memory is bounded (S1-2): a poll reads in chunks and stops after `maxPollBytes` (the caller
// polls again while `more` is set), and a line longer than `maxLineBytes` is dropped, counted in
// `tooLong`, and skipped up to its newline instead of accumulating. A file that is not a regular
// file, or a read that fails, is an error result, never a throw (S1-5).

import { constants } from 'node:fs'
import { open as openFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

export const CHUNK_BYTES = 1024 * 1024
/** Measured in characters of the decoded line, which is bytes for the ASCII a transcript is mostly made of. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024
export const MAX_POLL_BYTES = 8 * 1024 * 1024

export interface TailerOptions {
  chunkBytes?: number
  maxLineBytes?: number
  maxPollBytes?: number
  /** Where the file goes when something else renames it away (the collector's `events.1.jsonl`). When set, a
   * replaced or shrunken file is first read to its end there, from the old offset, if it is the same file (C7). */
  rotatedPath?: string
  /** A seam for tests. */
  open?: (path: string, flags: number) => Promise<FileHandle>
}

export interface TailResult {
  lines: string[]
  /** Set when the file was shorter than the last known offset: `/clear` and log rotation both
   * do this. The tailer resets to 0 and re-reads from the start; the caller should count this
   * as a source error rather than silently losing the gap. */
  truncated: boolean
  /** Lines longer than the cap that were dropped in this poll (each counted once). */
  tooLong: number
  /** The poll stopped at its byte budget and the file has more: poll again. */
  more: boolean
  error?: string
}

/** The errno code (`EACCES`), never Node's message, which names the path. */
function errorMessage(err: unknown): string {
  const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
  return typeof code === 'string' ? code : 'error'
}

/** Which file this is, by device and inode, so a rename can be told from a truncation. */
function identityOf(info: { dev: number; ino: number }): string | undefined {
  return info.ino === 0 ? undefined : `${info.dev}:${info.ino}`
}

export class LineTailer {
  private offset = 0
  private buffer = ''
  /** Inside a line that passed the cap: everything up to its newline is dropped. */
  private skipping = false
  private decoder = new StringDecoder('utf8')
  private readonly chunkBytes: number
  private readonly maxLineBytes: number
  private readonly maxPollBytes: number
  private readonly openFile: (path: string, flags: number) => Promise<FileHandle>
  private readonly rotatedPath: string | undefined
  /** Device and inode of the file the offset belongs to, when known (not on every file system). */
  private identity: string | undefined

  constructor(
    private readonly path: string,
    options: TailerOptions = {}
  ) {
    this.rotatedPath = options.rotatedPath
    this.chunkBytes = options.chunkBytes ?? CHUNK_BYTES
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES
    this.maxPollBytes = options.maxPollBytes ?? MAX_POLL_BYTES
    this.openFile = options.open ?? ((path, flags) => openFile(path, flags))
  }

  getOffset(): number {
    return this.offset
  }

  /** The characters of a line held back until its newline arrives (never more than the cap). */
  pendingBytes(): number {
    return this.buffer.length
  }

  /** The file the offset belongs to has been replaced by another one (rotation). Only with `rotatedPath`. */
  private replaced(now: string | undefined): boolean {
    return this.rotatedPath !== undefined && this.identity !== undefined && now !== undefined && now !== this.identity
  }

  /** The file is not the one the offset belongs to: first the rest of the old one, if it is still around as
   * `rotatedPath`, then the state is reset and the new file is read from its start. */
  private async restart(result: TailResult, message: string): Promise<void> {
    await this.drainRotated(result)
    result.truncated = true
    result.error = message
    this.offset = 0
    this.buffer = ''
    this.skipping = false
    this.decoder = new StringDecoder('utf8')
  }

  /** With `rotatedPath` set: what was appended to the file being read after the last poll, and now sits in
   * the rotated file past the offset (C7). It is read only when that file is the one the offset belongs to
   * (same device and inode), so a stale rotated file, or a file truncated in place, is never read as if it
   * were the end of this one. Never throws; bounded like a poll. The caller discards the tailer or restarts it. */
  async drainRotated(into: TailResult = { lines: [], truncated: false, tooLong: 0, more: false }): Promise<TailResult> {
    if (this.rotatedPath === undefined || this.identity === undefined) return into
    let handle: FileHandle
    try {
      handle = await this.openFile(this.rotatedPath, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch {
      return into
    }
    try {
      const info = await handle.stat()
      if (info.isFile() && identityOf(info) === this.identity) await this.readFrom(handle, info.size, into)
    } catch {
      // whatever could not be read is not recovered; the new file is still followed
    } finally {
      await handle.close().catch(() => undefined)
    }
    return into
  }

  async poll(): Promise<TailResult> {
    const result: TailResult = { lines: [], truncated: false, tooLong: 0, more: false }
    let size: number
    let seen: string | undefined
    try {
      const info = await stat(this.path)
      if (!info.isFile()) return { ...result, error: 'not a regular file' }
      size = info.size
      seen = identityOf(info)
    } catch (err) {
      return { ...result, error: `cannot stat: ${errorMessage(err)}` }
    }

    if (size < this.offset) {
      await this.restart(result, `file shrank from ${this.offset} to ${size} bytes; restarting from the beginning`)
    } else if (this.replaced(seen)) {
      await this.restart(result, 'file was replaced; restarting from the beginning')
    }
    this.identity = seen

    if (size === this.offset) return result

    // The stat above only decides whether there is anything to read. What is read is what this descriptor
    // is: opened without waiting for a writer (a FIFO swapped in after the stat would block a thread and
    // the whole pass behind it) and checked by its own fstat (C6).
    let handle: FileHandle
    try {
      handle = await this.openFile(this.path, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch (err) {
      return { ...result, error: `cannot open: ${errorMessage(err)}` }
    }
    let readFailed = false
    try {
      const opened = await handle.stat()
      if (!opened.isFile()) return { ...result, error: 'not a regular file' }
      size = opened.size
      // Replaced between the stat and the open: the descriptor is the new file, and the offset is the old one's.
      const now = identityOf(opened)
      if (this.replaced(now)) {
        await this.restart(result, 'file was replaced; restarting from the beginning')
        this.identity = now
      }
      await this.readFrom(handle, size, result)
    } catch (err) {
      readFailed = true
      result.error = `cannot read: ${errorMessage(err)}`
    } finally {
      await handle.close().catch(() => undefined)
    }
    result.more = !readFailed && this.offset < size
    return result
  }

  /** Reads from the offset to `size` or to the poll's byte budget, whichever comes first. */
  private async readFrom(handle: FileHandle, size: number, result: TailResult): Promise<void> {
    const buf = Buffer.alloc(Math.min(this.chunkBytes, Math.max(0, size - this.offset)))
    let readThisPoll = 0
    while (this.offset < size && readThisPoll < this.maxPollBytes) {
      const length = Math.min(buf.length, size - this.offset, this.maxPollBytes - readThisPoll)
      const { bytesRead } = await handle.read(buf, 0, length, this.offset)
      if (bytesRead === 0) break
      this.offset += bytesRead
      readThisPoll += bytesRead
      this.take(this.decoder.write(buf.subarray(0, bytesRead)), result)
    }
  }

  /** Splits decoded text into lines, keeping the unfinished last one (within the cap). */
  private take(text: string, result: TailResult): void {
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      if (newline === -1) {
        const rest = text.slice(start)
        if (this.skipping) return
        this.buffer += rest
        if (this.buffer.length > this.maxLineBytes) {
          result.tooLong += 1
          this.skipping = true
          this.buffer = ''
        }
        return
      }
      const piece = text.slice(start, newline)
      start = newline + 1
      if (this.skipping) {
        // The newline that ends a line already dropped and counted.
        this.skipping = false
        this.buffer = ''
        continue
      }
      const line = this.buffer + piece
      this.buffer = ''
      if (line.length > this.maxLineBytes) {
        result.tooLong += 1
        continue
      }
      result.lines.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
  }
}
