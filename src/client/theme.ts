// The theme on the page: which one is chosen (remembered in this browser, as a convenience only),
// and how it reaches the page's colours and the office. Colours go through the CSSOM
// (`style.setProperty`), which the CSP allows; there is no <style> element and no style attribute.

import { mergePalette, parseThemeChoice, type PageTokens, type Palette, type Theme, type ThemeChoice } from '../core/theme/theme.js'
import { NO_ASSETS, type PublicAssets } from '../core/assets/status.js'
import { artWithOverrides, type ArtSet } from './office/art/art-set.js'
import type { Look } from './office/renderer.js'

export const THEME_STORAGE_KEY = 'cubiclark.theme'

/** The remembered choice. No storage (a private window, blocked site data) means `auto`. */
export function readThemeChoice(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'auto'
  }
}

export function writeThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // storage can be blocked; the choice then lasts until the page is closed
  }
}

const TOKEN_VARIABLES: Record<keyof PageTokens, string> = {
  bg: '--bg',
  fg: '--fg',
  dim: '--dim',
  line: '--line',
  accent: '--accent',
  warn: '--warn',
  err: '--err',
  panelBg: '--panel-bg',
  rowHover: '--row-hover',
  canvasBg: '--canvas-bg',
}

/** Sets the page's colour tokens, its `color-scheme` and `data-theme` on `root`. */
export function applyPageTheme(root: HTMLElement, theme: Theme): void {
  for (const [name, variable] of Object.entries(TOKEN_VARIABLES)) {
    root.style.setProperty(variable, theme.page[name as keyof PageTokens])
  }
  root.style.colorScheme = theme.colorScheme
  root.dataset.theme = theme.id
}

/** What the office is drawn from in a theme: its palette (with a pack's colours for that theme
 * merged in), its ring colour and the art (with a pack's sprites on top). */
export function lookFor(theme: Theme, custom: PublicAssets = NO_ASSETS): Look {
  const art: ArtSet = artWithOverrides(custom.sprites)
  return { palette: mergePalette(theme.palette, custom.palettes[theme.id]), ring: theme.ring, art }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The valid pack the server holds, or none. A failed request or an answer of the wrong shape means
 * no pack: the office is then drawn in the built-in art. */
export async function fetchCustomAssets(): Promise<PublicAssets> {
  try {
    const response = await fetch('./custom-assets.json')
    if (!response.ok) return NO_ASSETS
    const value: unknown = await response.json()
    if (!isRecord(value) || !isRecord(value.palettes) || !isRecord(value.sprites)) return NO_ASSETS
    return { palettes: value.palettes as PublicAssets['palettes'], sprites: value.sprites as PublicAssets['sprites'] }
  } catch {
    return NO_ASSETS
  }
}

export type { Palette }
