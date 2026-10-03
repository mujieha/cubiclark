// C1: which directory the collector writes to. It runs in the session's project directory, so a relative
// path would scatter events.jsonl into project trees: only an absolute one is accepted, from the flag or
// from CUBICLARK_HOME, and anything else falls back to ~/.cubiclark.

import { describe, expect, test } from 'vitest'
import { collectorStateDir } from '../src/hook/collector.js'

const HOME = '/home/someone'

describe('collectorStateDir', () => {
  test('the flag wins, then CUBICLARK_HOME, then ~/.cubiclark', () => {
    expect(collectorStateDir(['--state-dir', '/flag'], { CUBICLARK_HOME: '/env' }, HOME)).toBe('/flag')
    expect(collectorStateDir([], { CUBICLARK_HOME: '/env' }, HOME)).toBe('/env')
    expect(collectorStateDir([], {}, HOME)).toBe('/home/someone/.cubiclark')
  })

  test('a relative CUBICLARK_HOME is ignored (C1)', () => {
    expect(collectorStateDir([], { CUBICLARK_HOME: 'state/cubi' }, HOME)).toBe('/home/someone/.cubiclark')
    expect(collectorStateDir([], { CUBICLARK_HOME: '~/.cubiclark-work' }, HOME)).toBe('/home/someone/.cubiclark')
  })

  test('a relative --state-dir is ignored too, and the absolute CUBICLARK_HOME behind it is used', () => {
    expect(collectorStateDir(['--state-dir', '.cubiclark'], { CUBICLARK_HOME: '/env' }, HOME)).toBe('/env')
    expect(collectorStateDir(['--state-dir', '.cubiclark'], {}, HOME)).toBe('/home/someone/.cubiclark')
  })
})
