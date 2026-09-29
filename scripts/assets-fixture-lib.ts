// The custom-assets fixtures (docs/assets.md): a valid manifest, an invalid one that trips a rule of
// each kind, the example pack in examples/, and the JSON Schema. Written by `npm run fixtures`, checked
// by `npm run fixtures:check`. Nothing here is copied from anywhere: the sprites are drawn in code.

import { assetsManifestSchema } from '../src/core/assets/manifest.js'

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

/** The headphones of the example pack: a band and amber cups, in the built-in accessory's 14x7. */
const SUNNY_HEADPHONES = [
  '.....0000.....',
  '...00....00...',
  '..0........0..',
  '.0b0......0b0.',
  '.0bb0....0bb0.',
  '.0bb0....0bb0.',
  '..00......00..',
]

/** A 16x16 carpet: the planning room's wood colours with an amber diamond every eight pixels. */
function sunnyCarpet(): string[] {
  return Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => ((x + y) % 8 === 0 && x % 2 === 0 ? 'b' : (x * 3 + y * 5) % 7 === 0 ? '7' : '6')).join('')
  )
}

/** The example pack, examples/assets/sunny-office/manifest.json. */
export function sunnyOffice(): Record<string, unknown> {
  return {
    $schema: '../../../schema/assets-manifest.v1.json',
    version: 1,
    name: 'sunny-office',
    description: 'Warmer wood, amber headphones and a patterned planning-room carpet.',
    palettes: {
      day: { '6': '#7a4a2d', '7': '#d9a86c' },
      night: { '6': '#5a3826', '7': '#a0784a' },
    },
    sprites: {
      'accessory:headphones': { rows: SUNNY_HEADPHONES },
      'tile:floor_carpet_planning': { rows: sunnyCarpet() },
    },
  }
}

/** A small valid manifest: one colour and one sprite. */
export function validManifest(): Record<string, unknown> {
  return {
    version: 1,
    name: 'minimal-pack',
    palettes: { day: { '7': '#d9a86c' } },
    sprites: { 'accessory:cap': { rows: ['...000000...', '..0bbbbbb0..', '.0bbbbbbbb0.', '0bbbbbbbbb00'] } },
  }
}

/** A manifest that breaks a rule of every kind, one error each (nine in all). */
export function invalidManifest(): Record<string, unknown> {
  return {
    version: 2,
    name: 'Bad Pack',
    // the amber lamp made the same red as the red one: a and b would look alike
    palettes: { night: { b: '#d8483f' }, dawn: {} },
    sprites: {
      'icon:question': { rows: [] },
      'tile:floor_wood': { rows: ['short'] },
      '<b>bold</b>': { rows: [] },
    },
    extra: true,
  }
}

export function assetsFixtureFiles(): Map<string, string> {
  return new Map([
    ['valid.json', json(validManifest())],
    ['invalid.json', json(invalidManifest())],
  ])
}

export function exampleFiles(): Map<string, string> {
  return new Map([['manifest.json', json(sunnyOffice())]])
}

export function schemaFiles(): Map<string, string> {
  return new Map([['assets-manifest.v1.json', json(assetsManifestSchema())]])
}
