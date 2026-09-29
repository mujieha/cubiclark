// Every sprite a custom-assets manifest may replace, by id, with the size it must have (docs/assets.md).
// Pure data; test/assets-catalogue.test.ts checks it against the art itself, so a new frame,
// accessory or tile cannot be added without deciding here whether a pack may replace it.
//
// Not in the catalogue on purpose: the bubble icons, the lobby-board tags, the lamps and monitors
// and the empty-screen props. They are how two different states are told apart (design §3.1), so a
// pack cannot make two of them look alike.

export type SpriteKind = 'character' | 'accessory' | 'tile'

export interface CatalogueEntry {
  kind: SpriteKind
  w: number
  h: number
}

/** The names of the character frames (`character:<name>`), each 16x24. */
export const CHARACTER_FRAME_NAMES = [
  'sit_idle_a',
  'sit_idle_b',
  'sit_type_a',
  'sit_type_b',
  'sit_lean_fwd_a',
  'sit_lean_fwd_b',
  'sit_lean_back',
  'sit_side',
  'sit_shuffle_a',
  'sit_shuffle_b',
  'sit_sleep',
  'sit_slump',
  'stand',
  'stand_wave_a',
  'stand_wave_b',
  'walk_down_a',
  'walk_down_b',
  'walk_up_a',
  'walk_up_b',
  'walk_side_a',
  'walk_side_b',
] as const

/** The accessories (`accessory:<name>`) and their sizes in px. */
export const ACCESSORY_SIZES = {
  tie: [4, 6],
  clipboard: [6, 7],
  magnifier: [7, 7],
  headphones: [14, 7],
  cap: [12, 4],
} as const

/** The floors, walls and furniture (`tile:<id>`), each 16x16. */
export const TILE_NAMES = [
  'floor_wood',
  'floor_carpet_manager',
  'floor_carpet_planning',
  'floor_tile_review',
  'floor_lobby',
  'hall',
  'partition',
  'wall_top',
  'wall_face',
  'door_closed',
  'door_open',
  'desk_l',
  'desk_m',
  'desk_r',
  'chair',
  'stool',
  'bench',
  'sign',
  'whiteboard_l',
  'whiteboard_r',
  'meter_frame',
  'plant',
  'board',
] as const

function build(): Record<string, CatalogueEntry> {
  const entries: [string, CatalogueEntry][] = []
  for (const name of CHARACTER_FRAME_NAMES) entries.push([`character:${name}`, { kind: 'character', w: 16, h: 24 }])
  for (const [name, [w, h]] of Object.entries(ACCESSORY_SIZES)) entries.push([`accessory:${name}`, { kind: 'accessory', w, h }])
  for (const name of TILE_NAMES) entries.push([`tile:${name}`, { kind: 'tile', w: 16, h: 16 }])
  return Object.fromEntries(entries)
}

export const SPRITE_CATALOGUE: Readonly<Record<string, CatalogueEntry>> = build()
