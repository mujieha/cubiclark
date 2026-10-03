// Before the e2e run: an empty tmp/e2e-pids/, so global-teardown.ts judges this run's servers only.

import { mkdirSync, rmSync } from 'node:fs'
import { PID_DIR } from './helpers.js'

export default function globalSetup(): void {
  rmSync(PID_DIR, { recursive: true, force: true })
  mkdirSync(PID_DIR, { recursive: true })
}
