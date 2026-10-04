// A theme is data (design §7: "one 16-colour palette per theme"): the office's canvas palette and
// the page's colour tokens. Pure: nothing here touches the DOM, so tests import it. A custom
// palette (docs/assets.md) is merged over one of these and must pass the same rules.

/** The single characters a sprite grid uses for a colour. */
export const PALETTE_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'] as const
export type PaletteKey = (typeof PALETTE_KEYS)[number]

/** The three colours only Morty, the office corgi, is drawn in: g coat, h cream, i nose. They are
 * not palette keys, so a custom-assets pack can neither use nor replace them. */
export const MASCOT_KEYS = ['g', 'h', 'i'] as const

/** Palette key -> '#rrggbb'. */
export type Palette = Readonly<Record<string, string>>

export type ThemeId = 'day' | 'night'
/** What a person picks: a theme, or `auto` to follow the operating system. */
export type ThemeChoice = 'auto' | ThemeId
export const THEME_CHOICES: readonly ThemeChoice[] = ['auto', 'day', 'night']

/** The colours of the page around the canvas. */
export interface PageTokens {
  bg: string
  fg: string
  dim: string
  line: string
  accent: string
  warn: string
  err: string
  panelBg: string
  rowHover: string
  canvasBg: string
}

export interface Theme {
  id: ThemeId
  label: string
  colorScheme: 'light' | 'dark'
  /** Exactly the 16 PALETTE_KEYS. */
  palette: Palette
  /** Exactly the MASCOT_KEYS: Morty's coat, cream and nose. */
  mascot: Palette
  page: PageTokens
  /** The focus ring drawn on the canvas around the selected agent. */
  ring: string
}

/** Anything that is not one of the three choices is `auto`: a value read from storage is never trusted. */
export function parseThemeChoice(raw: unknown): ThemeChoice {
  return raw === 'day' || raw === 'night' || raw === 'auto' ? raw : 'auto'
}

export function resolveThemeId(choice: ThemeChoice, prefersDark: boolean): ThemeId {
  return choice === 'auto' ? (prefersDark ? 'night' : 'day') : choice
}

/** auto -> day -> night -> auto. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  return choice === 'auto' ? 'day' : choice === 'day' ? 'night' : 'auto'
}

/** The toggle's text: what is chosen, and for `auto` what that means right now. */
export function themeButtonText(choice: ThemeChoice, resolved: ThemeId): string {
  const name = (id: ThemeId): string => (id === 'day' ? 'Day' : 'Night')
  return choice === 'auto' ? `Theme: Auto (${resolved})` : `Theme: ${name(choice)}`
}

/** `base` with the entries of `override` on top; the keys `override` does not name are unchanged. */
export function mergePalette(base: Palette, override: Partial<Record<string, string>> | undefined): Palette {
  if (!override) return base
  const merged: Record<string, string> = { ...base }
  for (const [key, value] of Object.entries(override)) if (value !== undefined) merged[key] = value
  return merged
}
