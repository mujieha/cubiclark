// The collector's import graph is its start-up budget (PLAN.md phase 2 §1.1): three files, node:
// builtins only, no dynamic imports. This test fails if someone adds a dependency to any of them.

import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FILES = ['src/hook/collector.ts', 'src/core/hooks/whitelist.ts', 'src/core/transcript/tools.ts']

// `import x from 'y'` and `import 'y'`, plus `export ... from 'y'`, all skipping `import type`
// and `export type`. The no-quote gap keeps a match from running across statements, and the
// re-export pattern refuses `=` so an `export const x = 'text'` is never mistaken for one.
const IMPORT = /^import\s+(?!type\b)(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm
const REEXPORT = /^export\s+(?!type\b)[^'"=]*?\bfrom\s+['"]([^'"]+)['"]/gm

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT), ...source.matchAll(REEXPORT)].map((m) => m[1] as string)
}

describe('the collector import graph', () => {
  test('finds the imports it should (guards the regex itself)', () => {
    const found = specifiers(readFileSync(join(ROOT, 'src/hook/collector.ts'), 'utf8'))
    expect(found).toContain('node:fs')
    expect(found).toContain('../core/hooks/whitelist.js')
  })

  for (const file of FILES) {
    test(`${file} imports only node: builtins and the other collector files`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const spec of specifiers(source)) {
        if (spec.startsWith('.')) {
          const target = relative(ROOT, join(ROOT, dirname(file), spec)).replace(/\.js$/, '.ts')
          expect(FILES, `${file} imports ${spec}`).toContain(target)
        } else {
          expect(spec.startsWith('node:'), `${file} imports ${spec}`).toBe(true)
        }
      }
    })

    test(`${file} has no dynamic import or require`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      expect(source).not.toMatch(/\bimport\s*\(/)
      expect(source).not.toMatch(/\brequire\s*\(/)
    })
  }
})
