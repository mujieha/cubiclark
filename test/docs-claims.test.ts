// Round 2 of the security review found sentences in README.md and SECURITY.md that said more than the
// code does. Each overclaim is listed here, so it cannot come back in the same words.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const collapse = (text: string): string => text.replace(/\s+/g, ' ')
const README = collapse(readFileSync(`${ROOT}README.md`, 'utf8'))
const SECURITY = collapse(readFileSync(`${ROOT}SECURITY.md`, 'utf8'))

/** Phrases that must not appear; the findings they came from are named. */
const OVERCLAIMS: readonly { finding: string; phrase: string }[] = [
  { finding: 'R2-2', phrase: '`--purge` never deletes anything else in that directory' },
  { finding: 'R2-2', phrase: 'flag, `bin/`, `install.json`)' },
]

/** Phrases that must appear: what the code does, said as it does it. */
const STATEMENTS: readonly { finding: string; file: 'README' | 'SECURITY'; phrase: string }[] = [
  { finding: 'R2-2', file: 'SECURITY', phrase: 'only the files `hooks on` placed' },
  { finding: 'R2-2', file: 'SECURITY', phrase: 'only when it is empty' },
  { finding: 'R2-2', file: 'README', phrase: 'only the files `hooks on` placed' },
]

describe('documentation claims the code does not make (R2-2, R2-4, R2-6, R2-7, R2-12)', () => {
  test.each(OVERCLAIMS)('$finding: "$phrase" is gone', ({ phrase }) => {
    expect(README.includes(phrase), 'README.md holds the overclaim').toBe(false)
    expect(SECURITY.includes(phrase), 'SECURITY.md holds the overclaim').toBe(false)
  })

  test.each(STATEMENTS)('$finding: $file.md says "$phrase"', ({ file, phrase }) => {
    expect((file === 'README' ? README : SECURITY).includes(phrase), `${file}.md lacks the sentence`).toBe(true)
  })
})
