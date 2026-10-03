// After the e2e run: no server the tests spawned may still be running. helpers.ts writes each child's pid
// to tmp/e2e-pids/ and deletes it when the child exits, so a file left here names a server that outlived
// its test. A live one that is really `dist/cli.js` (not a pid the system has handed to something else)
// is killed now, and the run fails so the leak is fixed rather than hidden.

import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PID_DIR } from './helpers.js'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: gone. EPERM: it exists but is not ours, so it is not one of our servers either.
    return false
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

export default function globalTeardown(): void {
  let names: string[]
  try {
    names = readdirSync(PID_DIR)
  } catch {
    return
  }
  const leaked: number[] = []
  for (const name of names) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (alive(pid) && commandOf(pid).includes('dist/cli.js')) {
      process.kill(pid, 'SIGKILL')
      leaked.push(pid)
    }
    rmSync(join(PID_DIR, name), { force: true })
  }
  if (leaked.length > 0) {
    throw new Error(`e2e left ${leaked.length} cubiclark server(s) running: ${leaked.join(', ')} (killed now)`)
  }
}
