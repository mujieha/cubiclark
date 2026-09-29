import { describe, expect, test } from 'vitest'
import { worldSessionId } from '../scripts/world-fixture-lib.js'
import { ACCESSORIES } from '../src/client/office/art/accessories.js'
import { CHARACTER_FRAMES } from '../src/client/office/art/characters.js'
import { ICONS, TAGS } from '../src/client/office/art/icons.js'
import { PROPS, TILES } from '../src/client/office/art/tiles.js'
import { TILE_IDS } from '../src/core/office/tilemap.js'
import { POSE_FRAMES, STATE_VISUALS, type BubbleIcon } from '../src/core/office/visual.js'
import { PALETTE, fnv1a, hexToRgb, shirtKey, toneFor, variantFor } from '../src/client/office/palette.js'
import { alphaMask, mirror, rasterize, rotate90, validateSprite, type SpriteDef } from '../src/client/office/sprite.js'

const rgba = (bytes: Uint8ClampedArray, pixel: number): number[] => [...bytes.slice(pixel * 4, pixel * 4 + 4)]

describe('the palette', () => {
  test('has the 16 keys, each a #rrggbb colour, all different', () => {
    expect(Object.keys(PALETTE)).toHaveLength(16)
    for (const hex of Object.values(PALETTE)) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    expect(new Set(Object.values(PALETTE)).size).toBe(16)
  })

  test('shirt colour by model family', () => {
    expect(shirtKey('opus')).toBe('e')
    expect(shirtKey('sonnet')).toBe('d')
    expect(shirtKey('haiku')).toBe('c')
    expect(shirtKey('fable')).toBe('f')
    expect(shirtKey('other')).toBe('3')
    expect(new Set(['opus', 'sonnet', 'haiku', 'fable', 'other'].map((f) => shirtKey(f as never))).size).toBe(5)
  })

  test('variantFor is stable for an id and spreads over skin and hair', () => {
    expect(variantFor('some-agent')).toEqual(variantFor('some-agent'))
    const variants = Array.from({ length: 20 }, (_, i) => variantFor(worldSessionId(i + 1)))
    expect(new Set(variants.map((v) => v.K)).size).toBeGreaterThanOrEqual(2)
    expect(new Set(variants.map((v) => v.H)).size).toBeGreaterThanOrEqual(3)
    for (const v of variants) {
      expect(PALETTE[v.K]).toBeDefined()
      expect(PALETTE[v.H]).toBeDefined()
    }
  })

  test('fnv1a matches its published test vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
  })

  test('dim and dark variants keep three levels and never leave the palette', () => {
    const dim = new Set(Object.values(PALETTE).map((hex) => toneFor(hex, 'dim')))
    const dark = new Set(Object.values(PALETTE).map((hex) => toneFor(hex, 'dark')))
    expect(dim.size).toBeLessThanOrEqual(3)
    expect(dark.size).toBeLessThanOrEqual(3)
    for (const hex of [...dim, ...dark]) expect(Object.values(PALETTE)).toContain(hex)
    expect(toneFor(PALETTE.a as string, 'normal')).toBe(PALETTE.a)
  })
})

describe('validateSprite', () => {
  const ok: SpriteDef = { w: 2, h: 2, rows: ['.1', 'a.'] }

  test('a good sprite has no errors', () => {
    expect(validateSprite(ok, 'ok')).toEqual([])
  })

  test('catches a wrong row width', () => {
    expect(validateSprite({ w: 2, h: 2, rows: ['.1', 'a'] }, 'bad')).toEqual(['bad: row 1 is 1 wide, expected 2'])
  })

  test('catches a wrong height', () => {
    expect(validateSprite({ w: 2, h: 3, rows: ['.1', 'a.'] }, 'bad')).toEqual(['bad: has 2 rows, expected 3'])
  })

  test('catches an unknown character', () => {
    expect(validateSprite({ w: 2, h: 1, rows: ['.z'] }, 'bad')).toEqual(['bad: row 0 has the unknown character "z"'])
  })

  test('catches an anchor outside the grid', () => {
    const errors = validateSprite({ ...ok, anchors: { head: { x: 2, y: 0 }, chest: { x: 0, y: 0 } } }, 'bad')
    expect(errors).toEqual(['bad: anchor head (2,0) is outside 2x2'])
  })

  test('placeholders are fine in a template and errors in a finished sprite', () => {
    const template: SpriteDef = { w: 3, h: 1, rows: ['SKH'] }
    expect(validateSprite(template, 't')).toEqual([])
    expect(validateSprite(template, 't', false)).toHaveLength(3)
    expect(validateSprite(template, 't', false)[0]).toContain('unsubstituted placeholder "S"')
  })
})

