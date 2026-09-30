// What the page and `doctor` are told about the custom-assets manifest: a status and the problems,
// never the sprites themselves (those go to the page separately, once validated).

import type { AssetsManifest, ManifestResult } from './manifest.js'

/** A message of the status is at most this long, and there are at most MAX_SHOWN_ERRORS of them. */
export const MAX_ERROR_CHARS = 200
export const MAX_SHOWN_ERRORS = 10

export interface AssetsStatus {
  /** none: no manifest. ok: read and valid. invalid: read, and not applied. */
  status: 'none' | 'ok' | 'invalid'
  /** The manifest file's name, never its path. */
  file?: string
  name?: string
  /** Which themes the pack has colours for. */
  palettes: ('day' | 'night')[]
  sprites: number
  /** `<path>: <message>`, the first MAX_SHOWN_ERRORS. */
  errors: string[]
  /** All of them, including those not listed. */
  errorCount: number
}

/** What the page needs to draw a valid pack. */
export interface PublicAssets {
  palettes: AssetsManifest['palettes']
  sprites: AssetsManifest['sprites']
}

export const NO_ASSETS: PublicAssets = { palettes: {}, sprites: {} }

function baseName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').pop() ?? ''
}

function cap(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text
}

/** `result` undefined means there was no manifest to read. */
export function assetsStatusOf(result: ManifestResult | undefined, file: string | undefined): AssetsStatus {
  if (result === undefined) return { status: 'none', palettes: [], sprites: 0, errors: [], errorCount: 0 }
  const shownFile = file === undefined ? {} : { file: baseName(file) }
  if (result.manifest) {
    const { manifest } = result
    return {
      status: 'ok',
      ...shownFile,
      name: manifest.name,
      palettes: (['day', 'night'] as const).filter((id) => manifest.palettes[id] !== undefined),
      sprites: Object.keys(manifest.sprites).length,
      errors: [],
      errorCount: 0,
    }
  }
  return {
    status: 'invalid',
    ...shownFile,
    palettes: [],
    sprites: 0,
    errors: result.errors.slice(0, MAX_SHOWN_ERRORS).map((error) => cap(`${error.path === '' ? '(file)' : error.path}: ${error.message}`)),
    errorCount: result.errors.length,
  }
}

/** A short line for the sources line and for doctor: `none`, `ok — sunny-office: 2 palettes, 3 sprites`, `invalid — 3 errors`. */
export function assetsText(status: AssetsStatus): string {
  if (status.status === 'none') return 'none'
  if (status.status === 'ok') {
    const palettes = `${status.palettes.length} palette${status.palettes.length === 1 ? '' : 's'}`
    const sprites = `${status.sprites} sprite${status.sprites === 1 ? '' : 's'}`
    return `ok — ${status.name ?? 'pack'}: ${palettes}, ${sprites}`
  }
  return `invalid — ${status.errorCount} error${status.errorCount === 1 ? '' : 's'}`
}

export function publicAssets(manifest: AssetsManifest): PublicAssets {
  return { palettes: manifest.palettes, sprites: manifest.sprites }
}
