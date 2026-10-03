// Serves the fixture day (test/fixtures/day/) through the real built CLI. It runs on a copy: the
// day's config names the stand-in claude beside it (../../bin/claude), so `bin/` comes along, and
// the config file is made ours alone (config.json is refused as a source of programs when others
// can write it, and a checkout's umask is not ours to know).

import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DAY_HELPER, DAY_SESSIONS } from '../../scripts/day-fixture-lib.js'
import { runCli, type RunningCli } from './helpers.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const EVIDENCE_DIR = fileURLToPath(new URL('../../test-results/day/', import.meta.url))

export const S = DAY_SESSIONS
export { DAY_HELPER }

export interface DayCli extends RunningCli {
  /** The copy the CLI is serving, for tests that edit it. */
  dir: string
}

/** Starts `cubiclark` over a copy of the day. `args` are added to the fixture-home flags. */
export async function startDay(args: string[] = [], command: string[] = []): Promise<DayCli> {
  const root = await mkdtemp(join(tmpdir(), 'cubiclark-e2e-day-'))
  await cp(join(FIXTURES, 'day'), join(root, 'day'), { recursive: true })
  await cp(join(FIXTURES, 'bin'), join(root, 'bin'), { recursive: true })
  await chmod(join(root, 'day', 'state', 'config.json'), 0o600)
  // runCli kills its own child when the start fails; the copy goes with it.
  const cli = await runCli([...command, '--fixture-home', join(root, 'day', 'home'), '--state-dir', join(root, 'day', 'state'), '--no-open', '--port', '0', ...args]).catch(async (err: unknown) => {
    await rm(root, { recursive: true, force: true })
    throw err
  })
  return {
    ...cli,
    dir: join(root, 'day'),
    stop: async () => {
      await cli.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Writes a screenshot where the operator can look at it: test-results/day/<name>.png (gitignored). */
export async function saveDayEvidence(name: string, png: Buffer): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await writeFile(join(EVIDENCE_DIR, `${name}.png`), png)
}
