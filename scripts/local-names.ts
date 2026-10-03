// The word that would identify this machine's account if it turned up in a published file or a
// fixture: derived from the environment at run time, so that no checked-in list has to spell it
// out. scripts/check-tarball.ts and test/personal-data.test.ts both use it. Only the account name
// is used, never the home path: tests run under a temporary home whose path segments are noise.

import { userInfo } from 'node:os'

/** Account names that CI machines and containers use; they are nobody's. */
const GENERIC = new Set<string>([
  'root', 'user', 'admin', 'runner', 'ubuntu', 'debian', 'build', 'node', 'actions', 'github',
  'jenkins', 'docker', 'vagrant', 'ec2-user', 'circleci', 'travis', 'buildkite', 'gitlab-runner',
])

export interface LocalNamesInput {
  username?: string
}

/** The account name, lower-cased, when it is at least four characters and not a generic one.
 * Empty on a CI runner, which is the point: those names are not personal. */
export function localNames(input: LocalNamesInput = {}): string[] {
  let username = input.username
  if (username === undefined) {
    try {
      username = userInfo().username
    } catch {
      username = ''
    }
  }
  const w = username.toLowerCase()
  return w.length >= 4 && !GENERIC.has(w) ? [w] : []
}
