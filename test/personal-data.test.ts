// Proves that every file under test/fixtures/ is safe to publish: no real path, e-mail, machine
// name or session id from this Mac, and no prose that was not built from the fixed lorem word
// list in scripts/fixture-lib.ts (so no prompt text copied from a real session). This is the
// guard scripts/make-fixtures.ts and TASK.md both point to.

import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { LOREM_WORDS } from '../scripts/fixture-lib.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES_DIR = join(REPO_ROOT, 'test/fixtures')
const LOREM_SET = new Set<string>(LOREM_WORDS)

// Text this module deliberately writes that is not prose built from LOREM_WORDS: protocol
// markers and short, invented error strings a real parser needs to recognize by their exact
// wording. Each one is reviewed here, by hand, for anything that could be mistaken for content
// copied from a real session — none of them is.
const ALLOWED_LITERALS = new Set<string>([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  'API Error: rate limit exceeded, please retry later',
  'API Error: invalid request: missing required field',
])

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else out.push(full)
  }
  return out
}

function checkLoremText(value: string, path: string, violations: string[]): void {
  if (ALLOWED_LITERALS.has(value)) return
  const words = value
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  for (const word of words) {
    if (!LOREM_SET.has(word)) {
      violations.push(`${path}: "${value}" has a word not in the lorem list: "${word}"`)
      return
    }
  }
}

/** Walks every string in a parsed fixture record and checks the fields that are meant to hold
 * only invented prose (prompt text, thinking, description, visible text, ai-title) against the
 * lorem word list. Field names not in this set (tool names, commands, file paths, model ids,
 * permission modes, ...) are deliberately realistic and are not prose, so they are skipped. */
function walkForLorem(value: unknown, path: string, violations: string[]): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkForLorem(v, `${path}[${i}]`, violations))
    return
  }
  if (typeof value !== 'object') return
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const isProseField = key === 'thinking' || key === 'description' || key === 'text' || key === 'aiTitle'
    if (isProseField && typeof v === 'string') {
      checkLoremText(v, `${path}.${key}`, violations)
    } else if (key === 'content' && typeof v === 'string' && typeof (value as Record<string, unknown>).role === 'string') {
      // message.content as a bare string, on the object that also has a role, is a prompt.
      // A tool_result block's own `content` field is not prose (it is tool output text), and
      // has no `role` sibling, so it is skipped here.
      checkLoremText(v, `${path}.${key}`, violations)
    } else {
      walkForLorem(v, `${path}.${key}`, violations)
    }
  }
}

describe('personal-data guard over test/fixtures/', () => {
  test('no file contains a real filesystem path', async () => {
    const violations: string[] = []
    for (const file of await listFiles(FIXTURES_DIR)) {
      const text = await readFile(file, 'utf8')
      const rel = relative(REPO_ROOT, file)
      if (/\/Users\//.test(text)) violations.push(`${rel}: contains /Users/`)
      // /home/ is allowed only as the invented /home/user/projects/... fixture cwd.
      if (/\/home\/(?!user\/projects\/)/.test(text)) violations.push(`${rel}: contains a /home/ path outside /home/user/projects/`)
    }
    expect(violations).toEqual([])
  })

  test('no file contains an e-mail address', async () => {
    const violations: string[] = []
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
    for (const file of await listFiles(FIXTURES_DIR)) {
      const text = await readFile(file, 'utf8')
      const match = emailPattern.exec(text)
      if (match) violations.push(`${relative(REPO_ROOT, file)}: contains "${match[0]}"`)
    }
    expect(violations).toEqual([])
  })

  test('no file names this machine, its account, this project family or a .local hostname', async () => {
    const violations: string[] = []
    const forbidden = ['nobody', 'rufornyi', 'mujieha', 'orca', 'ideaprojects']
    for (const file of await listFiles(FIXTURES_DIR)) {
      const text = (await readFile(file, 'utf8')).toLowerCase()
      for (const word of forbidden) {
        if (text.includes(word)) violations.push(`${relative(REPO_ROOT, file)}: contains "${word}"`)
      }
      if (/\.local\b/.test(text)) violations.push(`${relative(REPO_ROOT, file)}: contains a .local hostname`)
    }
    expect(violations).toEqual([])
  })

  test('every UUID-shaped value matches the invented family, never a real session id', async () => {
    const violations: string[] = []
    const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
    const invented = /^00000000-0000-4000-8000-[0-9a-f]{12}$/i
    for (const file of await listFiles(FIXTURES_DIR)) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(uuidPattern)) {
        if (!invented.test(match[0])) {
          violations.push(`${relative(REPO_ROOT, file)}: uuid "${match[0]}" is not in the invented family`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('every tool_use id and subagent id carries the fx marker', async () => {
    const violations: string[] = []
    const toolUsePattern = /\btoolu_[A-Za-z0-9_-]+/g
    const subagentIdPattern = /\bfx[0-9a-f]{15}\b/i
    for (const file of await listFiles(FIXTURES_DIR)) {
      const text = await readFile(file, 'utf8')
      const rel = relative(REPO_ROOT, file)
      for (const match of text.matchAll(toolUsePattern)) {
        if (!match[0].startsWith('toolu_fx')) violations.push(`${rel}: tool_use id "${match[0]}" has no fx marker`)
      }
      if (/"agentId"\s*:\s*"([^"]+)"/.test(text)) {
        const agentIdMatch = /"agentId"\s*:\s*"([^"]+)"/.exec(text)
        const value = agentIdMatch?.[1] ?? ''
        if (!subagentIdPattern.test(value)) violations.push(`${rel}: agentId "${value}" has no fx marker`)
      }
    }
    // Subagent directories and files are also named agent-fx<15 hex>.*
    for (const file of await listFiles(FIXTURES_DIR)) {
      const rel = relative(REPO_ROOT, file)
      if (rel.includes('subagents/')) {
        const base = file.split('/').pop() ?? ''
        if (!/^agent-fx[0-9a-f]{15}\.(jsonl|meta\.json)$/i.test(base)) {
          violations.push(`${rel}: subagent file name does not carry the fx marker`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('every prompt, thinking, description and visible-text string uses only the lorem vocabulary', async () => {
    const violations: string[] = []
    for (const file of await listFiles(FIXTURES_DIR)) {
      if (!file.endsWith('.jsonl') && !file.endsWith('.meta.json')) continue
      const text = await readFile(file, 'utf8')
      const rel = relative(REPO_ROOT, file)
      const lines = file.endsWith('.meta.json') ? [text] : text.split('\n').filter((l) => l.length > 0)
      for (const line of lines) {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue // the one deliberately truncated line in malformed.jsonl; not prose to check
        }
        walkForLorem(value, rel, violations)
      }
    }
    expect(violations).toEqual([])
  })
})
