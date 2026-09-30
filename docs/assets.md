# Custom assets

A **pack** is one JSON file that changes how the office looks: colours per theme, and pictures for
the characters, their accessories and the floors and furniture. It is data, never code, and it
changes nothing that tells one state from another. `examples/assets/sunny-office/` is a working pack;
`schema/assets-manifest.v1.json` is the JSON Schema of the format (an editor that reads JSON Schema
completes and checks a pack as you type: put `"$schema": "<path to it>"` first, as the example does).

## Using a pack

    cubiclark --assets path/to/manifest.json
    cubiclark replay --since 3h --assets path/to/manifest.json

Without `--assets`, Cubiclark reads `<state dir>/assets/manifest.json` (`~/.cubiclark/assets/manifest.json`
by default) if it exists. A fixture home (`--fixture-home`) without `--state-dir` reads none, so a test
never picks up the real one. The file is read **once, at start**: change it and restart.

Check a pack without starting the page:

    cubiclark doctor --fixture-home <an empty folder> --assets path/to/manifest.json

`doctor` prints `assets  ok — <name>: 2 palettes, 3 sprites`, or `assets  invalid — 4 errors` and one
line per error with where it is (`/sprites/tile:floor_wood/rows/3: is 15 characters wide, needs exactly
16`), and exits 1 when the manifest is invalid. The running page shows the same errors, as text, above
everything else, and the sources line says `assets: ok — …` or `assets: invalid — N errors`.

**A manifest with any error is not applied at all**: the office is drawn as if there were none. A
half-applied pack could make two states look alike.

## The format (version 1)

```json
{
  "$schema": "../../../schema/assets-manifest.v1.json",
  "version": 1,
  "name": "sunny-office",
  "description": "Warmer wood, amber headphones and a patterned planning-room carpet.",
  "palettes": {
    "day": { "6": "#7a4a2d", "7": "#d9a86c" },
    "night": { "6": "#5a3826", "7": "#a0784a" }
  },
  "sprites": {
    "accessory:headphones": { "rows": ["....", "…seven rows of fourteen characters…"] },
    "tile:floor_carpet_planning": { "rows": ["…sixteen rows of sixteen characters…"] }
  }
}
```

| Key | Rules |
|---|---|
| `version` | Must be `1`. |
| `name` | Required. 1 to 40 characters: lower-case letters, digits and `-`, not starting with `-`. |
| `description` | Optional, at most 200 characters. |
| `$schema` | Optional, at most 200 characters, ignored. |
| `palettes` | Optional. Keys `day` and `night` only; each an object of palette key to `#rrggbb`. Only the keys you give change. |
| `sprites` | Optional. At most 200 entries; each key one of the ids below, each value `{ "rows": [...] }`. |

Any other key is an error, at its own path.

### Palettes

Sixteen colours, named by one character each (`0`–`9`, `a`–`f`); a sprite's grid uses those
characters. What they are for in the built-in themes: `0` ink, `1` paper (bubble fill), `2` light
grey, `3` mid grey (the "other" shirt), `4` wall dark, `5` wall face, `6` wood dark, `7` wood light (desk
tops, one skin tone), `8` and `9` skin, `a` red (alert bubble, red lamp), `b` amber (lamp, one hair
colour), `c` green (Haiku shirt, check tag), `d` blue (Sonnet shirt, screens), `e` purple (Opus
shirt), `f` pink (Fable shirt). The built-in day and night palettes are in `src/core/theme/day.ts` and
`night.ts`.

**A palette must still tell things apart.** After a pack's colours are merged over a theme's, the
result must pass these rules or the manifest is refused, at `/palettes/<theme>`:

- ink on paper (`0` and `1`) has a contrast of at least 4.5 (bubble text);
- paper on red (`1` and `a`) has a contrast of at least 3 (the alert bubble);
- red, amber and green (`a`, `b`, `c`) are at least 80 apart in RGB (the lamps and marks);
- the shirts (`3`, `c`, `d`, `e`, `f`) are at least 60 apart from each other (the models).

### Sprites

A sprite is a list of rows, each a string of the same length. `.` is transparent; any palette
character is that colour. **A sprite has exactly the size of the one it replaces** (below). A
character frame may also use `S`, `K` and `H`, which the office fills in with the agent's shirt, skin
and hair; nothing else may.

A character frame keeps the built-in frame's anchors (where the head and chest are, which is where
accessories attach) and an accessory keeps where it hangs, so a pack only ever changes pixels.

Ids (a sprite's id is its kind, a colon and its name):

- **`character:<name>`**, 16×24 px each: `sit_idle_a`, `sit_idle_b`, `sit_type_a`, `sit_type_b`,
  `sit_lean_fwd_a`, `sit_lean_fwd_b`, `sit_lean_back`, `sit_side`, `sit_shuffle_a`, `sit_shuffle_b`,
  `sit_sleep`, `sit_slump`, `stand`, `stand_wave_a`, `stand_wave_b`, `walk_down_a`, `walk_down_b`,
  `walk_up_a`, `walk_up_b`, `walk_side_a`, `walk_side_b`.
- **`accessory:<name>`**: `tie` 4×6, `clipboard` 6×7, `magnifier` 7×7, `headphones` 14×7, `cap` 12×4.
- **`tile:<name>`**, 16×16 px each: `floor_wood`, `floor_carpet_manager`, `floor_carpet_planning`,
  `floor_tile_review`, `floor_lobby`, `hall`, `partition`, `wall_top`, `wall_face`, `door_closed`,
  `door_open`, `desk_l`, `desk_m`, `desk_r`, `chair`, `stool`, `bench`, `sign`, `whiteboard_l`,
  `whiteboard_r`, `meter_frame`, `plant`, `board`.

**What cannot be replaced, and why.** The bubble icons, the lobby board's tags, the lamps, the
monitors and the empty-screen props are how two different states are told apart (a state is never
told by colour alone). A pack that could redraw them could make two states look alike, so they are
not in the list and an id for one is an error.

## Limits

The file is at most 256 KiB and must be a regular file. At most 50 errors are reported (then a line
saying how many more); the page lists 10 and `doctor` lists 10 and says how many more. A key or a
value in an error message has its control characters removed and is cut to a safe length.

## What a pack cannot do

It cannot run anything, load an image or a font, change text, change the layout, add a state, a room
or a character, or reach anything outside its own JSON. Pictures are drawn from characters in the
grids; Cubiclark's own art is drawn the same way (`src/client/office/art/`). pixel-agents' PNG format
is not read.
