// Where Morty may be: the grid, his spots, and the path finder. The test the acceptance asks for is
// "never covers": in every fixture world, no tile he may stand on touches a bubble, a lamp, a monitor
// or a board tag.

import { describe, expect, test } from 'vitest'
import { allStatesWorld, crowd100World, crowdWorld, mascotPlayWorld, roomsWorld, stateWorld } from '../scripts/world-fixture-lib.js'
import { BUBBLE_H, COMPACT_W, DESK_BUBBLE_MAX_W, placeBubbles } from '../src/core/office/bubbles.js'
import { rectsOverlap, type Rect } from '../src/core/office/geometry.js'
import { layout as computeLayout, type OfficeLayout } from '../src/core/office/layout.js'
import {
  bubbleObstacles,
  cornerPoints,
  findPath,
  isWalkable,
  mascotGrid,
  mascotSpots,
  reachableTiles,
  roomOf,
  spotNearCell,
  staticObstacles,
  tileCentre,
  tileOf,
  tileRect,
  type MascotGrid,
  type Tile,
} from '../src/core/office/mascot-map.js'
import { buildTileMap, deskObjects, deskPropRects } from '../src/core/office/tilemap.js'
import { STATE_VISUALS } from '../src/core/office/visual.js'
import { AGENT_STATES, type World } from '../src/core/types.js'

interface Built {
  world: World
  layout: OfficeLayout
  grid: MascotGrid
}

function build(world: World): Built {
  const layout = computeLayout(world)
  const tilemap = buildTileMap(layout, { quota: world.quota !== undefined })
  return { world, layout, grid: mascotGrid(world, layout, tilemap) }
}

const WORLDS: [string, () => World][] = [
  ['rooms', roomsWorld],
  ['all-states', allStatesWorld],
  ['crowd-50', crowdWorld],
  ['crowd-100', crowd100World],
  ['mascot-play', mascotPlayWorld],
  ...AGENT_STATES.map((state): [string, () => World] => [`state-${state}`, () => stateWorld(state)]),
]

const HALL_TOP: Tile = { x: 0, y: 0 }

/** A hand-drawn grid: `#` is a wall, anything else is free floor. */
function drawn(rows: readonly string[]): MascotGrid {
  const cols = rows[0]?.length ?? 0
  const cells = new Uint8Array(cols * rows.length)
  rows.forEach((row, y) => [...row].forEach((char, x) => (cells[y * cols + x] = char === '#' ? 0 : 1)))
  const at = { x: 0, y: 0 }
  return { cols, rows: rows.length, walkable: cells, staticWalkable: cells, spots: { basket: at, bowl: at, drink: at, door: at, whiteboard: at }, key: 'drawn' }
}

describe('the tile helpers', () => {
  test('a tile is 16 px, its centre is 8 px in, and a point is in the tile it falls in', () => {
    expect(tileRect({ x: 3, y: 5 })).toEqual({ x: 48, y: 80, w: 16, h: 16 })
    expect(tileCentre({ x: 3, y: 5 })).toEqual({ x: 56, y: 88 })
    expect(tileOf({ x: 56, y: 88 })).toEqual({ x: 3, y: 5 })
    expect(tileOf({ x: 63, y: 95 })).toEqual({ x: 3, y: 5 })
    expect(tileOf({ x: 64, y: 96 })).toEqual({ x: 4, y: 6 })
  })
})

describe('deskPropRects', () => {
  test('are where the renderer has always drawn the monitor and the lamp', () => {
    const { monitor, lamp } = deskPropRects({ x: 4, y: 8, w: 4, h: 3 })
    expect(monitor).toEqual({ x: 68, y: 157, w: 8, h: 8 })
    expect(lamp).toEqual({ x: 101, y: 157, w: 6, h: 8 })
  })
})

