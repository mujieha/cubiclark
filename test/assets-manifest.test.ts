// The custom-assets manifest: every rule of the validator with the path it reports, the limits, hostile
// keys, the JSON Schema pinned to the committed file, and the status lines.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { assetsFixtureFiles, exampleFiles, invalidManifest, schemaFiles, sunnyOffice, validManifest } from '../scripts/assets-fixture-lib.js'
import { SPRITE_CATALOGUE } from '../src/core/assets/catalogue.js'
import { MAX_ERRORS, MAX_SPRITES, assetsManifestSchema, safeSegment, validateManifest } from '../src/core/assets/manifest.js'
import { assetsStatusOf, assetsText } from '../src/core/assets/status.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const errorsOf = (value: unknown): string[] => validateManifest(value).errors.map((error) => `${error.path}: ${error.message}`)
const okBase = (): Record<string, unknown> => ({ version: 1, name: 'pack' })

describe('valid manifests', () => {
  test('the example pack, the small valid fixture and the smallest possible one are accepted', () => {
    for (const value of [sunnyOffice(), validManifest(), okBase()]) {
      const result = validateManifest(value)
      expect(result.errors).toEqual([])
      expect(result.manifest?.version).toBe(1)
    }
    expect(validateManifest(sunnyOffice()).manifest?.palettes.day?.['7']).toBe('#d9a86c')
    expect(Object.keys(validateManifest(sunnyOffice()).manifest?.sprites ?? {})).toEqual(['accessory:headphones', 'tile:floor_carpet_planning'])
  })

  test('the committed files are what the generator writes', async () => {
    for (const [name, text] of assetsFixtureFiles()) expect(await readFile(`${REPO_ROOT}test/fixtures/assets/${name}`, 'utf8')).toBe(text)
    for (const [name, text] of exampleFiles()) expect(await readFile(`${REPO_ROOT}examples/assets/sunny-office/${name}`, 'utf8')).toBe(text)
    for (const [name, text] of schemaFiles()) expect(await readFile(`${REPO_ROOT}schema/${name}`, 'utf8')).toBe(text)
  })
})

