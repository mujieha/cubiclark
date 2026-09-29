// The sprites the renderer draws characters, accessories and floors from, as one value it is given
// rather than three modules it imports: that is what lets a custom-assets pack replace them
// (docs/assets.md). Icons, board tags, lamps, monitors and the empty-screen props are not in it:
// they tell states apart, so nothing can replace them.

import type { TileId } from '../../../core/office/tilemap.js'
import type { SpriteDef } from '../sprite.js'
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