describe('what is walkable', () => {
  test('the whole hallway, down to the wall that holds the door', () => {
    for (const [name, make] of WORLDS) {
      const { grid } = build(make())
      for (let y = 0; y < grid.rows - 1; y++) {
        expect(isWalkable(grid, { x: 0, y }), `${name} (0,${y})`).toBe(true)
        expect(isWalkable(grid, { x: 1, y }), `${name} (1,${y})`).toBe(true)
      }
      for (let x = 0; x < grid.cols; x++) expect(isWalkable(grid, { x, y: grid.rows - 1 }), `${name} bottom wall`).toBe(false)
    }
  })

  test('not a sign, a desk, a chair, a stool, the bench, a plant or the board', () => {
    const { layout, grid } = build(roomsWorld())
    for (const cluster of layout.clusters) {
      for (let x = cluster.signRect.x; x < cluster.signRect.x + cluster.signRect.w; x++) {
        expect(isWalkable(grid, { x, y: cluster.signRect.y }, true), `sign ${cluster.project} ${x}`).toBe(false)
      }
    }
    for (const desk of layout.desks) {
      for (const object of deskObjects(desk.rect)) expect(isWalkable(grid, object, true), `desk ${desk.id}`).toBe(false)
    }
    const tilemap = buildTileMap(layout, { quota: true })
    for (const object of tilemap.objects) expect(isWalkable(grid, object, true), object.tile).toBe(false)
    for (const placement of layout.placements) {
      if (placement.kind === 'board') expect(isWalkable(grid, tileOf(placement.seat), true), 'a board tag').toBe(false)
    }
  })

  test('the walls between the top rooms are doorways, the wall under the top band is not', () => {
    const { layout, grid } = build(stateWorld('thinking'))
    const band = layout.rooms.find((room) => room.id === 'manager')?.rect as Rect
    for (let y = 3; y < band.h; y++) {
      expect(isWalkable(grid, { x: 13, y }), `(13,${y})`).toBe(true)
      expect(isWalkable(grid, { x: 24, y }), `(24,${y})`).toBe(true)
    }
    for (let x = 3; x < grid.cols; x++) expect(isWalkable(grid, { x, y: band.h }), `band wall (${x},${band.h})`).toBe(false)
    expect(isWalkable(grid, { x: 13, y: 1 }), 'the wall face is a wall').toBe(false)
  })

  test('his basket and his bowl are destinations: nobody walks across them, and they are not in the way of anyone', () => {
    for (const [name, make] of WORLDS) {
      const { grid } = build(make())
      expect(isWalkable(grid, grid.spots.basket), `${name} basket`).toBe(false)
      expect(isWalkable(grid, grid.spots.bowl), `${name} bowl`).toBe(false)
    }
  })

  test('a desk whose agent has a bubble reserves its headroom; one whose agent has none (waiting for you) does not', () => {
    const thinking = build(stateWorld('thinking'))
    const waiting = build(stateWorld('waiting_user'))
    expect(STATE_VISUALS.thinking.bubble).toBeDefined()
    expect(STATE_VISUALS.waiting_user.bubble).toBeUndefined()
    const cell = (thinking.layout.desks[0] as { rect: Rect }).rect
    const above: Tile = { x: cell.x + 1, y: cell.y }
    expect(isWalkable(thinking.grid, above)).toBe(false)
    expect(isWalkable(thinking.grid, above, true)).toBe(true)
    expect(isWalkable(waiting.grid, above)).toBe(true)
  })

  test('the lamp and the monitor of every desk are kept clear whoever sits there', () => {
    const { layout, grid } = build(stateWorld('waiting_user'))
    for (const desk of layout.desks) {
      const { monitor, lamp } = deskPropRects(desk.rect)
      for (const rect of [monitor, lamp]) {
        for (let y = 0; y < grid.rows; y++) {
          for (let x = 0; x < grid.cols; x++) {
            if (rectsOverlap(tileRect({ x, y }), rect)) expect(isWalkable(grid, { x, y }, true), `(${x},${y})`).toBe(false)
          }
        }
      }
    }
  })

  test('the key changes when the grid does, and not when it stays', () => {
    const a = build(stateWorld('thinking'))
    expect(build(stateWorld('thinking')).grid.key).toBe(a.grid.key)
    expect(build(stateWorld('waiting_user')).grid.key).not.toBe(a.grid.key)
    expect(build(roomsWorld()).grid.key).not.toBe(a.grid.key)
  })
})