describe('the rules, each with its path', () => {
  test('not an object', () => {
    for (const value of [null, [], 'x', 3, undefined, true]) expect(errorsOf(value), String(value)).toEqual([': the manifest must be a JSON object'])
  })

  test('unknown top-level keys, the version and the name', () => {
    expect(errorsOf({ ...okBase(), extra: 1 })).toEqual(['/extra: unknown key (allowed: $schema, version, name, description, palettes, sprites)'])
    expect(errorsOf({ ...okBase(), version: 2 })).toEqual(['/version: must be 1'])
    expect(errorsOf({ name: 'pack' })).toEqual(['/version: must be 1'])
    for (const name of ['Pack', '-pack', '', 'a'.repeat(41), 'has space', 3]) {
      expect(errorsOf({ version: 1, name }), String(name)).toEqual([expect.stringMatching(/^\/name: must be 1 to 40 characters/)])
    }
    expect(errorsOf({ version: 1 })).toHaveLength(1)
    expect(validateManifest({ version: 1, name: 'a'.repeat(40) }).errors).toEqual([])
  })

  test('the description and $schema', () => {
    expect(errorsOf({ ...okBase(), description: 'x'.repeat(201) })).toEqual(['/description: must be a string of at most 200 characters'])
    expect(errorsOf({ ...okBase(), description: 3 })).toHaveLength(1)
    expect(errorsOf({ ...okBase(), $schema: 3 })).toEqual(['/$schema: must be a string of at most 200 characters'])
  })

  test('palettes: shape, theme names, keys and colours', () => {
    expect(errorsOf({ ...okBase(), palettes: [] })).toEqual(['/palettes: must be an object with the keys "day" and "night"'])
    expect(errorsOf({ ...okBase(), palettes: { dusk: {} } })).toEqual(['/palettes/dusk: unknown theme (allowed: day, night)'])
    expect(errorsOf({ ...okBase(), palettes: { day: 3 } })).toEqual(['/palettes/day: must be an object of palette key to #rrggbb colour'])
    expect(errorsOf({ ...okBase(), palettes: { day: { z: '#000000' } } })).toEqual(['/palettes/day/z: not a palette key (0-9 and a-f)'])
    expect(errorsOf({ ...okBase(), palettes: { day: { '7': '#abc' } } })).toEqual(['/palettes/day/7: must be a colour written #rrggbb'])
    expect(errorsOf({ ...okBase(), palettes: { day: { '7': 5 } } })).toEqual(['/palettes/day/7: must be a colour written #rrggbb'])
  })

  test('a palette that would make two states look alike is refused, at its theme, with the rule that failed', () => {
    const errors = errorsOf({ ...okBase(), palettes: { night: { b: '#d8483f' } } })
    expect(errors).toEqual([expect.stringMatching(/^\/palettes\/night: keys a and b are too close \(distance 0, need 80\)/)])
    expect(errorsOf({ ...okBase(), palettes: { day: { '0': '#f2efe6' } } })[0]).toMatch(/^\/palettes\/day: keys 0 and 1 have contrast 1\.0/)
    expect(errorsOf({ ...okBase(), palettes: { day: { e: '#3d7fd9' } } })[0]).toMatch(/keys d and e are too close/)
  })

  test('sprites: shape, id, size and characters', () => {
    expect(errorsOf({ ...okBase(), sprites: [] })).toEqual(['/sprites: must be an object of sprite id to { "rows": [...] }'])
    expect(errorsOf({ ...okBase(), sprites: { 'icon:question': { rows: [] } } })).toEqual([
      '/sprites/icon:question: not a sprite that can be replaced (see docs/assets.md for the ids)',
    ])
    expect(errorsOf({ ...okBase(), sprites: { 'tile:floor_wood': 3 } })).toEqual(['/sprites/tile:floor_wood: must be an object with "rows"'])
    expect(errorsOf({ ...okBase(), sprites: { 'tile:floor_wood': { rows: [], extra: 1 } } })).toContain('/sprites/tile:floor_wood/extra: unknown key (only "rows")')
    expect(errorsOf({ ...okBase(), sprites: { 'tile:floor_wood': { rows: 'x' } } })).toEqual(['/sprites/tile:floor_wood/rows: must be an array of 16 strings'])
    const tooFew = errorsOf({ ...okBase(), sprites: { 'tile:floor_wood': { rows: Array(15).fill('.'.repeat(16)) } } })
    expect(tooFew).toEqual(['/sprites/tile:floor_wood/rows: has 15 rows, needs exactly 16'])

    const tile = (row3: unknown): unknown => ({ ...okBase(), sprites: { 'tile:floor_wood': { rows: Array.from({ length: 16 }, (_, y) => (y === 3 ? row3 : '.'.repeat(16))) } } })
    expect(errorsOf(tile('.'.repeat(15)))).toEqual(['/sprites/tile:floor_wood/rows/3: is 15 characters wide, needs exactly 16'])
    expect(errorsOf(tile(5))).toEqual(['/sprites/tile:floor_wood/rows/3: must be a string'])
    expect(errorsOf(tile('.'.repeat(15) + 'z'))[0]).toMatch(/^\/sprites\/tile:floor_wood\/rows\/3: has the character "z", which is not allowed here/)
    // S, K and H are placeholders that only a character may use
    expect(errorsOf(tile('.'.repeat(15) + 'S'))[0]).toMatch(/has the character "S"/)
    const frame = { ...okBase(), sprites: { 'character:stand': { rows: Array.from({ length: 24 }, (_, y) => (y === 0 ? '.'.repeat(13) + 'SKH' : '.'.repeat(16))) } } }
    expect(errorsOf(frame)).toEqual([])
  })

  test('at most MAX_SPRITES sprites', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_SPRITES + 1 }, (_, i) => [`x${i}`, { rows: [] }]))
    expect(errorsOf({ ...okBase(), sprites: many })[0]).toBe(`/sprites: has ${MAX_SPRITES + 1} sprites, at most ${MAX_SPRITES}`)
  })

  test('the invalid fixture reports each of its nine problems once, in order', () => {
    expect(errorsOf(invalidManifest())).toEqual([
      '/extra: unknown key (allowed: $schema, version, name, description, palettes, sprites)',
      '/version: must be 1',
      '/name: must be 1 to 40 characters: lower-case letters, digits and "-", not starting with "-"',
      '/palettes/dawn: unknown theme (allowed: day, night)',
      expect.stringMatching(/^\/palettes\/night: keys a and b are too close/),
      '/sprites/icon:question: not a sprite that can be replaced (see docs/assets.md for the ids)',
      '/sprites/tile:floor_wood/rows: has 1 rows, needs exactly 16',
      '/sprites/tile:floor_wood/rows/0: is 5 characters wide, needs exactly 16',
      '/sprites/<b>bold</b>: not a sprite that can be replaced (see docs/assets.md for the ids)',
    ])
  })
})

