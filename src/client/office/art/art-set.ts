// The sprites the renderer draws characters, accessories and floors from, as one value it is given
// rather than three modules it imports: that is what lets a custom-assets pack replace them
// (docs/assets.md). Icons, board tags, lamps, monitors and the empty-screen props are not in it:
// they tell states apart, so nothing can replace them.

import type { TileId } from '../../../core/office/tilemap.js'
import { validateSprite, type SpriteDef } from '../sprite.js'
import { ACCESSORIES, type AccessoryArt } from './accessories.js'
import { CHARACTER_FRAMES } from './characters.js'
import { TILES } from './tiles.js'

export interface ArtSet {
  /** Character frames by name (`sit_type_a`, ...), each 16x24 with its `head` and `chest` anchors. */
  characters: Readonly<Record<string, SpriteDef>>
  /** Role accessories by name (`tie`, `clipboard`, ...), each with the anchor it hangs from. */
  accessories: Readonly<Record<string, AccessoryArt>>
  /** Floors, walls and furniture by tile id, each 16x16. */
  tiles: Readonly<Record<TileId, SpriteDef>>
}

export const BUILT_IN_ART: ArtSet = {
  characters: CHARACTER_FRAMES,
  accessories: ACCESSORIES,
  tiles: TILES,
}

type Overrides = Readonly<Record<string, { rows: readonly string[] }>>

function spriteOf(rows: readonly string[], anchors: SpriteDef['anchors']): SpriteDef {
  return { w: rows[0]?.length ?? 0, h: rows.length, rows, ...(anchors ? { anchors } : {}) }
}

/** The built-in art with a pack's sprites on top (docs/assets.md). The server has already checked
 * every sprite against the catalogue; this checks the shape once more and ignores any that does
 * not fit, so a bad entry can never break the office. A character keeps its built-in anchors and an
 * accessory keeps where it hangs, so a pack only ever changes pixels. */
export function artWithOverrides(overrides: Overrides | undefined): ArtSet {
  if (!overrides || Object.keys(overrides).length === 0) return BUILT_IN_ART
  const characters: Record<string, SpriteDef> = { ...BUILT_IN_ART.characters }
  const accessories: Record<string, AccessoryArt> = { ...BUILT_IN_ART.accessories }
  const tiles: Record<string, SpriteDef> = { ...BUILT_IN_ART.tiles }

  for (const [id, sprite] of Object.entries(overrides)) {
    const at = id.indexOf(':')
    const kind = id.slice(0, at)
    const name = id.slice(at + 1)
    if (kind === 'character' && Object.hasOwn(characters, name)) {
      const built = characters[name] as SpriteDef
      const def = spriteOf(sprite.rows, built.anchors)
      if (def.w === built.w && def.h === built.h && validateSprite(def, id).length === 0) characters[name] = def
    } else if (kind === 'accessory' && Object.hasOwn(accessories, name)) {
      const built = accessories[name] as AccessoryArt
      const def = spriteOf(sprite.rows, undefined)
      if (def.w === built.sprite.w && def.h === built.sprite.h && validateSprite(def, id, false).length === 0) accessories[name] = { ...built, sprite: def }
    } else if (kind === 'tile' && Object.hasOwn(tiles, name)) {
      const built = tiles[name] as SpriteDef
      const def = spriteOf(sprite.rows, undefined)
      if (def.w === built.w && def.h === built.h && validateSprite(def, id, false).length === 0) tiles[name] = def
    }
  }
  return { characters, accessories, tiles: tiles as ArtSet['tiles'] }
}
