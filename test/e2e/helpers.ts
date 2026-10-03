// Spawns the built CLI and parses its one machine-readable stdout line
// ("cubiclark listening <url>") to learn the port and run token it picked.
//
// No server may outlive the run. Every child is remembered here and its pid is written to
// tmp/e2e-pids/ until it exits: stop() kills it (SIGTERM, then SIGKILL), a start that fails kills it,
// the worker going away kills whatever is left, and global-teardown.ts fails the run if a pid is
// still alive at the end (a worker that was killed outright has no chance to clean up).

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RunningCli {
  url: string
  port: number
  token: string
  /** Everything the CLI wrote to stdout so far. */
  stdout: () => string
  stop: () => Promise<void>
}

const CLI_PATH = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
export const PID_DIR = fileURLToPath(new URL('../../tmp/e2e-pids/', import.meta.url))
const START_TIMEOUT_MS = 10_000
const KILL_AFTER_MS = 5_000

const live = new Set<ChildProcess>()
process.once('exit', () => {
  for (const child of live) child.kill('SIGKILL')
})

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

function track(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  live.add(child)
  mkdirSync(PID_DIR, { recursive: true })
  const file = join(PID_DIR, String(pid))
  writeFileSync(file, `${pid}\n`)
  child.once('exit', () => {
    live.delete(child)
    rmSync(file, { force: true })
  })
}

/** SIGTERM, then SIGKILL if it has not gone in KILL_AFTER_MS; resolves once it has exited. */
function stopChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

export async function runCli(args: string[]): Promise<RunningCli> {
  const child = spawn('node', [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  track(child)
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  // Read stderr too, so a chatty child never blocks on a full pipe.
  child.stderr?.on('data', () => undefined)

  let url: string
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the CLI to start')), START_TIMEOUT_MS)
      const onData = (): void => {
        const match = /cubiclark listening (\S+)/.exec(output)
        if (match) {
          clearTimeout(timer)
          child.stdout?.off('data', onData)
          resolve(match[1] as string)
        }
      }
      child.stdout?.on('data', onData)
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`cli exited early with code ${code}`))
      })
    })
  } catch (err) {
    child.kill('SIGKILL')
    throw err
  }

  const parsed = new URL(url)
  const token = parsed.pathname.split('/').filter(Boolean)[0] ?? ''

  return {
    url,
    port: Number(parsed.port),
    token,
    stdout: () => output,
    stop: () => stopChild(child),
  }
}

/** Runs `then` with a started CLI; stops the CLI if `then` throws, and rethrows. */
export async function stopOnFailure<T extends { stop: () => Promise<void> }, R>(cli: T, then: () => Promise<R>): Promise<R> {
  try {
    return await then()
  } catch (err) {
    await cli.stop()
    throw err
  }
}
