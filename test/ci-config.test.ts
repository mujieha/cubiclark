// The CI configuration, checked as text (R2-1, R2-8). A pull request from a fork must never run on the
// self-hosted Mac, and the hosted Linux job must skip the screenshot comparisons, whose baselines are
// macOS and Chromium: so every comparison sits in a test tagged `@pixels`.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const E2E = join(ROOT, 'test/e2e')

describe('the screenshot comparisons (R2-1)', () => {
  const specs = readdirSync(E2E).filter((name) => name.endsWith('.spec.ts'))

  test('there are specs to check', () => {
    expect(specs.length).toBeGreaterThan(10)
  })

  test.each(specs)('every comparison in %s is in a test tagged @pixels', (name) => {
    const source = readFileSync(join(E2E, name), 'utf8')
    for (const match of source.matchAll(/toHaveScreenshot\(|toMatchSnapshot\(/g)) {
      const at = match.index as number
      const starts = [...source.slice(0, at).matchAll(/\btest\(/g)]
      const start = starts[starts.length - 1]?.index
      expect(start, `${name}: a comparison at ${at} outside any test()`).toBeDefined()
      const head = source.slice(start as number, source.indexOf('async', start as number))
      expect(head, `${name}: the test holding the comparison at ${at}`).toContain('@pixels')
    }
  })
})
