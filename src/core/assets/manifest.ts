// The custom-assets manifest (docs/assets.md): our own JSON format, validated as data. Pure: the server
// reads the file and passes what JSON.parse returned. Never throws; every problem is an error with a
// JSON-pointer-like path and a sentence. A manifest with any error is not applied at all.
//
// What a manifest may hold: palette colours per theme, and string-grid sprites for the ids in
// SPRITE_CATALOGUE. It is never code and never markup, and nothing in it is trusted.

import { THEMES } from '../theme/index.js'
import { paletteProblems } from '../theme/rules.js'
import { mergePalette, PALETTE_KEYS, type ThemeId } from '../theme/theme.js'
import { SPRITE_CATALOGUE } from './catalogue.js'

export const MANIFEST_VERSION = 1
export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_SPRITES = 200
export const MAX_ERRORS = 50
export const MAX_DESCRIPTION_CHARS = 200
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const COLOUR_RE = /^#[0-9a-fA-F]{6}$/
const THEME_IDS: readonly ThemeId[] = ['day', 'night']
const TOP_KEYS = ['$schema', 'version', 'name', 'description', 'palettes', 'sprites']

export interface AssetsManifest {
  version: 1
  name: string
  description?: string
  palettes: Partial<Record<ThemeId, Partial<Record<string, string>>>>
  sprites: Record<string, { rows: string[] }>
}

export interface AssetError {
  /** Where: `/sprites/tile:floor_wood/rows/3`, or '' for the file as a whole. */
  path: string
  message: string
}

export interface ManifestResult {
  /** Set only when `errors` is empty. */
  manifest?: AssetsManifest
  errors: AssetError[]
}

/** A user-supplied key as it is safe to print: control characters removed, at most 40 characters. */
export function safeSegment(key: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = key.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class Errors {
  readonly list: AssetError[] = []
  private dropped = 0
  add(path: string, message: string): void {
    if (this.list.length < MAX_ERRORS) this.list.push({ path, message })
    else this.dropped += 1
  }
  get count(): number {
    return this.list.length
  }
  finish(): AssetError[] {
    if (this.dropped > 0) this.list.push({ path: '', message: `…and ${this.dropped} more error${this.dropped === 1 ? '' : 's'} not shown` })
    return this.list
  }
}

const PALETTE_KEY_SET: ReadonlySet<string> = new Set<string>(PALETTE_KEYS)

/** Never throws. `manifest` is set only when `errors` is empty. */
export function validateManifest(value: unknown): ManifestResult {
  const errors = new Errors()
  if (!isRecord(value)) {
    errors.add('', 'the manifest must be a JSON object')
    return { errors: errors.finish() }
  }

  for (const key of Object.keys(value)) {
    if (!TOP_KEYS.includes(key)) errors.add(`/${safeSegment(key)}`, 'unknown key (allowed: $schema, version, name, description, palettes, sprites)')
  }
  if (value.$schema !== undefined && (typeof value.$schema !== 'string' || value.$schema.length > 200)) {
    errors.add('/$schema', 'must be a string of at most 200 characters')
  }
  if (value.version !== MANIFEST_VERSION) errors.add('/version', `must be ${MANIFEST_VERSION}`)
  const name = value.name
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errors.add('/name', 'must be 1 to 40 characters: lower-case letters, digits and "-", not starting with "-"')
  }
  const description = value.description
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_CHARS)) {
    errors.add('/description', `must be a string of at most ${MAX_DESCRIPTION_CHARS} characters`)
  }

  const palettes = validatePalettes(value.palettes, errors)
  const sprites = validateSprites(value.sprites, errors)

  const all = errors.finish()
  if (all.length > 0) return { errors: all }
  return {
    manifest: {
      version: 1,
      name: name as string,
      ...(typeof description === 'string' ? { description } : {}),
      palettes,
      sprites,
    },
    errors: [],
  }
}

function validatePalettes(raw: unknown, errors: Errors): AssetsManifest['palettes'] {
  const out: AssetsManifest['palettes'] = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    errors.add('/palettes', 'must be an object with the keys "day" and "night"')
    return out
  }
  for (const key of Object.keys(raw)) {
    if (!(THEME_IDS as readonly string[]).includes(key)) errors.add(`/palettes/${safeSegment(key)}`, 'unknown theme (allowed: day, night)')
  }
  for (const id of THEME_IDS) {
    const overrides = raw[id]
    if (overrides === undefined) continue
    if (!isRecord(overrides)) {
      errors.add(`/palettes/${id}`, 'must be an object of palette key to #rrggbb colour')
      continue
    }
    const good: Record<string, string> = {}
    let clean = true
    for (const [key, colour] of Object.entries(overrides)) {
      if (!PALETTE_KEY_SET.has(key)) {
        errors.add(`/palettes/${id}/${safeSegment(key)}`, 'not a palette key (0-9 and a-f)')
        clean = false
      } else if (typeof colour !== 'string' || !COLOUR_RE.test(colour)) {
        errors.add(`/palettes/${id}/${key}`, 'must be a colour written #rrggbb')
        clean = false
      } else {
        good[key] = colour
      }
    }
    if (!clean) continue
    // The merged palette must still tell every state apart (src/core/theme/rules.ts).
    const problems = paletteProblems(mergePalette(THEMES[id].palette, good))
    for (const problem of problems) errors.add(`/palettes/${id}`, problem)
    if (problems.length === 0) out[id] = good
  }
  return out
}

