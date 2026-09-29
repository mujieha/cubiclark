// Measures the collector against Node's own start-up floor, interleaved so machine load hits
// both equally. Acceptance (PLAN.md phase 2 §1.1): overhead = collector median - empty-script
// median < 30 ms. Absolute numbers are printed too; on the dev Mac the floor alone is ~90 ms,
// which no collector written in Node can beat.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const OVERHEAD_LIMIT_MS = 30

export interface BenchResult {
  runs: number
  floorMedianMs: number
  collectorMedianMs: number
  overheadMs: number
  collectorP90Ms: number
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export function benchCollector(opts: { collectorPath: string; runs?: number }): BenchResult {
  const runs = opts.runs ?? 40
  const dir = mkdtempSync(join(tmpdir(), 'cubiclark-bench-'))
  try {
    const empty = join(dir, 'empty.mjs')
    writeFileSync(empty, '')
    const stateDir = join(dir, 'state')
    // A realistic worst case for the input side: a 20 KB Bash command.
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'bench',
      cwd: '/home/user/projects/demo',
      tool_name: 'Bash',
      tool_use_id: 'toolu_bench',
      tool_input: { command: 'npm test ' + 'x'.repeat(20_000) },
    })
    const runFloor = (): number => {
      const t0 = performance.now()
      spawnSync(process.execPath, [empty])
      return performance.now() - t0
    }
    const runCollector = (): number => {
      const t0 = performance.now()
      spawnSync(process.execPath, [opts.collectorPath, '--state-dir', stateDir], { input: payload })
      return performance.now() - t0
    }

    for (let i = 0; i < 3; i++) {
      runFloor()
      runCollector()
    }
    const floor: number[] = []
    const collector: number[] = []
    for (let i = 0; i < runs; i++) {
      floor.push(runFloor())
      collector.push(runCollector())
    }
    floor.sort((a, b) => a - b)
    collector.sort((a, b) => a - b)
    const floorMedianMs = percentile(floor, 0.5)
    const collectorMedianMs = percentile(collector, 0.5)
    return {
      runs,
      floorMedianMs: round1(floorMedianMs),
      collectorMedianMs: round1(collectorMedianMs),
      overheadMs: round1(collectorMedianMs - floorMedianMs),
      collectorP90Ms: round1(percentile(collector, 0.9)),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  const collectorPath = fileURLToPath(new URL('../dist/hook/collector.js', import.meta.url))
  const result = benchCollector({ collectorPath })
  console.log(`runs                     ${result.runs}`)
  console.log(`node start-up floor      ${result.floorMedianMs} ms (median, empty script)`)
  console.log(`collector per event      ${result.collectorMedianMs} ms (median), p90 ${result.collectorP90Ms} ms`)
  console.log(`collector overhead       ${result.overheadMs} ms (limit ${OVERHEAD_LIMIT_MS} ms)`)
  if (result.overheadMs >= OVERHEAD_LIMIT_MS) process.exitCode = 1
}
