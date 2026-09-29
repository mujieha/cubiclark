import { describe, expect, test } from 'vitest'
import { parseCli } from '../src/cli.js'

describe('smoke', () => {
  test('parseCli returns defaults', () => {
    const opts = parseCli([])
    expect(opts.port).toBe(4789)
    expect(opts.open).toBe(true)
  })
})