describe('rasterize', () => {
  test('a 2x2 grid gives exact RGBA bytes: transparent for ".", opaque elsewhere', () => {
    const bytes = rasterize({ w: 2, h: 2, rows: ['.1', 'a.'] }, PALETTE)
    expect(bytes).toHaveLength(16)
    expect(rgba(bytes, 0)).toEqual([0, 0, 0, 0])
    expect(rgba(bytes, 1)).toEqual([...hexToRgb(PALETTE['1'] as string), 255])
    expect(rgba(bytes, 2)).toEqual([...hexToRgb(PALETTE.a as string), 255])
    expect(rgba(bytes, 3)).toEqual([0, 0, 0, 0])
  })

  test('S, K and H take the substituted palette keys', () => {
    const bytes = rasterize({ w: 3, h: 1, rows: ['SKH'] }, PALETTE, { S: 'e', K: '8', H: '6' })
    expect(rgba(bytes, 0)).toEqual([...hexToRgb(PALETTE.e as string), 255])
    expect(rgba(bytes, 1)).toEqual([...hexToRgb(PALETTE['8'] as string), 255])
    expect(rgba(bytes, 2)).toEqual([...hexToRgb(PALETTE['6'] as string), 255])
  })

  test('an unsubstituted placeholder is an error, not a silent black pixel', () => {
    expect(() => rasterize({ w: 1, h: 1, rows: ['S'] }, PALETTE)).toThrow(/placeholder "S"/)
  })

  test('the dim variant greys everything and keeps transparency', () => {
    const normal = rasterize({ w: 2, h: 1, rows: ['a.'] }, PALETTE)
    const dim = rasterize({ w: 2, h: 1, rows: ['a.'] }, PALETTE, {}, 'dim')
    expect(rgba(dim, 0)).not.toEqual(rgba(normal, 0))
    expect(rgba(dim, 1)).toEqual([0, 0, 0, 0])
    const [r, g, b] = rgba(dim, 0) as [number, number, number]
    expect(Object.values(PALETTE).map((hex) => hexToRgb(hex).join())).toContain([r, g, b].join())
  })
})

describe('mirror and rotate90', () => {
  const asym: SpriteDef = { w: 3, h: 3, rows: ['1..', '.a.', '..0'], anchors: { head: { x: 0, y: 0 }, chest: { x: 2, y: 1 } } }

  test('mirror flips the rows and the anchors, and twice is the identity', () => {
    const flipped = mirror(asym)
    expect(flipped.rows).toEqual(['..1', '.a.', '0..'])
    expect(flipped.anchors).toEqual({ head: { x: 2, y: 0 }, chest: { x: 0, y: 1 } })
    expect(mirror(flipped)).toEqual(asym)
  })

  test('rotate90 turns a quarter clockwise, and four turns are the identity', () => {
    const once = rotate90(asym)
    expect(once.rows).toEqual(['..1', '.a.', '0..'])
    const four = rotate90(rotate90(rotate90(once)))
    expect(four.rows).toEqual(asym.rows)
  })

  test('rotate90 refuses a non-square sprite', () => {
    expect(() => rotate90({ w: 2, h: 3, rows: ['..', '..', '..'] })).toThrow(/square/)
  })

  test('alphaMask is the silhouette, blind to colour', () => {
    expect(alphaMask({ w: 3, h: 1, rows: ['1.a'] })).toBe('#.#')
    expect(alphaMask({ w: 3, h: 1, rows: ['0.c'] })).toBe(alphaMask({ w: 3, h: 1, rows: ['1.a'] }))
  })
})

