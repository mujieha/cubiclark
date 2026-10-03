// Reads the custom-assets manifest (docs/assets.md). A missing file is not an error (no pack). A
// file that is too large, is not a regular file, is not JSON or breaks a rule is `invalid`: nothing
// from it is applied, and each problem is reported with a path. Never throws.

import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_MANIFEST_BYTES, validateManifest, type ManifestResult } from '../core/assets/manifest.js'
import { assetsStatusOf, publicAssets, type AssetsStatus, type PublicAssets } from '../core/assets/status.js'

export interface LoadedAssets {
  status: AssetsStatus
  /** Set only when the manifest is valid: what the page is sent. */
  overrides?: PublicAssets
}

/** `<state dir>/assets/manifest.json`. */
export function defaultAssetsPath(stateDir: string): string {
  return join(stateDir, 'assets', 'manifest.json')
}

function invalid(file: string, message: string): LoadedAssets {
  return { status: assetsStatusOf({ errors: [{ path: '', message }] }, file) }
}

function code(err: unknown): string {
  const value = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
  return typeof value === 'string' ? value : 'error'
}

export async function loadAssets(path: string | undefined): Promise<LoadedAssets> {
  if (path === undefined) return { status: assetsStatusOf(undefined, undefined) }
  let text: string
  try {
    // Looked at before it is opened: open(2) of a FIFO for reading waits for a writer, so start-up would
    // hang with no message (R2-10). O_NONBLOCK keeps a file swapped for a FIFO after this from waiting.
    if (!(await stat(path)).isFile()) return invalid(path, 'not a regular file')
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      // One descriptor for the check and the read (the file cannot change between them).
      const info = await handle.stat()
      if (!info.isFile()) return invalid(path, 'not a regular file')
      if (info.size > MAX_MANIFEST_BYTES) return invalid(path, `larger than ${MAX_MANIFEST_BYTES / 1024} KiB`)
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (err) {
    const c = code(err)
    if (c === 'ENOENT' || c === 'ENOTDIR') return { status: assetsStatusOf(undefined, undefined) }
    return invalid(path, `cannot read: ${c}`)
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return invalid(path, `not JSON: ${err instanceof Error ? err.message.slice(0, 120) : 'parse error'}`)
  }
  const result: ManifestResult = validateManifest(value)
  const status = assetsStatusOf(result, path)
  return result.manifest ? { status, overrides: publicAssets(result.manifest) } : { status }
}
