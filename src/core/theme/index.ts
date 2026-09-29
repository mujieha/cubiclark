import { DAY } from './day.js'
import { NIGHT } from './night.js'
import type { Theme, ThemeId } from './theme.js'

export const THEMES: Readonly<Record<ThemeId, Theme>> = { day: DAY, night: NIGHT }

export { DAY, NIGHT }
export * from './colour.js'
export * from './rules.js'
export * from './theme.js'
