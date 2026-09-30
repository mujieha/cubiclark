// Whether Morty is shown: remembered in this browser like the theme (a convenience only), and the
// server's say when it was started with --no-mascot.

import { parseMascotChoice } from '../core/office/mascot.js'
import { DEFAULT_IDLE_DESKS, parseIdleDesks } from '../core/visible.js'

export const MASCOT_STORAGE_KEY = 'cubiclark.mascot'

/** The remembered choice. No storage (a private window, blocked site data) means he is on. */
export function readMascotChoice(): boolean {
  try {
    return parseMascotChoice(localStorage.getItem(MASCOT_STORAGE_KEY))
  } catch {
    return true
  }
}

export function writeMascotChoice(on: boolean): void {
  try {
    localStorage.setItem(MASCOT_STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // storage can be blocked; the choice then lasts until the page is closed
  }
}

export interface PageOptions {
  /** False when the server was started with --no-mascot: no Morty, and no button for him. */
  mascot: boolean
  /** How many idle sessions keep a desk (--idle-desks, default 5). */
  idleDesks: number
}

const DEFAULT_OPTIONS: PageOptions = { mascot: true, idleDesks: DEFAULT_IDLE_DESKS }

/** How the server was started. A failed request or an answer of the wrong shape means the defaults. */
export async function fetchPageOptions(): Promise<PageOptions> {
  try {
    const response = await fetch('./page-options.json')
    if (!response.ok) return DEFAULT_OPTIONS
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null) return DEFAULT_OPTIONS
    const fields = value as { mascot?: unknown; idleDesks?: unknown }
    return { mascot: fields.mascot !== false, idleDesks: parseIdleDesks(fields.idleDesks) ?? DEFAULT_IDLE_DESKS }
  } catch {
    return DEFAULT_OPTIONS
  }
}
