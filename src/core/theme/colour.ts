// Colour arithmetic for the theme rules (src/core/theme/rules.ts): pure, so a palette can be
// judged in a unit test without a browser.

/** '#rrggbb' -> [r, g, b], each 0-255. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function channel(value: number): number {
  const s = value / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG 2.x contrast ratio, 1 (equal) to 21 (black on white). Symmetric. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Euclidean distance between two colours in RGB, 0 to about 441: how far apart they look. */
export function rgbDistance(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  return Math.hypot(ar - br, ag - bg, ab - bb)
}
