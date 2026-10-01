// No file writes an escape byte unless it is one of the three that must: line.ts builds colour,
// cells.ts strips sequences, terminal.ts has the five fixed control sequences. Anything else that
// mentions one is a place text could end up inside an escape sequence.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ALLOWED = new Set(['src/core/tui/line.ts', 'src/core/tui/cells.ts', 'src/tui/terminal.ts'])
const ESCAPE_BYTE = /\\x1b|\\u001b|\\u\{1b\}|\\x9b|\\u009b|\\u\{9b\}|\\033|\\e\[/i

function sources(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('escape bytes in the terminal mode\'s sources', () => {
  const files = [...sources(join(ROOT, 'src/core/tui')), ...sources(join(ROOT, 'src/tui'))]

  test('there are sources to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  test.each(files.map((file) => relative(ROOT, file)))('%s', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8')
    if (ALLOWED.has(file)) return
    expect(text).not.toMatch(ESCAPE_BYTE)
  })

  test('no source holds a raw control character', () => {
    for (const file of files) {
      // eslint-disable-next-line no-control-regex
      expect(readFileSync(file, 'utf8')).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
    }
  })
})
