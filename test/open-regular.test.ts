// R4-4: the one way a file that someone else could have replaced is opened for reading. A regular file is read
// from one descriptor; a directory, a FIFO or a file over the cap is refused, and the descriptor is closed.

import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open as openFile, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { NOT_REGULAR, TOO_LARGE, openRegular, readRegularText } from '../src/server/open-regular.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-openregular-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('openRegular and readRegularText', () => {
  test('a regular file is read whole, from the size its own descriptor reports', async () => {
    const path = join(dir, 'a.json')
    await writeFile(path, '{"a":"é"}\n', 'utf8')
    expect(await readRegularText(path)).toBe('{"a":"é"}\n')
    const { handle, size } = await openRegular(path)
    expect(size).toBe(Buffer.byteLength('{"a":"é"}\n'))
    await handle.close()
  })

  test('the open is asked not to wait for a writer', async () => {
    const path = join(dir, 'a.json')
    await writeFile(path, 'x', 'utf8')
    let flagsSeen: number | undefined
    await readRegularText(path, undefined, async (p, flags) => {
      flagsSeen = flags
      return await openFile(p, flags)
    })
    expect(flagsSeen).toBe(constants.O_RDONLY | constants.O_NONBLOCK)
  })

  test('a missing file keeps its own error code', async () => {
    await expect(readRegularText(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a directory is refused', async () => {
    const path = join(dir, 'sub')
    await mkdir(path)
    await expect(readRegularText(path)).rejects.toMatchObject({ code: NOT_REGULAR })
  })

  test('a file over the cap is refused before it is read, and one at the cap is read', async () => {
    const path = join(dir, 'big.json')
    await writeFile(path, 'x'.repeat(11), 'utf8')
    await expect(readRegularText(path, 10)).rejects.toMatchObject({ code: TOO_LARGE })
    await writeFile(path, 'x'.repeat(10), 'utf8')
    expect(await readRegularText(path, 10)).toBe('x'.repeat(10))
  })

  test.skipIf(process.platform === 'win32')('a FIFO is refused without waiting, and its descriptor is closed', async () => {
    const path = join(dir, 'pipe')
    execFileSync('mkfifo', [path])
    let opened: FileHandle | undefined
    const seam = async (p: string, flags: number): Promise<FileHandle> => {
      if ((flags & constants.O_NONBLOCK) === 0) throw Object.assign(new Error('would wait for a writer'), { code: 'EWAIT' })
      opened = await openFile(p, flags)
      return opened
    }
    await expect(openRegular(path, seam)).rejects.toMatchObject({ code: NOT_REGULAR })
    await expect(opened?.stat()).rejects.toBeDefined() // closed
  }, 5000)
})
