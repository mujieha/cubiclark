#!/usr/bin/env node
// Entry point. parseCli is pure and exported so tests can check flag handling without spawning
// a process; main() does the actual I/O and is not imported by tests.

export interface CliOptions {
  port: number
  open: boolean
  fixtureHome?: string
  sinceHours: number
  help: boolean
  version: boolean
}

export function parseCli(_argv: readonly string[]): CliOptions {
  return { port: 4789, open: true, sinceHours: 12, help: false, version: false }
}

function main(): void {
  const opts = parseCli(process.argv.slice(2))
  if (opts.version) {
    console.log('0.1.0')
    return
  }
  console.log('agent-office: not yet implemented')
}

main()
