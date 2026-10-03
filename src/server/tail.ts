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

  constructor(
    private readonly path: string,
    options: TailerOptions = {}
  ) {
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

  async poll(): Promise<TailResult> {
    const result: TailResult = { lines: [], truncated: false, tooLong: 0, more: false }
    let size: number
    try {
      const info = await stat(this.path)
      if (!info.isFile()) return { ...result, error: 'not a regular file' }
      size = info.size
    } catch (err) {
      return { ...result, error: `cannot stat: ${errorMessage(err)}` }
    }

    if (size < this.offset) {
      result.truncated = true
      result.error = `file shrank from ${this.offset} to ${size} bytes; restarting from the beginning`
      this.offset = 0
      this.buffer = ''
      this.skipping = false
      this.decoder = new StringDecoder('utf8')
    }

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
    } catch (err) {
      readFailed = true
      result.error = `cannot read: ${errorMessage(err)}`
    } finally {
      await handle.close().catch(() => undefined)
    }
    result.more = !readFailed && this.offset < size
    return result
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
