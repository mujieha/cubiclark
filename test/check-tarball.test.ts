// The tarball check's two pure parts: which files may be in the package, and which strings may be in
// them. (test/hooks/tarball.test.ts runs the whole script against a real `npm pack`.)

import { describe, expect, test } from 'vitest'
import { REQUIRED_FILES, fileListProblems, scanText } from '../scripts/check-tarball.js'

const CLEAN_LIST = [...REQUIRED_FILES, 'dist/core/reducer.js']
const REPO = 'github.com/mujieha/cubiclark'

describe('fileListProblems', () => {
  test('a package with the documents and a build has no problem', () => {
    expect(fileListProblems(CLEAN_LIST)).toEqual([])
  })

  test.each(['test/x.test.ts', 'tmp/a', 'src/cli.ts', 'docs/media/x.gif', 'node_modules/x', 'package-lock.json'])(
    '%s is not allowed',
    (path) => {
      expect(fileListProblems([...CLEAN_LIST, path])).toEqual([`unexpected file: ${path}`])
    },
  )

  test.each(['CHANGELOG.md', 'dist/bin.js', 'dist/hook/collector.js', 'dist/client/index.html', 'LICENSE'])(
    'a package without %s is refused',
    (path) => {
      expect(fileListProblems(CLEAN_LIST.filter((p) => p !== path))).toEqual([`missing file: ${path}`])
    },
  )
})

describe('scanText', () => {
  test.each([
    ['a unix home path', 'see /Users/someone/x', '/Users/'],
    ['a Windows home path', 'C:\\Users\\someone\\x', '\\Users\\'],
    ['an escaped Windows home path', 'C:\\\\Users\\\\someone', '\\Users\\'],
    ['a linux home path', 'cd /home/someone', '/home/'],
    ['a user name', 'by Nobody', 'nobody'],
    ['the organisation', 'owner MUJIEHA', 'mujieha'],
    ['the author name', 'Rufornyi', 'rufornyi'],
    ['an upper-case UUID', 'id ABCDEF01-2345-6789-ABCD-EF0123456789', 'uuid'],
    // assembled, so that this file is not itself a commit trailer to the hygiene check
    ['a session trailer', ['Claude-Sess', 'ion: x'].join(''), 'Claude-Session'],
  ])('finds %s in the README', (_name, text, pattern) => {
    const hits = scanText('README.md', `first line\n${text}\nlast line`)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ file: 'README.md', pattern, line: 2 })
    expect(hits[0]?.excerpt.length).toBeLessThanOrEqual(80)
  })

  test('a long line gives an excerpt around the match, not the whole line', () => {
    const hits = scanText('dist/client/a.js', `${'x'.repeat(500)}/home/someone${'y'.repeat(500)}`)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.excerpt).toContain('/home/')
    expect(hits[0]?.excerpt.length).toBeLessThanOrEqual(80)
  })

  test('a clean text has no hit', () => {
    expect(scanText('README.md', '# Cubiclark\n\nnpx cubiclark\n')).toEqual([])
  })

  test('the public repository address is allowed in the documents, and nothing else of the organisation is', () => {
    for (const file of ['README.md', 'SECURITY.md', 'CHANGELOG.md']) {
      expect(scanText(file, `see https://${REPO}/issues`), file).toEqual([])
    }
    expect(scanText('README.md', 'see https://mujieha.com/apps')).toHaveLength(1)
    expect(scanText('README.md', 'see https://github.com/mujieha/other')).toHaveLength(1)
  })

  test('nothing is allowed under dist/', () => {
    expect(scanText('dist/a.js', `// ${REPO}`)).toHaveLength(1)
    expect(scanText('dist/a.js', '/* /Users/someone/x */')).toHaveLength(1)
  })

  test('package.json may name the repository, the home page and the issue tracker, and nothing else', () => {
    const urls = {
      repository: { type: 'git', url: `git+https://${REPO}.git` },
      homepage: `https://${REPO}#readme`,
      bugs: { url: `https://${REPO}/issues` },
    }
    expect(scanText('package.json', JSON.stringify({ name: 'cubiclark', ...urls }, null, 2))).toEqual([])
    const withAuthor = scanText('package.json', JSON.stringify({ name: 'cubiclark', author: 'mujieha', ...urls }, null, 2))
    expect(withAuthor).toHaveLength(1)
    expect(withAuthor[0]?.pattern).toBe('mujieha')
  })

  test('a package.json that does not parse is a hit', () => {
    expect(scanText('package.json', '{ not json')).toEqual([
      { file: 'package.json', pattern: 'json', line: 1, excerpt: 'package.json does not parse' },
    ])
  })

  test('the licence may name its author on the copyright line only', () => {
    const copyright = 'Copyright (c) 2026 Some Author Rufornyi'
    expect(scanText('LICENSE', `MIT License\n\n${copyright}\n\nPermission is hereby granted`)).toEqual([])
    const elsewhere = scanText('LICENSE', `MIT License\n\n${copyright}\n\nwritten by Rufornyi`)
    expect(elsewhere).toHaveLength(1)
    expect(elsewhere[0]).toMatchObject({ pattern: 'rufornyi', line: 5 })
  })
})
