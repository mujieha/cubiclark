// The words that would identify this machine's account if they turned up in a published file or a
// fixture: derived from the environment at run time, so that no checked-in list has to spell them
// out. scripts/check-tarball.ts and test/personal-data.test.ts both use it.

import { homedir, userInfo } from 'node:os'

/** Account and directory names that CI machines and containers use; they are nobody's. */
const GENERIC = new Set<string>([
  'root', 'user', 'users', 'home', 'admin', 'runner', 'ubuntu', 'debian', 'build', 'node', 'work',
  'actions', 'github', 'jenkins', 'docker', 'vagrant', 'ec2-user', 'circleci', 'travis', 'buildkite',
  'gitlab-runner', 'volumes', 'private', 'tmp', 'var', 'opt', 'mnt', 'data',
])

export interface LocalNamesInput {
  username?: string
  home?: string
}

/** Lower-case words, each at least four characters and not a generic name: the account name and
 * every segment of the home directory's path. Empty when the account is a generic one on a generic
 * path (a CI runner), which is the point: those names are not personal. */
export function localNames(input: LocalNamesInput = {}): string[] {
  let username = input.username
  if (username === undefined) {
    try {
      username = userInfo().username
    } catch {
      username = ''
    }
  }
  const home = input.home ?? homedir()
  const out = new Set<string>()
  for (const word of [username, ...home.split(/[\\/]/)]) {
    const w = word.toLowerCase()
    if (w.length >= 4 && !GENERIC.has(w)) out.add(w)
  }
  return [...out]
}
