// Checks what `npm publish` would upload: the file list of the tarball (the top-level documents and
// dist/, nothing else) and the text of every file (no home path, no user name, no session id).
//
//   check-tarball.ts [<file.tgz>] [--dir <package dir>]
//     <file.tgz>   check this tarball
//     --dir <dir>  run `npm pack` in <dir> and check what it makes (default: the current directory)
//   exit 0: clean; exit 1: any problem (each is printed); exit 2: usage or a pack error
//
// `npm run check:tarball` runs it, `prepublishOnly` runs it before every publish, and
// test/hooks/tarball.test.ts runs it against a fresh `npm pack`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { localNames } from './local-names.js'

/** The files that sit at the top of the package, beside dist/. */
export const TOP_LEVEL_FILES: readonly string[] = ['LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json']

/** Files that must be in the tarball: the documents, the command, the collector and the page. */
export const REQUIRED_FILES: readonly string[] = [
  ...TOP_LEVEL_FILES,
  'dist/bin.js',
  'dist/cli.js',
  'dist/hook/collector.js',
  'dist/client/index.html',
]

/** Problems with the list of paths inside `package/` (posix separators). */
export function fileListProblems(paths: readonly string[]): string[] {
  const problems: string[] = []
  for (const path of paths) {
    if (!TOP_LEVEL_FILES.includes(path) && !path.startsWith('dist/')) problems.push(`unexpected file: ${path}`)
  }
  for (const required of REQUIRED_FILES) {
    if (!paths.includes(required)) problems.push(`missing file: ${required}`)
  }
  return problems
}

export interface Hit {
  file: string
  pattern: string
  line: number
  /** At most 80 characters around the match. */
  excerpt: string
}

const FORBIDDEN: readonly { name: string; re: RegExp }[] = [
  { name: '/Users/', re: /\/Users\//i },
  { name: '\\Users\\', re: /\\{1,2}Users\\/i },
  { name: '/home/', re: /\/home\//i },
  { name: 'mujieha', re: /mujieha/i },
  { name: 'rufornyi', re: /rufornyi/i },
  { name: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'Claude-Session', re: /Claude-Session/i },
  // this machine's account name, derived so that this file does not name it
  ...localNames().map((word) => ({ name: word, re: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })),
]

/** The public repository's address and the page about the app: named in the documents and in package.json's
 * URLs, nowhere else. */
const PUBLIC_REPO = 'github.com/mujieha/cubiclark'
const PUBLIC_SITE = 'cubiclark.mujieha.com'
const DOCUMENTS: readonly string[] = ['README.md', 'SECURITY.md', 'CHANGELOG.md']
const PACKAGE_URL_KEYS: readonly string[] = ['repository', 'homepage', 'bugs']
const COPYRIGHT_LINE = /^Copyright \(c\) \d{4} \S.*$/

function excerptAround(line: string, index: number): string {
  const start = Math.max(0, index - 30)
  return line.slice(start, start + 80)
}

/** Every forbidden string in one file's text, after the allow list has been applied. `file` is the
 * path inside `package/`. Nothing is allowed under dist/. */
export function scanText(file: string, text: string): Hit[] {
  let body = text
  if (file === 'package.json') {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      const kept = Object.entries(parsed as Record<string, unknown>).filter(([key]) => !PACKAGE_URL_KEYS.includes(key))
      body = JSON.stringify(Object.fromEntries(kept), null, 2)
    } catch {
      return [{ file, pattern: 'json', line: 1, excerpt: 'package.json does not parse' }]
    }
  } else if (file === 'LICENSE') {
    body = text
      .split('\n')
      .map((line) => (COPYRIGHT_LINE.test(line) ? '' : line))
      .join('\n')
  } else if (DOCUMENTS.includes(file)) {
    body = text.split(PUBLIC_REPO).join('github.com/OWNER/cubiclark').split(PUBLIC_SITE).join('cubiclark.example.com')
  }

  const hits: Hit[] = []
  const lines = body.split('\n')
  lines.forEach((line, i) => {
    for (const { name, re } of FORBIDDEN) {
      const match = re.exec(line)
      if (match) hits.push({ file, pattern: name, line: i + 1, excerpt: excerptAround(line, match.index) })
    }
  })
  return hits
}

/** Every file under `dir`, as a posix path relative to it, sorted. */
function listFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return found.sort()
}

export interface CheckResult {
  files: string[]
  problems: string[]
  hits: Hit[]
}

/** Checks an unpacked package folder (the `package/` of an extracted tarball). */
export function checkPackageDir(dir: string): CheckResult {
  const files = listFiles(dir)
  const hits = files.flatMap((file) => scanText(file, readFileSync(join(dir, file), 'utf8')))
  return { files, problems: fileListProblems(files), hits }
}

function usage(message: string): never {
  process.stderr.write(`${message}\nusage: check-tarball.ts [<file.tgz>] [--dir <package dir>]\n`)
  process.exit(2)
}

function parseArgs(argv: string[]): { tarball?: string; dir: string } {
  let tarball: string | undefined
  let dir = process.cwd()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--dir') {
      const value = argv[++i]
      if (value === undefined) usage('--dir needs a folder')
      dir = value
    } else if (arg.startsWith('-')) usage(`unknown option ${arg}`)
    else if (tarball === undefined) tarball = arg
    else usage('only one tarball may be given')
  }
  return tarball === undefined ? { dir } : { tarball, dir }
}

function main(argv: string[]): number {
  const args = parseArgs(argv)
  const work = mkdtempSync(join(tmpdir(), 'cubiclark-tarball-'))
  try {
    let tarball = args.tarball
    if (tarball === undefined) {
      const packed = join(work, 'packed')
      mkdirSync(packed)
      // --dry-run=false: `npm publish --dry-run` puts dry-run into the environment of prepublishOnly.
      const out = execFileSync('npm', ['pack', '--json', '--dry-run=false', '--pack-destination', packed], {
        cwd: args.dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      const filename = (JSON.parse(out) as { filename?: string }[])[0]?.filename
      if (filename === undefined) throw new Error('npm pack named no file')
      tarball = join(packed, filename)
    }
    const unpacked = join(work, 'unpacked')
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', tarball, '-C', unpacked])
    const result = checkPackageDir(join(unpacked, 'package'))

    console.log(`files (${result.files.length}):`)
    for (const file of result.files) console.log(`  ${file}`)
    for (const problem of result.problems) console.log(`problem: ${problem}`)
    for (const hit of result.hits) console.log(`hit: ${hit.file}:${hit.line} [${hit.pattern}] ${hit.excerpt}`)
    const count = result.problems.length + result.hits.length
    console.log(count === 0 ? 'tarball check: clean' : `tarball check: ${count} problem(s)`)
    return count === 0 ? 0 : 1
  } catch (err) {
    process.stderr.write(`check-tarball: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) process.exit(main(process.argv.slice(2)))
