// How a file that someone else could have replaced is opened for reading (C6, R4-4): without waiting for a
// writer, and judged by the descriptor's own fstat. A path that was a regular file when it was looked at can
// be a FIFO by the time it is opened (a swap in between), and open(2) of a FIFO for reading waits for a
// writer, for good, on a libuv thread; a few of those use up the pool and every file read behind them stalls.
// With O_NONBLOCK the open returns at once, and what the descriptor turns out to be is checked on the
// descriptor, so what was checked is what is read.

import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

/** A seam for tests: the real `open`, or one that swaps the file for a FIFO first. */
export type OpenFile = (path: string, flags: number) => Promise<FileHandle>

/** The `code` of the error for something that is not a regular file, and for a file over the cap. */
export const NOT_REGULAR = 'not a regular file'
export const TOO_LARGE = 'file too large'

export interface RegularFile {
  handle: FileHandle
  /** The descriptor's own size. */
  size: number
}

/** Opens `path` for reading and refuses anything that is not a regular file. The caller closes the handle. */
export async function openRegular(path: string, openFile: OpenFile = open): Promise<RegularFile> {
  const handle = await openFile(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw Object.assign(new Error(NOT_REGULAR), { code: NOT_REGULAR })
    return { handle, size: info.size }
  } catch (err) {
    await handle.close().catch(() => undefined)
    throw err
  }
}

/** The text of a regular file from one descriptor: open, fstat, read. A file over `maxBytes` is refused
 * (`code` TOO_LARGE) before anything is read, and a file that grows meanwhile is read only up to the size
 * the descriptor reported. */
export async function readRegularText(path: string, maxBytes = Number.POSITIVE_INFINITY, openFile: OpenFile = open): Promise<string> {
  const { handle, size } = await openRegular(path, openFile)
  try {
    if (size > maxBytes) throw Object.assign(new Error(TOO_LARGE), { code: TOO_LARGE })
    const buffer = Buffer.alloc(size)
    let filled = 0
    while (filled < size) {
      const { bytesRead } = await handle.read(buffer, filled, size - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return buffer.toString('utf8', 0, filled)
  } finally {
    await handle.close()
  }
}