describe('hostile input', () => {
  test('more than MAX_ERRORS errors are cut, with one line saying how many more', () => {
    const rows = Array.from({ length: 16 }, () => 'z'.repeat(16))
    const result = validateManifest({ ...okBase(), sprites: { 'tile:floor_wood': { rows }, 'tile:floor_lobby': { rows }, 'tile:hall': { rows }, 'tile:chair': { rows } } })
    expect(result.errors).toHaveLength(MAX_ERRORS + 1)
    expect(result.errors.at(-1)).toEqual({ path: '', message: `…and ${4 * 16 - MAX_ERRORS} more errors not shown` })
    expect(result.manifest).toBeUndefined()
  })

  test('a key with control characters or 500 characters is printed safely', () => {
    const errors = errorsOf({ ...okBase(), sprites: { [`<script>\u0007\u001b[2J${'k'.repeat(500)}`]: { rows: [] } } })
    expect(errors).toHaveLength(1)
    // eslint-disable-next-line no-control-regex
    expect(errors[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(errors[0]?.length).toBeLessThan(160)
    expect(safeSegment('a\u0000b')).toBe('ab')
    expect(safeSegment('x'.repeat(41))).toBe(`${'x'.repeat(39)}…`)
  })

  test('__proto__, constructor and very deep nesting neither throw nor pass', () => {
    const proto = JSON.parse('{"version":1,"name":"pack","__proto__":{"x":1},"sprites":{"__proto__":{"rows":[]},"constructor":{"rows":[]}}}') as unknown
    const errors = errorsOf(proto)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.startsWith('/__proto__:'))).toBe(true)
    expect(errors.some((e) => e.startsWith('/sprites/constructor:'))).toBe(true)
    let deep: unknown = 'x'
    for (let i = 0; i < 5000; i++) deep = { a: deep }
    expect(() => validateManifest(deep)).not.toThrow()
    expect(validateManifest(deep).manifest).toBeUndefined()
  })
})

describe('the JSON Schema', () => {
  test('is a function of the format: it equals the committed file, and lists exactly the catalogue', async () => {
    const committed = JSON.parse(await readFile(`${REPO_ROOT}schema/assets-manifest.v1.json`, 'utf8')) as Record<string, unknown>
    expect(committed).toEqual(assetsManifestSchema())
    const properties = (assetsManifestSchema().properties as Record<string, { properties: Record<string, unknown> }>).sprites?.properties
    expect(Object.keys(properties ?? {}).sort()).toEqual(Object.keys(SPRITE_CATALOGUE).sort())
  })

  test('has an id, a version const and exact sizes for a character and a tile', () => {
    const schema = assetsManifestSchema() as { $id: string; properties: { version: { const: number } }; $defs: Record<string, { properties: { rows: { minItems: number; maxItems: number; items: { minLength: number; pattern: string } } } }> }
    expect(schema.$id).toBe('urn:cubiclark:assets-manifest:v1')
    expect(schema.properties.version.const).toBe(1)
    const character = schema.$defs.sprite_character_16x24?.properties.rows
    expect([character?.minItems, character?.maxItems, character?.items.minLength]).toEqual([24, 24, 16])
    expect(character?.items.pattern).toContain('SKH')
    expect(schema.$defs.sprite_tile_16x16?.properties.rows.items.pattern).not.toContain('SKH')
  })
})

describe('the status', () => {
  test('none, ok and invalid', () => {
    const none = assetsStatusOf(undefined, undefined)
    expect(none).toEqual({ status: 'none', palettes: [], sprites: 0, errors: [], errorCount: 0 })
    expect(assetsText(none)).toBe('none')

    const ok = assetsStatusOf(validateManifest(sunnyOffice()), '/some/where/sunny-office/manifest.json')
    expect(ok).toMatchObject({ status: 'ok', file: 'manifest.json', name: 'sunny-office', palettes: ['day', 'night'], sprites: 2, errorCount: 0 })
    expect(JSON.stringify(ok)).not.toContain('/some/where')
    expect(assetsText(ok)).toBe('ok — sunny-office: 2 palettes, 2 sprites')
    expect(assetsText(assetsStatusOf(validateManifest({ version: 1, name: 'one', palettes: { day: { '7': '#d9a86c' } }, sprites: { 'accessory:cap': validManifest().sprites && (validManifest().sprites as Record<string, unknown>)['accessory:cap'] } }), undefined))).toBe('ok — one: 1 palette, 1 sprite')

    const bad = assetsStatusOf(validateManifest(invalidManifest()), 'C:\\packs\\bad.json')
    expect(bad).toMatchObject({ status: 'invalid', file: 'bad.json', errorCount: 9 })
    expect(bad.errors).toHaveLength(9)
    expect(assetsText(bad)).toBe('invalid — 9 errors')
  })

  test('at most ten errors are listed, each at most 200 characters, and the count is the whole', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`nope${i}`, { rows: [] }]))
    const status = assetsStatusOf(validateManifest({ ...okBase(), sprites: many }), 'm.json')
    expect(status.errors).toHaveLength(10)
    expect(status.errorCount).toBe(30)
    expect(status.errors.every((error) => error.length <= 200)).toBe(true)
    expect(assetsText(assetsStatusOf(validateManifest({ version: 3, name: 'pack' }), undefined))).toBe('invalid — 1 error')
  })
})
