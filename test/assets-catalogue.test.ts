// The catalogue of replaceable sprites is checked against the art itself: a frame, accessory or tile
// cannot be added or resized without deciding here whether a pack may replace it, and nothing that
// tells two states apart is in it.

import { describe, expect, test } from 'vitest'
import { SPRITE_CATALOGUE } from '../src/core/assets/catalogue.js'
import { ACCESSORIES } from '../src/client/office/art/accessories.js'
import { CHARACTER_FRAMES } from '../src/client/office/art/characters.js'
import { ICONS, TAGS } from '../src/client/office/art/icons.js'
import { PROPS, TILES } from '../src/client/office/art/tiles.js'

describe('SPRITE_CATALOGUE', () => {
  test('every character frame is in it, 16x24, and nothing else is called a character', () => {
    for (const [name, def] of Object.entries(CHARACTER_FRAMES)) {
      expect(SPRITE_CATALOGUE[`character:${name}`], name).toEqual({ kind: 'character', w: def.w, h: def.h })
    }
    const listed = Object.keys(SPRITE_CATALOGUE).filter((id) => id.startsWith('character:'))
    expect(listed.sort()).toEqual(Object.keys(CHARACTER_FRAMES).map((name) => `character:${name}`).sort())
  })

  test('every accessory is in it at its own size', () => {
    for (const [name, art] of Object.entries(ACCESSORIES)) {
      expect(SPRITE_CATALOGUE[`accessory:${name}`], name).toEqual({ kind: 'accessory', w: art.sprite.w, h: art.sprite.h })
    }
    expect(Object.keys(SPRITE_CATALOGUE).filter((id) => id.startsWith('accessory:'))).toHaveLength(Object.keys(ACCESSORIES).length)
  })

  test('every tile is in it, and only tiles', () => {
    for (const [name, def] of Object.entries(TILES)) {
      expect(SPRITE_CATALOGUE[`tile:${name}`], name).toEqual({ kind: 'tile', w: def.w, h: def.h })
    }
    expect(Object.keys(SPRITE_CATALOGUE).filter((id) => id.startsWith('tile:'))).toHaveLength(Object.keys(TILES).length)
  })

  test('nothing that tells states apart is in it: no icon, tag, monitor, lamp or prop', () => {
    const ids = Object.keys(SPRITE_CATALOGUE)
    expect(ids.every((id) => /^(character|accessory|tile):/.test(id))).toBe(true)
    for (const name of [...Object.keys(ICONS), ...Object.keys(TAGS), ...Object.keys(PROPS)]) {
      for (const prefix of ['icon', 'tag', 'prop', 'character', 'accessory', 'tile']) {
        // a tile may share a name with a prop only by coincidence: what matters is the id's kind
        if (prefix === 'icon' || prefix === 'tag' || prefix === 'prop') expect(ids, `${prefix}:${name}`).not.toContain(`${prefix}:${name}`)
      }
    }
  })
})
