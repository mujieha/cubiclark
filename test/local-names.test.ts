import { describe, expect, test } from 'vitest'
import { localNames } from '../scripts/local-names.js'

describe('localNames', () => {
  test('the account name and the home path segments, lower-cased, once each', () => {
    expect(localNames({ username: 'Someone', home: '/Users/Someone' })).toEqual(['someone'])
    expect(localNames({ username: 'alice', home: '/export/homes/alice' })).toEqual(['alice', 'export', 'homes'])
    expect(localNames({ username: 'bob', home: 'C:\\Users\\Bobby' })).toEqual(['bobby'])
  })

  test('generic CI names and short words give nothing', () => {
    expect(localNames({ username: 'runner', home: '/home/runner' })).toEqual([])
    expect(localNames({ username: 'root', home: '/root' })).toEqual([])
    expect(localNames({ username: 'ci', home: '/var/ci' })).toEqual([])
  })

  test('the real environment gives only words that are not generic', () => {
    for (const word of localNames()) {
      expect(word.length).toBeGreaterThanOrEqual(4)
      expect(word).toBe(word.toLowerCase())
      expect(['users', 'home', 'runner']).not.toContain(word)
    }
  })
})
