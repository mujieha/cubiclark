// `cubiclark replay` on a port that is taken, through the real built CLI (R2-11). startReplay started the
// store, the step and status timers and the adapter host before it listened, and did not stop them when
// listen failed, so the message was printed and the process then never exited. Never the real ~/.claude.

import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))
const DAY_HOME = fileURLToPath(new URL('../fixtures/day/home', import.meta.url))

let blocker: Server | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()))
  blocker = undefined
})

describe('cubiclark replay on a port that is already in use', () => {
  test('says so and exits 1, instead of printing it and then never exiting', async () => {
    blocker = createServer()
    await new Promise<void>((resolve) => blocker?.listen(0, '127.0.0.1', () => resolve()))
    const port = (blocker?.address() as { port: number }).port

    // spawnSync blocks this process, so the blocker above only holds the port: it needs no event loop.
    const run = spawnSync(process.execPath, [BIN, 'replay', '--since', '3h', '--port', String(port), '--fixture-home', DAY_HOME, '--no-open'], {
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
    })
    expect(run.signal, 'it was killed at the timeout: it never exited').toBeNull()
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/already in use/)
    expect(run.stdout).not.toContain('listening')
  })
})