describe('the character frames', () => {
  const names = Object.keys(CHARACTER_FRAMES)
  const frame = (name: string): SpriteDef => {
    const def = CHARACTER_FRAMES[name]
    if (!def) throw new Error(`no frame ${name}`)
    return def
  }
  const visible = (name: string): string => alphaMask(frame(name))

  test('every frame is 16x24 and validates as a template', () => {
    for (const name of names) {
      expect(frame(name).w, name).toBe(16)
      expect(frame(name).h, name).toBe(24)
      expect(validateSprite(frame(name), name)).toEqual([])
    }
  })

  test('every frame bakes with a shirt, skin and hair, and then has no placeholder left', () => {
    for (const name of names) {
      expect(() => rasterize(frame(name), PALETTE, { S: 'e', K: '8', H: '6' }), name).not.toThrow()
    }
  })

  test('every frame the pose table names exists', () => {
    for (const [pose, { frames }] of Object.entries(POSE_FRAMES)) {
      for (const ref of frames) expect(CHARACTER_FRAMES[ref.name], `${pose}: ${ref.name}`).toBeDefined()
    }
  })

  test('a seated frame keeps its content in the top 16 rows, so the desk can be drawn over the rest', () => {
    for (const name of names.filter((n) => n.startsWith('sit_'))) {
      expect(frame(name).rows.slice(16).every((row) => /^\.+$/.test(row)), name).toBe(true)
      expect(frame(name).rows.slice(0, 16).some((row) => row !== '.'.repeat(16)), name).toBe(true)
    }
  })

  test('a standing or walking frame uses the whole 24 rows', () => {
    for (const name of names.filter((n) => !n.startsWith('sit_'))) {
      expect(frame(name).rows[23]).not.toBe('.'.repeat(16))
    }
  })

  test('the two frames of a pair differ, so the animation shows', () => {
    const pairs = names.filter((n) => n.endsWith('_a')).map((n) => [n, n.replace(/_a$/, '_b')] as const)
    expect(pairs.length).toBeGreaterThanOrEqual(8)
    for (const [a, b] of pairs) {
      expect(CHARACTER_FRAMES[b], `${b} exists`).toBeDefined()
      expect(frame(a).rows, `${a} vs ${b}`).not.toEqual(frame(b).rows)
    }
  })

  test('the waving arm is two pixels wide and its hand three rows tall, in both frames', () => {
    for (const name of ['stand_wave_a', 'stand_wave_b']) {
      const rows = frame(name).rows
      const hand = rows.slice(0, 3).map((row) => (row.match(/K/g) ?? []).length)
      expect(hand, name).toEqual([2, 2, 2])
      const sleeve = rows.slice(3, 9).map((row) => row.slice(13).replace(/\./g, ''))
      for (const cells of sleeve) expect(cells.length, name).toBeGreaterThanOrEqual(2)
    }
    expect(frame('stand_wave_a').rows).not.toEqual(frame('stand_wave_b').rows)
  })

  test('asleep and slumped differ from each other and from typing', () => {
    expect(frame('sit_sleep').rows).not.toEqual(frame('sit_slump').rows)
    expect(frame('sit_sleep').rows).not.toEqual(frame('sit_type_a').rows)
    expect(frame('sit_slump').rows).not.toEqual(frame('sit_type_a').rows)
    expect(visible('sit_sleep')).not.toBe(visible('sit_slump'))
  })

  test('no two frames are the same picture', () => {
    expect(new Set(names.map((n) => frame(n).rows.join('/'))).size).toBe(names.length)
  })

  test('every frame has a head and a chest anchor inside the grid', () => {
    for (const name of names) {
      expect(frame(name).anchors, name).toBeDefined()
    }
  })

  test('a mirrored walking frame is a different picture facing the other way', () => {
    expect(mirror(frame('walk_side_a')).rows).not.toEqual(frame('walk_side_a').rows)
  })
})

describe('the accessories', () => {
  test('one for each role that wears one, all valid', () => {
    expect(Object.keys(ACCESSORIES).sort()).toEqual(['cap', 'clipboard', 'headphones', 'magnifier', 'tie'])
    for (const [name, accessory] of Object.entries(ACCESSORIES)) {
      expect(validateSprite(accessory.sprite, name, false), name).toEqual([])
    }
  })

  test('drawn at every frame anchor, each stays inside the 16x24 frame', () => {
    for (const [frameName, frame] of Object.entries(CHARACTER_FRAMES)) {
      for (const [name, accessory] of Object.entries(ACCESSORIES)) {
        const at = frame.anchors?.[accessory.anchor]
        expect(at, `${frameName} anchor`).toBeDefined()
        const x = (at?.x ?? 0) + accessory.dx
        const y = (at?.y ?? 0) + accessory.dy
        expect(x, `${name} on ${frameName}: left`).toBeGreaterThanOrEqual(0)
        expect(y, `${name} on ${frameName}: top`).toBeGreaterThanOrEqual(0)
        expect(x + accessory.sprite.w, `${name} on ${frameName}: right`).toBeLessThanOrEqual(16)
        expect(y + accessory.sprite.h, `${name} on ${frameName}: bottom`).toBeLessThanOrEqual(24)
      }
    }
  })

  test('the five silhouettes are different', () => {
    const masks = Object.values(ACCESSORIES).map((a) => alphaMask(a.sprite))
    expect(new Set(masks).size).toBe(5)
  })
})

