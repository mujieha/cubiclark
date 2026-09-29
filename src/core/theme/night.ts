// The night theme: today's dark page, and an office with the lights turned down (darker walls, wood
// and skin) while the lamps, marks and shirts stay bright, so every state is still told apart.

import type { Theme } from './theme.js'

export const NIGHT: Theme = {
  id: 'night',
  label: 'Night',
  colorScheme: 'dark',
  palette: {
    '0': '#0e0e14', // outline, ink
    '1': '#e6e1d3', // paper, bubble fill
    '2': '#8e96a0', // light grey, muted bubble
    '3': '#4a525e', // mid grey, shirt for "other"
    '4': '#1b2030', // wall dark
    '5': '#2a3346', // wall face, hallway
    '6': '#6a4430', // wood dark
    '7': '#9c7448', // wood light, desk top
    '8': '#e0b890', // skin light
    '9': '#86553a', // skin dark
    a: '#d8483f', // red: alert bubble, red lamp, cross
    b: '#f4b442', // amber lamp
    c: '#52b877', // green: shirt haiku, check tag, plants
    d: '#4a8ae6', // blue: shirt sonnet, screens
    e: '#9a6ad8', // purple: shirt opus
    f: '#ee8cb2', // pink: shirt fable
  },
  page: {
    bg: '#0b0f10',
    fg: '#d8e0dc',
    dim: '#8a9a92',
    line: '#253530',
    accent: '#6fd6a8',
    warn: '#e0b84a',
    err: '#e07a6f',
    panelBg: '#0d1312',
    rowHover: '#14201c',
    canvasBg: '#16161d',
  },
  ring: '#6fd6a8',
}
