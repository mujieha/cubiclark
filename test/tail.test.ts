import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open as openFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { LineTailer } from '../src/server/tail.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-tail-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LineTailer', () => {
  test('reads complete lines', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'one\ntwo\nthree\n', 'utf8')
    const tailer = new LineTailer(file)
    const result = await tailer.poll()
    expect(result.lines).toEqual(['one', 'two', 'three'])
    expect(result.truncated).toBe(false)
  })

  test('holds a partial line until its newline arrives', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'one\ntwo', 'utf8')
    const tailer = new LineTailer(file)
    const first = await tailer.poll()
    expect(first.lines).toEqual(['one'])

    await writeFile(file, 'one\ntwo\nthree\n', 'utf8')
    const second = await tailer.poll()
    expect(second.lines).toEqual(['two', 'three'])
  })

  test('truncation resets the offset to 0 and records a source error', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'one\ntwo\nthree\n', 'utf8')
    const tailer = new LineTailer(file)
    await tailer.poll()
    expect(tailer.getOffset()).toBeGreaterThan(0)

    await writeFile(file, 'x\n', 'utf8')
    const result = await tailer.poll()
    expect(result.truncated).toBe(true)
    expect(result.error).toContain('shrank')
    expect(result.lines).toEqual(['x'])
    expect(tailer.getOffset()).toBe(2)
  })

  test('strips a trailing carriage return from CRLF lines', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'one\r\ntwo\r\n', 'utf8')
    const tailer = new LineTailer(file)
    const result = await tailer.poll()
    expect(result.lines).toEqual(['one', 'two'])
  })

  test('an empty file produces no lines and no error', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, '', 'utf8')
    const tailer = new LineTailer(file)
    const result = await tailer.poll()
    expect(result.lines).toEqual([])
    expect(result.error).toBeUndefined()
  })
})

// S1-2: a file is read in bounded pieces, and a line that never ends is dropped, not accumulated.
describe('LineTailer limits', () => {
  test('a line longer than the cap is dropped and counted; the next line still comes through', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, `${'x'.repeat(300)}\nnormal\n`, 'utf8')
    const tailer = new LineTailer(file, { maxLineBytes: 100, chunkBytes: 64 })
    const result = await collect(tailer)
    expect(result.lines).toEqual(['normal'])
    expect(result.tooLong).toBe(1)
  })

  test('a long line that ends in a later poll is counted once and does not swallow the next line', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'x'.repeat(250), 'utf8')
    const tailer = new LineTailer(file, { maxLineBytes: 100, chunkBytes: 64 })
    const first = await collect(tailer)
    expect(first.lines).toEqual([])
    expect(first.tooLong).toBe(1)
    await appendFile(file, `${'y'.repeat(50)}\nnext\n`, 'utf8')
    const second = await collect(tailer)
    expect(second.lines).toEqual(['next'])
    expect(second.tooLong).toBe(0)
  })

  test('a pending partial line never grows past the cap', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'x'.repeat(10_000), 'utf8')
    const tailer = new LineTailer(file, { maxLineBytes: 100, chunkBytes: 64 })
    await collect(tailer)
    expect(tailer.pendingBytes()).toBeLessThanOrEqual(100)
  })

  test('a poll reads at most maxPollBytes and says there is more', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'aaaa\n'.repeat(100), 'utf8')
    const tailer = new LineTailer(file, { chunkBytes: 50, maxPollBytes: 100 })
    const first = await tailer.poll()
    expect(first.more).toBe(true)
    expect(first.lines.length).toBeLessThanOrEqual(20)
    const rest = await collect(tailer)
    expect(first.lines.length + rest.lines.length).toBe(100)
  })

  test('a multi-byte character split by a chunk boundary comes out whole', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'héllo wörld ünï\n', 'utf8')
    const tailer = new LineTailer(file, { chunkBytes: 3 })
    const result = await collect(tailer)
    expect(result.lines).toEqual(['héllo wörld ünï'])
  })

  test('a symlink to a directory is an error result, not a throw', async () => {
    const target = join(dir, 'a-directory')
    await mkdir(target)
    const link = join(dir, 'link.jsonl')
    await symlink(target, link)
    const result = await new LineTailer(link).poll()
    expect(result.lines).toEqual([])
    expect(result.error).toMatch(/not a regular file/)
  })

  // C6: the path is a regular file when it is looked at and a FIFO when it is opened (a swap in between).
  // The tailer opens without waiting for a writer and refuses what it opened by its own descriptor. The seam
  // makes the swap, then opens as the tailer asked: a blocking open is refused here, so a build that waits
  // for a writer fails the test instead of hanging the worker.
  test.skipIf(process.platform === 'win32')('a file swapped for a FIFO after the stat is refused, and the open does not wait (C6)', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'one\n', 'utf8')
    let flagsSeen: unknown
    const tailer = new LineTailer(file, {
      open: async (path, flags) => {
        flagsSeen = flags
        await rm(path)
        execFileSync('mkfifo', [path])
        if (typeof flags !== 'number' || (flags & constants.O_NONBLOCK) === 0) throw Object.assign(new Error('would wait for a writer'), { code: 'EWAIT' })
        return await openFile(path, flags)
      },
    })
    const result = await tailer.poll()
    expect(result.lines).toEqual([])
    expect(result.error).toBe('not a regular file')
    expect(flagsSeen).toBe(constants.O_RDONLY | constants.O_NONBLOCK)
  }, 5000)

  test('a read that fails is an error result, not a throw', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'one\n', 'utf8')
    const failure = Object.assign(new Error(`EIO: boom at ${file}`), { code: 'EIO' })
    const tailer = new LineTailer(file, { open: async () => { throw failure } })
    const result = await tailer.poll()
    expect(result.error).toBe('cannot open: EIO')
    expect(result.error).not.toContain(dir)
  })
})

async function collect(tailer: LineTailer): Promise<{ lines: string[]; tooLong: number }> {
  const lines: string[] = []
  let tooLong = 0
  for (;;) {
    const result = await tailer.poll()
    lines.push(...result.lines)
    tooLong += result.tooLong
    if (!result.more) return { lines, tooLong }
  }
}