function validateSprites(raw: unknown, errors: Errors): AssetsManifest['sprites'] {
  const out: AssetsManifest['sprites'] = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    errors.add('/sprites', 'must be an object of sprite id to { "rows": [...] }')
    return out
  }
  const ids = Object.keys(raw)
  if (ids.length > MAX_SPRITES) errors.add('/sprites', `has ${ids.length} sprites, at most ${MAX_SPRITES}`)
  for (const id of ids.slice(0, MAX_SPRITES)) {
    const here = `/sprites/${safeSegment(id)}`
    const entry = Object.hasOwn(SPRITE_CATALOGUE, id) ? SPRITE_CATALOGUE[id] : undefined
    if (!entry) {
      errors.add(here, 'not a sprite that can be replaced (see docs/assets.md for the ids)')
      continue
    }
    const sprite = raw[id]
    if (!isRecord(sprite)) {
      errors.add(here, 'must be an object with "rows"')
      continue
    }
    for (const key of Object.keys(sprite)) if (key !== 'rows') errors.add(`${here}/${safeSegment(key)}`, 'unknown key (only "rows")')
    const rows = sprite.rows
    if (!Array.isArray(rows)) {
      errors.add(`${here}/rows`, `must be an array of ${entry.h} strings`)
      continue
    }
    if (rows.length !== entry.h) errors.add(`${here}/rows`, `has ${rows.length} rows, needs exactly ${entry.h}`)
    let clean = rows.length === entry.h
    const allowed = entry.kind === 'character' ? `${[...PALETTE_KEYS].join('')}.SKH` : `${[...PALETTE_KEYS].join('')}.`
    rows.forEach((row, y) => {
      if (typeof row !== 'string') {
        errors.add(`${here}/rows/${y}`, 'must be a string')
        clean = false
        return
      }
      if (row.length !== entry.w) {
        errors.add(`${here}/rows/${y}`, `is ${row.length} characters wide, needs exactly ${entry.w}`)
        clean = false
        return
      }
      for (const char of row) {
        if (!allowed.includes(char)) {
          errors.add(`${here}/rows/${y}`, `has the character "${safeSegment(char)}", which is not allowed here (use ${allowed})`)
          clean = false
          return
        }
      }
    })
    if (clean) out[id] = { rows: rows as string[] }
  }
  return out
}

// --- The JSON Schema ------------------------------------------------------------------------------

/** The JSON Schema (draft 2020-12) of the format, generated from the same constants and the catalogue
 * as the validator, so they cannot drift (a test compares it with the committed file). What a schema
 * cannot say (the palette rules, the byte limit, the character set of a whole grid) is in its
 * description. */
export function assetsManifestSchema(): Record<string, unknown> {
  const colour = { type: 'string', pattern: COLOUR_RE.source }
  const paletteOverride = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(PALETTE_KEYS.map((key) => [key, { $ref: '#/$defs/colour' }])),
  }

  const defs: Record<string, unknown> = { colour, paletteOverride }
  const spriteProperties: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(SPRITE_CATALOGUE)) {
    const def = `sprite_${entry.kind}_${entry.w}x${entry.h}`
    if (!(def in defs)) {
      const chars = entry.kind === 'character' ? `.${PALETTE_KEYS.join('')}SKH` : `.${PALETTE_KEYS.join('')}`
      defs[def] = {
        type: 'object',
        required: ['rows'],
        additionalProperties: false,
        properties: {
          rows: {
            type: 'array',
            minItems: entry.h,
            maxItems: entry.h,
            items: { type: 'string', minLength: entry.w, maxLength: entry.w, pattern: `^[${chars}]+$` },
          },
        },
      }
    }
    spriteProperties[id] = { $ref: `#/$defs/${def}` }
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:cubiclark:assets-manifest:v1',
    title: 'Cubiclark custom assets manifest, version 1',
    description:
      `A pack of palette colours and sprites for the office (docs/assets.md). Not expressible here: the file must be at most ${MAX_MANIFEST_BYTES} bytes; ` +
      'each theme palette, with the pack\'s colours merged over the built-in one, must keep ink readable on paper, the red, amber and green marks apart ' +
      'and the model shirts apart (cubiclark doctor --assets <file> checks this); a manifest with any error is not applied at all.',
    type: 'object',
    required: ['version', 'name'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string', maxLength: 200 },
      version: { const: MANIFEST_VERSION },
      name: { type: 'string', pattern: NAME_RE.source },
      description: { type: 'string', maxLength: MAX_DESCRIPTION_CHARS },
      palettes: {
        type: 'object',
        additionalProperties: false,
        properties: { day: { $ref: '#/$defs/paletteOverride' }, night: { $ref: '#/$defs/paletteOverride' } },
      },
      sprites: { type: 'object', additionalProperties: false, maxProperties: MAX_SPRITES, properties: spriteProperties },
    },
    $defs: defs,
  }
}
