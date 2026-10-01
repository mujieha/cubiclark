// What the terminal and the environment decide for `cubiclark tui` (colour, characters, animation, the
// mode, the size). Every function takes what it reads as an argument, so each rule is a test.

import type { TuiSize } from '../core/tui/render.js'

export type Env = Readonly<Record<string, string | undefined>>

const set = (value: string | undefined): boolean => value !== undefined && value !== ''

/** Colour: never with `--no-color` or NO_COLOR (any non-empty value); otherwise on a terminal, or when
 * FORCE_COLOR asks for it (anything but 0). */
export function colorOn(flagColor: boolean, env: Env, stdoutIsTTY: boolean): boolean {
  if (!flagColor || set(env.NO_COLOR)) return false
  if (set(env.FORCE_COLOR)) return env.FORCE_COLOR !== '0'
  return stdoutIsTTY
}

/** Box drawing and the dog emoji only under a UTF-8 locale (the first of LC_ALL, LC_CTYPE, LANG that is set). */
export function unicodeOn(ascii: boolean, env: Env): boolean {
  if (ascii) return false
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(set) ?? ''
  return /utf-?8/i.test(locale)
}

/** Animation: off with `--no-animation`, CUBICLARK_REDUCED_MOTION (anything but 0), or a dumb terminal. */
export function animationOn(flagAnimation: boolean, env: Env): boolean {
  if (!flagAnimation) return false
  if (set(env.CUBICLARK_REDUCED_MOTION) && env.CUBICLARK_REDUCED_MOTION !== '0') return false
  return env.TERM !== 'dumb'
}

export type TuiRunMode = { kind: 'print'; frames: number } | { kind: 'interactive' }

/** `--once` prints one frame and `--frames n` n frames. Otherwise a terminal on both ends is interactive,
 * and anything else (a pipe, a test) prints one frame. */
export function tuiMode(cmd: { once: boolean; frames?: number }, stdinIsTTY: boolean, stdoutIsTTY: boolean): TuiRunMode {
  if (cmd.frames !== undefined) return { kind: 'print', frames: cmd.frames }
  if (cmd.once) return { kind: 'print', frames: 1 }
  return stdinIsTTY && stdoutIsTTY ? { kind: 'interactive' } : { kind: 'print', frames: 1 }
}

export const MAX_SIZE_COLS = 1000
export const MAX_SIZE_ROWS = 500

/** `--size 120x40`. */
export function parseSize(raw: string): TuiSize | undefined {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(raw)
  if (!match) return undefined
  const cols = Number(match[1])
  const rows = Number(match[2])
  return cols >= 1 && cols <= MAX_SIZE_COLS && rows >= 1 && rows <= MAX_SIZE_ROWS ? { cols, rows } : undefined
}

/** The size of a frame: `--size`, else the terminal's, else 80x24. A frame printed to a terminal leaves
 * its last row free, so the shell's prompt stays on screen. */
export function frameSize(flag: TuiSize | undefined, out: { isTTY?: boolean; columns?: number; rows?: number }, kind: TuiRunMode['kind']): TuiSize {
  if (flag) return flag
  if (out.isTTY === true && out.columns !== undefined && out.rows !== undefined && out.columns > 0 && out.rows > 0) {
    return { cols: out.columns, rows: kind === 'print' ? Math.max(1, out.rows - 1) : out.rows }
  }
  return { cols: 80, rows: 24 }
}