describe('Morty never covers a bubble, a lamp, a monitor or a board tag', () => {
  /** Every rectangle that must stay clear, in px: reserved places and the bubbles as really placed. */
  function obstaclesOf({ world, layout }: Built): { name: string; rect: Rect }[] {
    const list = [...staticObstacles(layout), ...bubbleObstacles(world, layout)].map((rect) => ({ name: 'reserved', rect }))
    const requests = layout.placements.flatMap((placement) =>
      STATE_VISUALS[world.agents[placement.agentId]?.state ?? 'ended'].bubble
        ? [{ agentId: placement.agentId, width: placement.kind === 'desk' ? DESK_BUBBLE_MAX_W : COMPACT_W }]
        : []
    )
    // A placed bubble with its tail: three px under the box.
    for (const box of placeBubbles(layout, requests)) list.push({ name: `bubble of ${box.agentId}`, rect: { ...box.rect, h: BUBBLE_H + 3 } })
    return list
  }

  for (const [name, make] of WORLDS) {
    test(`no tile he may stand on touches one: ${name}`, () => {
      const built = build(make())
      const obstacles = obstaclesOf(built)
      const { grid } = built
      let walkable = 0
      for (let y = 0; y < grid.rows; y++) {
        for (let x = 0; x < grid.cols; x++) {
          if (!isWalkable(grid, { x, y })) continue
          walkable++
          for (const obstacle of obstacles) expect(rectsOverlap(tileRect({ x, y }), obstacle.rect), `(${x},${y}) and the ${obstacle.name}`).toBe(false)
        }
      }
      expect(walkable).toBeGreaterThan(20)
    })
  }

  test('the grid without the bubble places still keeps clear of lamps, monitors and tags', () => {
    const built = build(roomsWorld())
    for (let y = 0; y < built.grid.rows; y++) {
      for (let x = 0; x < built.grid.cols; x++) {
        if (!isWalkable(built.grid, { x, y }, true)) continue
        for (const rect of staticObstacles(built.layout)) expect(rectsOverlap(tileRect({ x, y }), rect), `(${x},${y})`).toBe(false)
      }
    }
  })
})

describe('where he goes', () => {
  test('the basket, the door and the drinking place are reachable from the hallway in every world', () => {
    for (const [name, make] of WORLDS) {
      const { grid } = build(make())
      for (const [what, spot] of [
        ['basket', grid.spots.basket],
        ['door', grid.spots.door],
        ['drink', grid.spots.drink],
      ] as const) {
        expect(isWalkable(grid, spot) || what === 'basket', `${name} ${what} is a tile he may stand on`).toBe(true)
        expect(findPath(grid, HALL_TOP, spot), `${name}: a way to the ${what}`).toBeDefined()
      }
    }
  })

  test('the spots are where the office says: lobby corner, beside the door, under the bowl, under the whiteboard', () => {
    const { layout, grid } = build(roomsWorld())
    const lobby = layout.rooms.find((room) => room.id === 'lobby')?.rect as Rect
    const floor = layout.rooms.find((room) => room.id === 'floor')?.rect as Rect
    const lastRow = lobby.y + lobby.h - 1
    expect(grid.spots).toEqual(mascotSpots(layout))
    expect(grid.spots.basket).toEqual({ x: 33, y: lastRow })
    expect(grid.spots.door).toEqual({ x: 2, y: lastRow })
    expect(grid.spots.bowl).toEqual({ x: 3, y: floor.y })
    expect(grid.spots.drink).toEqual({ x: 3, y: floor.y + 1 })
    expect(grid.spots.whiteboard).toEqual({ x: 18, y: 3 })
    expect(lastRow + 1, 'the door is in the wall just under').toBe(layout.rows - 1)
  })

  test('the whiteboard: an empty planning room has a way to it through the manager\'s office; an occupied one may not', () => {
    const empty = build(stateWorld('thinking'))
    expect(isWalkable(empty.grid, empty.grid.spots.whiteboard)).toBe(true)
    expect(findPath(empty.grid, HALL_TOP, empty.grid.spots.whiteboard)).toBeDefined()
    // In `rooms` a planner sits at the first desk with a bubble over the tile under the whiteboard.
    const busy = build(roomsWorld())
    expect(isWalkable(busy.grid, busy.grid.spots.whiteboard)).toBe(false)
  })

  test('rooms are told apart: the hallway, the top rooms, the floor and the lobby', () => {
    const { layout } = build(roomsWorld())
    expect(roomOf(layout, { x: 0, y: 0 })).toBe('hall')
    expect(roomOf(layout, { x: 2, y: 4 })).toBe('hall')
    expect(roomOf(layout, { x: 5, y: 4 })).toBe('manager')
    expect(roomOf(layout, { x: 18, y: 3 })).toBe('planning')
    expect(roomOf(layout, { x: 28, y: 3 })).toBe('review')
    expect(roomOf(layout, { x: 13, y: 4 }), 'inside a wall').toBeUndefined()
    const floor = layout.rooms.find((room) => room.id === 'floor')?.rect as Rect
    expect(roomOf(layout, { x: 3, y: floor.y + 1 })).toBe('floor')
    expect(roomOf(layout, { x: 33, y: layout.rows - 2 })).toBe('lobby')
  })
})

