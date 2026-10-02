// NO_COLOR and FORCE_COLOR, settled before anything else runs (see bin.ts). This file imports
// nothing, on purpose: bin.ts imports it before any Node built-in is loaded.

/** When both are set, a non-empty NO_COLOR wins, as it does in `cubiclark tui` (src/tui/env.ts) and at
 * no-color.org: FORCE_COLOR is dropped. An empty NO_COLOR means nothing, so it is the one dropped.
 * Otherwise the environment is left as it is. Node warns on stderr whenever both are present, and in
 * the terminal's interactive mode that line would tear the screen. */
export function settleColorEnv(env: Record<string, string | undefined>): void {
  if (env.NO_COLOR === undefined || env.FORCE_COLOR === undefined) return
  if (env.NO_COLOR !== '') delete env.FORCE_COLOR
  else delete env.NO_COLOR
}
