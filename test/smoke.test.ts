import { describe, expect, test } from 'vitest'
import { parseCli } from '../src/cli.js'

describe('smoke', () => {
  test('parseCli returns the serve defaults', () => {
    const opts = parseCli([])
    expect(opts).toMatchObject({ command: 'serve', port: 4789, open: true })
  })
})
