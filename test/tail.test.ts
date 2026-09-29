import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
