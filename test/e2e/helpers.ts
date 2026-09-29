// Spawns the built CLI and parses its one machine-readable stdout line
// ("cubiclark listening <url>") to learn the port and run token it picked.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface RunningCli {
  url: string
  port: number
  token: string
  stop: () => Promise<void>
}

const CLI_PATH = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

export async function runCli(args: string[]): Promise<RunningCli> {
  const child = spawn('node', [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('timed out waiting for the CLI to start')), 10_000)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const match = /cubiclark listening (\S+)/.exec(buffer)
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

  const parsed = new URL(url)
  const token = parsed.pathname.split('/').filter(Boolean)[0] ?? ''

  return {
    url,
    port: Number(parsed.port),
    token,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
  }
}
