import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TRANSCRIPTS_DIR = join(REPO_ROOT, 'test/fixtures/transcripts')
const HOME_DIR = join(REPO_ROOT, 'test/fixtures/home')

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else out.push(full)
  }
  return out
}

describe('make-fixtures.ts', () => {
  test('the generator is idempotent: --check reports the checked-in files as up to date', () => {
    // If this fails, someone hand-edited a fixture file or the generator's output changed
    // without regenerating: run `npm run fixtures` and commit the result.
    expect(() =>
      execFileSync('node', ['--import', 'tsx', 'scripts/make-fixtures.ts', '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      })
    ).not.toThrow()
  })

  test('every transcript .jsonl line is valid JSON, except the one deliberately truncated line', async () => {
    const files = (await listFiles(TRANSCRIPTS_DIR)).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    let truncatedLinesSeen = 0
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      const lines = text.split('\n').filter((l) => l.length > 0)
      for (const line of lines) {
        try {
          JSON.parse(line)
        } catch {
          truncatedLinesSeen += 1
        }
      }
    }
    // Exactly the one line in malformed.jsonl that scripts/fixture-lib.ts writes as `{ raw }`.
    expect(truncatedLinesSeen).toBe(1)
  })

  test('every .meta.json file is a single valid JSON object', async () => {
    const files = (await listFiles(TRANSCRIPTS_DIR)).filter((f) => f.endsWith('.meta.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const value = JSON.parse(await readFile(file, 'utf8')) as unknown
      expect(typeof value).toBe('object')
    }
  })

  test('the home world has files for exactly five agents', async () => {
    const files = await listFiles(HOME_DIR)
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))
    // main session + background worker + explore parent + explore subagent + shop session
    expect(jsonlFiles).toHaveLength(5)
  })
})