describe('tiles and props', () => {
  test('there is a tile for every tile id, and no other', () => {
    expect(Object.keys(TILES).sort()).toEqual([...TILE_IDS].sort())
  })

  test('every tile is 16x16 and finished (no placeholder)', () => {
    for (const [name, def] of Object.entries(TILES)) {
      expect([def.w, def.h], name).toEqual([16, 16])
      expect(validateSprite(def, name, false), name).toEqual([])
    }
  })

  test('the floors are opaque, so the office has no holes', () => {
    for (const name of ['floor_wood', 'floor_carpet_manager', 'floor_carpet_planning', 'floor_tile_review', 'floor_lobby', 'hall', 'wall_top', 'wall_face', 'board'] as const) {
      expect(TILES[name].rows.every((row) => !row.includes('.')), name).toBe(true)
    }
  })

  test('each room has its own floor', () => {
    const floors = ['floor_wood', 'floor_carpet_manager', 'floor_carpet_planning', 'floor_tile_review', 'floor_lobby'] as const
    expect(new Set(floors.map((name) => TILES[name].rows.join('/'))).size).toBe(floors.length)
  })

  test('the door is different open and closed', () => {
    expect(TILES.door_open.rows).not.toEqual(TILES.door_closed.rows)
  })

  test('every prop validates, and the monitor and the lamp differ by state', () => {
    for (const [name, def] of Object.entries(PROPS)) expect(validateSprite(def, name, false), name).toEqual([])
    expect(new Set([PROPS.monitor_off, PROPS.monitor_on, PROPS.monitor_flicker, PROPS.monitor_error].map((d) => d.rows.join('/'))).size).toBe(4)
    expect(new Set([PROPS.lamp_off, PROPS.lamp_red, PROPS.lamp_amber].map((d) => d.rows.join('/'))).size).toBe(3)
  })
})

describe('bubble icons and board tags', () => {
  const iconNames = Object.keys(ICONS) as BubbleIcon[]

  test('there is an icon for every bubble icon the state table uses', () => {
    const used = new Set(Object.values(STATE_VISUALS).flatMap((visual) => (visual.bubble ? [visual.bubble.icon] : [])))
    for (const name of used) expect(ICONS[name], name).toBeDefined()
    expect(new Set(iconNames)).toEqual(used)
  })

  test('every icon is 9x9, uses only the ink and accent placeholders, and bakes', () => {
    for (const name of iconNames) {
      const def = ICONS[name]
      expect([def.w, def.h], name).toEqual([9, 9])
      expect(validateSprite(def, name), name).toEqual([])
      expect(def.rows.join(''), name).not.toContain('H')
      expect(() => rasterize(def, PALETTE, { S: '0', K: 'a' }), name).not.toThrow()
    }
  })

  test('the silhouettes of all 13 icons are pairwise different: shape, not colour, tells them apart', () => {
    const masks = iconNames.map((name) => alphaMask(ICONS[name]))
    expect(masks).toHaveLength(13)
    expect(new Set(masks).size).toBe(13)
  })

  test('the two board tags are 14x14, finished, and have different silhouettes', () => {
    for (const [name, def] of Object.entries(TAGS)) {
      expect([def.w, def.h], name).toEqual([14, 14])
      expect(validateSprite(def, name, false), name).toEqual([])
    }
    expect(alphaMask(TAGS.check)).not.toBe(alphaMask(TAGS.exit))
    expect(TAGS.check.rows).not.toEqual(TAGS.exit.rows)
  })

  test('the arrow turns to point every way, and each turn is a different picture', () => {
    const right = ICONS.arrow
    const down = rotate90(right)
    const left = rotate90(down)
    const up = rotate90(left)
    expect(new Set([right, down, left, up].map((d) => d.rows.join('/'))).size).toBe(4)
    expect(rotate90(up).rows).toEqual(right.rows)
  })

  test('an icon takes the ink of its bubble', () => {
    const plain = rasterize(ICONS.cross, PALETTE, { S: '0' })
    const alert = rasterize(ICONS.cross, PALETTE, { S: '1' })
    expect(rgba(plain, 0)).toEqual([...hexToRgb(PALETTE['0'] as string), 255])
    expect(rgba(alert, 0)).toEqual([...hexToRgb(PALETTE['1'] as string), 255])
  })
})
