// The installed entry (src/bin.ts) must settle NO_COLOR and FORCE_COLOR before any Node built-in is
// loaded: Node warns about the pair while it loads node:util, node:http or node:assert, earlier than any
// other code could stop it. So bin.ts statically imports only color-env.ts, which imports nothing, and
// reaches the program through a dynamic import that comes after the settling.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const IMPORT = /^import\s+(?!type\b)(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm
const REEXPORT = /^export\s+(?!type\b)[^'"=]*?\bfrom\s+['"]([^'"]+)['"]/gm

const source = (file: string): string => readFileSync(join(ROOT, file), 'utf8')
const specifiers = (text: string): string[] => [...text.matchAll(IMPORT), ...text.matchAll(REEXPORT)].map((m) => m[1] as string)

describe('the entry imports nothing before the colour variables are settled', () => {
  test("bin.ts's only static import is color-env.ts", () => {
    expect(specifiers(source('src/bin.ts'))).toEqual(['./color-env.js'])
  })

  test('color-env.ts imports nothing at all', () => {
    const text = source('src/color-env.ts')
    expect(specifiers(text)).toEqual([])
    expect(text).not.toMatch(/\bimport\s*\(/)
    expect(text).not.toMatch(/\brequire\s*\(/)
  })

  test('bin.ts settles first, then imports the program', () => {
    const text = source('src/bin.ts')
    const settle = text.indexOf('settleColorEnv(process.env)')
    const program = text.indexOf("import('./cli.js')")
    expect(settle).toBeGreaterThan(0)
    expect(program).toBeGreaterThan(settle)
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
})
