// A pack's sprites replace exactly the sprites they name, keep what a pack must not change, and a
// sprite that does not fit is ignored rather than breaking the office.

import { describe, expect, test } from 'vitest'
import { sunnyOffice } from '../scripts/assets-fixture-lib.js'
import { validateManifest } from '../src/core/assets/manifest.js'
import { ACCESSORIES } from '../src/client/office/art/accessories.js'
import { BUILT_IN_ART, artWithOverrides } from '../src/client/office/art/art-set.js'
import { CHARACTER_FRAMES } from '../src/client/office/art/characters.js'
import { TILES } from '../src/client/office/art/tiles.js'

const grid = (w: number, h: number, char: string): string[] => Array.from({ length: h }, () => char.repeat(w))

describe('artWithOverrides', () => {
  test('no overrides is the built-in art itself', () => {
    expect(artWithOverrides(undefined)).toBe(BUILT_IN_ART)
    expect(artWithOverrides({})).toBe(BUILT_IN_ART)
  })

  test('the example pack replaces the headphones and one floor, and nothing else', () => {
    const manifest = validateManifest(sunnyOffice()).manifest
    const art = artWithOverrides(manifest?.sprites)
    expect(art.accessories.headphones?.sprite.rows).toEqual(manifest?.sprites['accessory:headphones']?.rows)
    expect(art.tiles.floor_carpet_planning.rows).toEqual(manifest?.sprites['tile:floor_carpet_planning']?.rows)
    expect(art.tiles.floor_wood).toBe(TILES.floor_wood)
    expect(art.accessories.tie).toBe(ACCESSORIES.tie)
    expect(art.characters).toEqual(BUILT_IN_ART.characters)
    // the built-in art itself was not touched
    expect(TILES.floor_carpet_planning.rows).not.toEqual(art.tiles.floor_carpet_planning.rows)
  })

  test('an accessory keeps where it hangs; a character keeps its anchors', () => {
    const art = artWithOverrides({
      'accessory:headphones': { rows: grid(14, 7, '0') },
      'character:stand': { rows: grid(16, 24, '3') },
    })
    const built = ACCESSORIES.headphones
    expect(art.accessories.headphones).toMatchObject({ anchor: built.anchor, dx: built.dx, dy: built.dy })
    expect(art.characters.stand?.anchors).toEqual(CHARACTER_FRAMES.stand?.anchors)
    expect(art.characters.stand?.rows).toEqual(grid(16, 24, '3'))
  })

  test('a character may use the shirt, skin and hair placeholders, a tile may not', () => {
    const withPlaceholders = artWithOverrides({ 'character:stand': { rows: grid(16, 24, 'S') }, 'tile:floor_wood': { rows: grid(16, 16, 'S') } })
    expect(withPlaceholders.characters.stand?.rows[0]).toBe('S'.repeat(16))
    expect(withPlaceholders.tiles.floor_wood).toBe(TILES.floor_wood)
  })

  test('a sprite of the wrong size, with a wrong character, or for an unknown id is ignored', () => {
    const art = artWithOverrides({
      'tile:floor_wood': { rows: grid(15, 16, '0') },
      'tile:hall': { rows: grid(16, 16, 'z') },
      'tile:not_a_tile': { rows: grid(16, 16, '0') },
      'character:constructor': { rows: grid(16, 24, '0') },
      'icon:question': { rows: grid(9, 9, '0') },
      'nonsense': { rows: grid(1, 1, '0') },
    })
    expect(art.tiles.floor_wood).toBe(TILES.floor_wood)
    expect(art.tiles.hall).toBe(TILES.hall)
    expect(Object.keys(art.tiles)).toEqual(Object.keys(TILES))
    expect(Object.keys(art.characters)).toEqual(Object.keys(CHARACTER_FRAMES))
  })
})
