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
  { finding: 'R3-1', phrase: 'A pull request from a fork never runs there' },
  // The cold review's "claims the code does not keep" (C3, C4, C5, C8): each said more than the code did.
  { finding: 'C3', phrase: 'the events file and any error text name your home directory as `~`' },
  { finding: 'C3', phrase: 'File paths are never shown in full' },
  { finding: 'C3', phrase: 'File paths are shown as basenames only; there is no `--full-paths` flag yet' },
  { finding: 'C8', phrase: 'a value from a fixed enum, or a reduced target (a file' },
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
  { finding: 'R3-3', file: 'SECURITY', phrase: 'any C1 character (U+0080 to U+009F) and any Unicode format character (`\\p{Cf}`' },
  { finding: 'R3-3', file: 'SECURITY', phrase: 'a name that fails it is shown as `unknown-tool`) and is capped at 100 characters' },
  { finding: 'R3-2', file: 'SECURITY', phrase: 'a `bin/package.json` that is not exactly what `on` writes' },
  { finding: 'R3-2', file: 'README', phrase: '`hooks on` also refuses a `bin/package.json` that is not the one it writes' },
  { finding: 'R3-1', file: 'README', phrase: 'the workflow selects that runner for no run at all' },
  { finding: 'R3-4', file: 'README', phrase: 'an actor that is not Dependabot' },
  { finding: 'R3-1', file: 'README', phrase: 'Require approval for all external contributors' },
  { finding: 'R3-1', file: 'README', phrase: 'the self-hosted runner removed from the repository when it goes public' },
  { finding: 'R3-1', file: 'README', phrase: '`npm run test:e2e` on a Mac, before merging' },
  { finding: 'C1', file: 'SECURITY', phrase: 'refuses, on `hooks on`, a state directory that is not an absolute path' },
  { finding: 'C1', file: 'README', phrase: 'The state directory must be an absolute path.' },
  { finding: 'C3', file: 'SECURITY', phrase: 'the reason is built from reduced paths and `publicWorld` reduces it again' },
  { finding: 'C3', file: 'README', phrase: 'The folders the sources read (the transcripts folder, the events file) are named with your home directory as `~`' },
  { finding: 'C4', file: 'SECURITY', phrase: 'A name, which becomes an agent\'s label, is kept only if it passes the label rule above' },
  { finding: 'C5', file: 'SECURITY', phrase: 'every field of a line that is read is checked again with the collector\'s own matchers' },
  { finding: 'C7', file: 'SECURITY', phrase: 'the hook source first reads what was appended to the old file after its last poll' },
  { finding: 'C7', file: 'README', phrase: 'the lines appended to the old one after the last poll are read before the new file is followed' },
  { finding: 'C8', file: 'SECURITY', phrase: 'The working directory is the one full absolute path the collector keeps' },
]

describe('documentation claims the code does not make (R2-2, R2-4, R2-6, R2-7, R2-12, C3, C5, C8)', () => {
  test.each(OVERCLAIMS)('$finding: "$phrase" is gone', ({ phrase }) => {
    expect(README.includes(phrase), 'README.md holds the overclaim').toBe(false)
    expect(SECURITY.includes(phrase), 'SECURITY.md holds the overclaim').toBe(false)
  })

  test.each(STATEMENTS)('$finding: $file says "$phrase"', ({ file, phrase }) => {
    expect((file === 'README' ? README : SECURITY).includes(phrase), `${file}.md lacks the sentence`).toBe(true)
  })
})
