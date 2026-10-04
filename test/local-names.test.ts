import { describe, expect, test } from 'vitest'
import { localNames } from '../scripts/local-names.js'

describe('localNames', () => {
  test('the account name, lower-cased', () => {
    expect(localNames({ username: 'Someone' })).toEqual(['someone'])
    expect(localNames({ username: 'alice' })).toEqual(['alice'])
  })

  test('generic CI names and short names give nothing', () => {
    expect(localNames({ username: 'runner' })).toEqual([])
    expect(localNames({ username: 'root' })).toEqual([])
    expect(localNames({ username: 'ci' })).toEqual([])
    expect(localNames({ username: '' })).toEqual([])
  })

  test('the real environment gives at most one word, lower-cased and not generic', () => {
    const names = localNames()
    expect(names.length).toBeLessThanOrEqual(1)
    for (const word of names) {
      expect(word.length).toBeGreaterThanOrEqual(4)
      expect(word).toBe(word.toLowerCase())
      expect(['runner', 'root', 'user']).not.toContain(word)
    }
  })
})
