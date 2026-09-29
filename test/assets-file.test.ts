// Reading the custom-assets manifest: none, ok, and every way of being invalid, without a throw.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MAX_MANIFEST_BYTES } from '../src/core/assets/manifest.js'
import { defaultAssetsPath, loadAssets } from '../src/server/assets-file.js'

const EXAMPLE = fileURLToPath(new URL('../examples/assets/sunny-office/manifest.json', import.meta.url))
const INVALID = fileURLToPath(new URL('./fixtures/assets/invalid.json', import.meta.url))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-assets-'))
})
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

describe('loadAssets', () => {
  test('no path, a missing file and a missing directory are none, without an error', async () => {
    for (const path of [undefined, join(dir, 'nope.json'), join(dir, 'nope', 'manifest.json')]) {
      const loaded = await loadAssets(path)
      expect(loaded.status.status, String(path)).toBe('none')
      expect(loaded.overrides).toBeUndefined()
    }
  })

  test('the example pack is ok, with its palettes and sprites for the page', async () => {
    const loaded = await loadAssets(EXAMPLE)
    expect(loaded.status).toMatchObject({ status: 'ok', name: 'sunny-office', file: 'manifest.json', palettes: ['day', 'night'], sprites: 2 })
    expect(Object.keys(loaded.overrides?.sprites ?? {})).toEqual(['accessory:headphones', 'tile:floor_carpet_planning'])
    expect(loaded.overrides?.palettes.day?.['7']).toBe('#d9a86c')
  })

  test('an invalid manifest is invalid with its errors and nothing for the page', async () => {
    const loaded = await loadAssets(INVALID)
    expect(loaded.status.status).toBe('invalid')
    expect(loaded.status.errorCount).toBe(9)
    expect(loaded.overrides).toBeUndefined()
  })

  test('a file over the size limit is refused without being read', async () => {
    const file = join(dir, 'big.json')
    await writeFile(file, `{"version":1,"name":"big","description":"${'x'.repeat(MAX_MANIFEST_BYTES)}"}`)
    const loaded = await loadAssets(file)
    expect(loaded.status).toMatchObject({ status: 'invalid', errorCount: 1 })
    expect(loaded.status.errors[0]).toBe('(file): larger than 256 KiB')
  })

  test('a directory is invalid, not a throw', async () => {
    const loaded = await loadAssets(dir)
    expect(loaded.status.status).toBe('invalid')
    expect(loaded.status.errors[0]).toBe('(file): not a regular file')
  })

  test('broken JSON is one error starting "not JSON:"', async () => {
    const file = join(dir, 'broken.json')
    await writeFile(file, '{"version": ')
    const loaded = await loadAssets(file)
    expect(loaded.status.errorCount).toBe(1)
    expect(loaded.status.errors[0]).toMatch(/^\(file\): not JSON: /)
    expect(loaded.status.errors[0]).not.toContain(dir)
  })

  test('a file that cannot be read is invalid with the error code, never the path', async () => {
    const file = join(dir, 'locked.json')
    await writeFile(file, '{}')
    await chmod(file, 0o000)
    const loaded = await loadAssets(file)
    await chmod(file, 0o600)
    expect(loaded.status.status).toBe('invalid')
    expect(loaded.status.errors[0]).toBe('(file): cannot read: EACCES')
  })

  test('a JSON value that is not an object is invalid', async () => {
    const file = join(dir, 'array.json')
    await writeFile(file, '[1, 2]')
    expect((await loadAssets(file)).status.errors).toEqual(['(file): the manifest must be a JSON object'])
  })

  test('the default path is <state dir>/assets/manifest.json, and a manifest there is found', async () => {
    expect(defaultAssetsPath('/state')).toBe('/state/assets/manifest.json')
    await mkdir(join(dir, 'assets'))
    await writeFile(defaultAssetsPath(dir), JSON.stringify({ version: 1, name: 'default-pack' }))
    expect((await loadAssets(defaultAssetsPath(dir))).status).toMatchObject({ status: 'ok', name: 'default-pack', sprites: 0 })
  })
})
