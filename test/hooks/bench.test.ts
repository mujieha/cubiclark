import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { OVERHEAD_LIMIT_MS, benchCollector } from '../../scripts/bench-hook.js'

const COLLECTOR = fileURLToPath(new URL('../../dist/hook/collector.js', import.meta.url))

test(`the collector adds less than ${OVERHEAD_LIMIT_MS} ms per event over Node's own start-up`, () => {
  const result = benchCollector({ collectorPath: COLLECTOR })
  // Kept in the test output so the numbers are visible in CI logs.
  console.log('bench', result)
  expect(result.overheadMs).toBeLessThan(OVERHEAD_LIMIT_MS)
})
