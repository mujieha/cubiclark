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
  { finding: 'R2-4', phrase: 'so a line is never wider than the terminal' },
  { finding: 'R2-6', phrase: 'the cookie never leaves the browser' },
  { finding: 'R2-7', phrase: 'so a long or hostile string cannot grow the page' },
  { finding: 'R2-12', phrase: "the cookie's value and its name are compared" },
  { finding: 'R2-12', phrase: 'and any other `ESC` plus one character' },
]

/** Phrases that must appear: what the code does, said as it does it. */
const STATEMENTS: readonly { finding: string; file: 'README' | 'SECURITY'; phrase: string }[] = [
  { finding: 'R2-2', file: 'SECURITY', phrase: 'only the files `hooks on` placed' },
  { finding: 'R2-2', file: 'SECURITY', phrase: 'only when it is empty' },
  { finding: 'R2-2', file: 'README', phrase: 'only the files `hooks on` placed' },
  { finding: 'R2-4', file: 'SECURITY', phrase: 'line wrapping (autowrap) is switched off' },
  { finding: 'R2-4', file: 'SECURITY', phrase: 'Unicode 18.0.0' },
  { finding: 'R2-4', file: 'README', phrase: 'text-presentation emoji' },
  { finding: 'R2-6', file: 'SECURITY', phrase: 'The session cookie is sent to every server on `127.0.0.1`' },
  { finding: 'R2-6', file: 'SECURITY', phrase: 'RFC 6265 §8.5' },
  { finding: 'R2-6', file: 'SECURITY', phrase: '`<random>.localhost`' },
  { finding: 'R2-6', file: 'README', phrase: 'the session cookie is sent to every server on `127.0.0.1`' },
  { finding: 'R2-7', file: 'SECURITY', phrase: 'at most 100 characters with no control character and no `/` or `\\`' },
  { finding: 'R2-12', file: 'SECURITY', phrase: "The code and the cookie's value are compared with a timing-safe check" },
  { finding: 'R2-12', file: 'SECURITY', phrase: '`ESC` followed by any character from `@` to `_`' },
  { finding: 'R2-12', file: 'SECURITY', phrase: 'the character after it stays as text' },
]

describe('documentation claims the code does not make (R2-2, R2-4, R2-6, R2-7, R2-12)', () => {
  test.each(OVERCLAIMS)('$finding: "$phrase" is gone', ({ phrase }) => {
    expect(README.includes(phrase), 'README.md holds the overclaim').toBe(false)
    expect(SECURITY.includes(phrase), 'SECURITY.md holds the overclaim').toBe(false)
  })

  test.each(STATEMENTS)('$finding: $file says "$phrase"', ({ file, phrase }) => {
    expect((file === 'README' ? README : SECURITY).includes(phrase), `${file}.md lacks the sentence`).toBe(true)
  })
})
