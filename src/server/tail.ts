// Tails one file by byte offset, holding a partial trailing line across calls until its
// terminating newline arrives. Used for every session and subagent transcript; the transcript
// source calls poll() on a timer (and after a watch event) and feeds the returned lines to the
// parser one at a time.

import { open, stat } from 'node:fs/promises'

export interface TailResult {
  lines: string[]
  /** Set when the file was shorter than the last known offset: `/clear` and log rotation both
   * do this. The tailer resets to 0 and re-reads from the start; the caller should count this
   * as a source error rather than silently losing the gap. */
  truncated: boolean
  error?: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class LineTailer {
  private offset = 0
  private buffer = ''

  constructor(private readonly path: string) {}

  getOffset(): number {
    return this.offset
  }

  async poll(): Promise<TailResult> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch (err) {
      return { lines: [], truncated: false, error: `cannot stat: ${errorMessage(err)}` }
    }

    let truncated = false
    let error: string | undefined
    if (size < this.offset) {
      truncated = true
      error = `file shrank from ${this.offset} to ${size} bytes; restarting from the beginning`
      this.offset = 0
      this.buffer = ''
    }

    if (size === this.offset) {
      return { lines: [], truncated, error }
    }

    let handle
    try {
      handle = await open(this.path, 'r')
    } catch (err) {
      return { lines: [], truncated, error: `cannot open: ${errorMessage(err)}` }
    }
    try {
      const length = size - this.offset
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, this.offset)
      this.offset += bytesRead
      this.buffer += buf.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }

    const parts = this.buffer.split('\n')
    this.buffer = parts.pop() ?? '' // the last part is a partial line (or '' at a clean EOF)
    const lines = parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    return { lines, truncated, error }
  }
}