describe('findPath', () => {
  test('is the shortest way, 4-connected, through walkable tiles, both ends included', () => {
    const grid = drawn(['.....', '.###.', '.....'])
    const path = findPath(grid, { x: 0, y: 0 }, { x: 4, y: 2 }) as Tile[]
    expect(path[0]).toEqual({ x: 0, y: 0 })
    expect(path.at(-1)).toEqual({ x: 4, y: 2 })
    expect(path).toHaveLength(7)
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as Tile
      const b = path[i] as Tile
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1)
      expect(isWalkable(grid, b)).toBe(true)
    }
  })

  test('is the same path every time, whichever way round a tie could go', () => {
    const grid = drawn(['....', '....', '....', '....'])
    const a = findPath(grid, { x: 0, y: 0 }, { x: 3, y: 3 })
    expect(findPath(grid, { x: 0, y: 0 }, { x: 3, y: 3 })).toEqual(a)
    expect(a).toHaveLength(7)
  })

  test('may start and end on a tile that is not walkable (a basket, a tile that was just reserved)', () => {
    const grid = drawn(['#...#'])
    expect(findPath(grid, { x: 0, y: 0 }, { x: 4, y: 0 })).toHaveLength(5)
  })

  test('never crosses a tile that is not walkable in the middle', () => {
    expect(findPath(drawn(['..#..']), { x: 0, y: 0 }, { x: 4, y: 0 })).toBeUndefined()
  })

  test('a walled-off goal, and a goal or start off the map, have no path', () => {
    const grid = drawn(['..#.', '..#.'])
    expect(findPath(grid, { x: 0, y: 0 }, { x: 3, y: 1 })).toBeUndefined()
    expect(findPath(grid, { x: 0, y: 0 }, { x: 9, y: 9 })).toBeUndefined()
    expect(findPath(grid, { x: -1, y: 0 }, { x: 1, y: 0 })).toBeUndefined()
  })

  test('to where he already is is that one tile', () => {
    expect(findPath(drawn(['...']), { x: 1, y: 0 }, { x: 1, y: 0 })).toEqual([{ x: 1, y: 0 }])
  })

  test('the static grid is used when asked for', () => {
    const grid = drawn(['...'])
    const blocked: MascotGrid = { ...grid, walkable: new Uint8Array([1, 0, 1]) }
    expect(findPath(blocked, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeUndefined()
    expect(findPath(blocked, { x: 0, y: 0 }, { x: 2, y: 0 }, true)).toHaveLength(3)
  })
})

describe('cornerPoints', () => {
  test('keeps the ends and the turns and drops the points on a straight run', () => {
    const path: Tile[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]
    expect(cornerPoints(path)).toEqual([
      { x: 8, y: 8 },
      { x: 40, y: 8 },
      { x: 40, y: 40 },
    ])
  })

  test('a one-tile path is one point, a two-tile path is both', () => {
    expect(cornerPoints([{ x: 1, y: 1 }])).toEqual([{ x: 24, y: 24 }])
    expect(cornerPoints([{ x: 1, y: 1 }, { x: 2, y: 1 }])).toHaveLength(2)
  })
})

describe('reachableTiles and spotNearCell', () => {
  test('the tiles he can reach are walkable, in reading order, and leave out a walled-off pocket', () => {
    const grid = drawn(['..#.', '..#.'])
    expect(reachableTiles(grid, { x: 0, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ])
  })

  test('the spot near a desk is not inside its cell, is close, and is level with the desk when it can be', () => {
    const grid = drawn(['.........', '.........', '.........', '.........', '.........'])
    const cell: Rect = { x: 3, y: 1, w: 3, h: 3 }
    const spot = spotNearCell(grid, cell, 3, { x: 0, y: 0 }) as Tile
    expect(spot).toEqual({ x: 2, y: 2 }) // distance 1, level with the middle row, first in reading order among those
    expect(spotNearCell(grid, cell, 3, { x: 0, y: 0 })).toEqual(spot)
  })

  test('no spot within reach: undefined', () => {
    const grid = drawn(['###', '#.#', '###'])
    expect(spotNearCell(grid, { x: 1, y: 1, w: 1, h: 1 }, 3, { x: 1, y: 1 })).toBeUndefined()
    const far = drawn(['.......', '#######', '.......'])
    // The tiles within one of the cell are behind a wall, and the ones he can reach are two away.
    expect(spotNearCell(far, { x: 0, y: 2, w: 1, h: 1 }, 1, { x: 0, y: 0 })).toBeUndefined()
  })
})
