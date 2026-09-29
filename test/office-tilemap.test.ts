import { describe, expect, test } from 'vitest'
import { WORLD_FIXTURES, roomsWorld } from '../scripts/world-fixture-lib.js'
import { layout } from '../src/core/office/layout.js'
import { TILE_IDS, buildTileMap, deskObjects } from '../src/core/office/tilemap.js'

const IDS: readonly string[] = TILE_IDS

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

describe('the tile map, on every fixture world', () => {
  for (const [name, build] of Object.entries(WORLD_FIXTURES)) {
    const l = layout(build())
    const map = buildTileMap(l, { quota: true })

    test(`${name}: cols*rows floor tiles, all of them known, all objects known and inside`, () => {
      expect(map.cols).toBe(l.cols)
      expect(map.rows).toBe(l.rows)
      expect(map.floor).toHaveLength(l.cols * l.rows)
      for (const tile of map.floor) expect(IDS).toContain(tile)
      for (const object of map.objects) {
        expect(IDS).toContain(object.tile)
        expect(object.x).toBeGreaterThanOrEqual(0)
        expect(object.y).toBeGreaterThanOrEqual(0)
        expect(object.x).toBeLessThan(map.cols)
        expect(object.y).toBeLessThan(map.rows)
      }
    })

    test(`${name}: a desk, a chair and their tiles for each desk; a stool and a bench tile only where one is used`, () => {
      const count = (tile: string): number => map.objects.filter((o) => o.tile === tile).length
      expect(count('desk_m')).toBe(l.desks.length)
      expect(count('desk_l')).toBe(l.desks.length)
      expect(count('desk_r')).toBe(l.desks.length)
      expect(count('chair')).toBe(l.desks.length)
      expect(count('stool')).toBe(l.placements.filter((p) => p.kind === 'stool').length)
      expect(count('bench')).toBe(l.placements.filter((p) => p.kind === 'bench').length)
    })
  }
})

describe('the fixed parts', () => {
  const l = layout(roomsWorld())
  const map = buildTileMap(l)
  const at = (x: number, y: number): string => must(map.floor[y * map.cols + x], `tile ${x},${y}`)

  test('the hallway is the first two columns down to the lobby, which it runs into, ending in the door', () => {
    const lobbyTop = must(l.rooms.find((r) => r.id === 'lobby'), 'lobby').rect.y
    for (let y = 0; y < lobbyTop; y++) {
      expect(at(0, y)).toBe('hall')
      expect(at(1, y)).toBe('hall')
    }
    for (let y = lobbyTop; y < map.rows - 1; y++) expect(at(0, y)).toBe('floor_lobby')
    expect(at(0, map.rows - 1)).toBe('door_closed')
    expect(at(1, map.rows - 1)).toBe('door_closed')
    expect(at(2, map.rows - 1)).toBe('wall_top')
  })

  test('the door is open only when asked', () => {
    const open = buildTileMap(l, { doorOpen: true })
    expect(open.floor[(open.rows - 1) * open.cols]).toBe('door_open')
    expect(map.floor[(map.rows - 1) * map.cols]).toBe('door_closed')
  })

  test('each room has its own floor', () => {
    const room = (id: string) => must(l.rooms.find((r) => r.id === id), id).rect
    expect(at(room('manager').x + 2, room('manager').y + 4)).toBe('floor_carpet_manager')
    expect(at(room('planning').x + 2, room('planning').y + 4)).toBe('floor_carpet_planning')
    expect(at(room('review').x + 2, room('review').y + 4)).toBe('floor_tile_review')
    expect(at(room('floor').x + 2, room('floor').y + 6)).toBe('floor_wood')
    expect(at(room('lobby').x + 2, room('lobby').y + 1)).toBe('floor_lobby')
  })

  test('the top rooms have a wall and a wall face above their floor', () => {
    expect(at(4, 0)).toBe('wall_top')
    expect(at(4, 1)).toBe('wall_face')
    expect(at(4, 2)).toBe('wall_face')
  })

  test('a desk cell is a chair behind three desk tiles, at the desk rect', () => {
    const desk = must(l.desks[0], 'a desk')
    const found = map.objects.filter((o) => o.y === desk.rect.y + 2 && o.x >= desk.rect.x && o.x < desk.rect.x + 3).map((o) => o.tile)
    expect(found).toEqual(['desk_l', 'desk_m', 'desk_r'])
    expect(map.objects).toContainEqual({ x: desk.rect.x + 1, y: desk.rect.y + 1, tile: 'chair' })
    expect(deskObjects(desk.rect).map((o) => o.tile)).toEqual(['chair', 'desk_l', 'desk_m', 'desk_r'])
  })

  test('a sign tile for every tile of every cluster sign', () => {
    const signs = map.floor.filter((tile) => tile === 'sign').length
    expect(signs).toBe(l.clusters.length * 8)
  })

  test('the whiteboard always hangs in the planning room; the quota meter only with quota data', () => {
    expect(map.objects.filter((o) => o.tile === 'whiteboard_l' || o.tile === 'whiteboard_r')).toHaveLength(2)
    expect(map.objects.some((o) => o.tile === 'meter_frame')).toBe(false)
    expect(buildTileMap(l, { quota: true }).objects.some((o) => o.tile === 'meter_frame')).toBe(true)
  })

  test('the lobby board is a strip of board tiles along the top of the lobby', () => {
    const lobby = must(l.rooms.find((r) => r.id === 'lobby'), 'lobby').rect
    expect(at(5, lobby.y)).toBe('board')
    expect(at(34, lobby.y)).toBe('board')
    expect(at(4, lobby.y)).toBe('floor_lobby')
  })

  test('there are no stool tiles in a world with no helpers', () => {
    const plain = buildTileMap(layout(must(WORLD_FIXTURES['state-thinking'], 'world')()))
    expect(plain.objects.some((o) => o.tile === 'stool' || o.tile === 'bench')).toBe(false)
  })
})
