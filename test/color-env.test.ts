// NO_COLOR and FORCE_COLOR, settled before anything else runs: the same answer cubiclark gives, and
// never both left in the environment (Node warns on stderr when both are there).

import { describe, expect, test } from 'vitest'
import { settleColorEnv } from '../src/color-env.js'

function settled(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const copy = { ...env }
  settleColorEnv(copy)
  return copy
}

describe('settleColorEnv', () => {
  test('a non-empty NO_COLOR wins: FORCE_COLOR is dropped', () => {
    expect(settled({ NO_COLOR: '1', FORCE_COLOR: '1', TERM: 'xterm' })).toEqual({ NO_COLOR: '1', TERM: 'xterm' })
    expect(settled({ NO_COLOR: 'yes', FORCE_COLOR: '' })).toEqual({ NO_COLOR: 'yes' })
  })

  test('an empty NO_COLOR means nothing (no-color.org): it is the one dropped, and FORCE_COLOR stands', () => {
    expect(settled({ NO_COLOR: '', FORCE_COLOR: '1' })).toEqual({ FORCE_COLOR: '1' })
  })

  test('only one of them, or neither: the environment is left as it is', () => {
    expect(settled({ NO_COLOR: '1' })).toEqual({ NO_COLOR: '1' })
    expect(settled({ FORCE_COLOR: '0' })).toEqual({ FORCE_COLOR: '0' })
    expect(settled({ NO_COLOR: '' })).toEqual({ NO_COLOR: '' })
    expect(settled({ PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  test('it changes the object it is given, so process.env itself is settled', () => {
    const env: Record<string, string | undefined> = { NO_COLOR: '1', FORCE_COLOR: '3' }
    settleColorEnv(env)
    expect('FORCE_COLOR' in env).toBe(false)
  })
})
