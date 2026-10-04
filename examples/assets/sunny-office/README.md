# sunny-office

An example custom-assets pack for Cubiclark: warmer wood in both themes, amber headphones and a
patterned carpet in the planning room. It changes nothing that tells one state from another.

    cubiclark --assets examples/assets/sunny-office/manifest.json

Check a pack of your own without starting the page (it exits 1 and lists every problem when the
manifest is invalid):

    cubiclark doctor --fixture-home <an empty folder> --assets <your manifest.json>

What a manifest can hold, the ids of the sprites it may replace and the rules a palette must pass are
in `docs/assets.md`; `schema/assets-manifest.v1.json` is the JSON Schema, and this pack's
`$schema` line points at it, so an editor can complete and check the file as you type.

This pack draws its own art (nine hand-placed colours and two small grids); copy it and change it
freely.
