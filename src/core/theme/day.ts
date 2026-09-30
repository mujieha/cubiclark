// The day theme: a light page around the office, whose palette is the one the office has always
// been drawn in (so choosing `day` changes no pixel of the canvas). Our own values, not a
// published palette.

import type { Theme } from './theme.js'

export const DAY: Theme = {
  id: 'day',
  label: 'Day',
  colorScheme: 'light',
  palette: {
    '0': '#16161d', // outline, ink
    '1': '#f2efe6', // paper, bubble fill
    '2': '#a8b0b8', // light grey, muted bubble
    '3': '#5b6470', // mid grey, shirt for "other"
    '4': '#2b3140', // wall dark
    '5': '#3e4a5e', // wall face, hallway
    '6': '#8c5a3a', // wood dark
    '7': '#c9955f', // wood light, desk top
    '8': '#f0c9a0', // skin light
    '9': '#9a6444', // skin dark
    a: '#d8483f', // red: alert bubble, red lamp, cross
    b: '#f0a830', // amber lamp
    c: '#4caf6e', // green: shirt haiku, check tag, plants
    d: '#3d7fd9', // blue: shirt sonnet, screens
    e: '#8a5cc7', // purple: shirt opus
    f: '#e87fa8', // pink: shirt fable
  },
  mascot: {
    g: '#a85a22', // Morty's coat
    h: '#f4e6c8', // cream chest, muzzle and legs
    i: '#1c1410', // nose
  },
  page: {
    bg: '#f6f4ee',
    fg: '#1d2421',
    dim: '#5a6560',
    line: '#cfd6d2',
    accent: '#1a6f4c',
    warn: '#8a5a00',
    err: '#b3261e',
    panelBg: '#ffffff',
    rowHover: '#e3efe9',
    canvasBg: '#16161d',
  },
  // Drawn on the office, which is dark in every theme, so it is the same bright green as at night.
  ring: '#6fd6a8',
}
