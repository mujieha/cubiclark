// The claude-agents adapter: runs the local `claude agents --json` to learn which background
// sessions are busy, waiting or idle. A local command, no model call. It is created only when the
// configuration enables it, asks at most once per `pollMs` (never below 15 s), and detect() and
// snapshot() never throw.

import { execFile } from 'node:child_process'
import type { AdapterConfig } from '../../core/adapters/config.js'
import { parseAgentsJson } from '../../core/adapters/claude-agents.js'
import type { AdapterEnv, AdapterSnapshot, OrchestrationAdapter } from '../../core/adapters/types.js'

type AgentsConfig = NonNullable<AdapterConfig['claudeAgents']>

/** Runs a program with arguments. Resolves on any exit code; rejects only when it could not run
 * (missing, not executable, timed out). Injected so tests can watch how often it is called. */
export type CommandRunner = (bin: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; code: number }>

export const execFileRunner: CommandRunner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
      if (!err) {
        resolve({ stdout: String(stdout), code: 0 })
        return
      }
      const code = (err as NodeJS.ErrnoException & { killed?: boolean }).code
      if (typeof code === 'number' && !(err as { killed?: boolean }).killed) resolve({ stdout: String(stdout), code })
      else reject(err)
    })
  })

const VERSION_TIMEOUT_MS = 3000
const AGENTS_TIMEOUT_MS = 5000

export class ClaudeAgentsAdapter implements OrchestrationAdapter {
  readonly id = 'claude-agents'
  readonly pollMs: number
  /** For the adapter's status line. */
  lastSessionCount = 0
  lastError: string | undefined
  private cached: AdapterSnapshot | undefined
  private cachedAtMs = Number.NEGATIVE_INFINITY

  constructor(
    private readonly config: AgentsConfig,
    private readonly env: AdapterEnv,
    private readonly run: CommandRunner = execFileRunner
  ) {
    this.pollMs = Math.max(15_000, config.pollMs)
  }

  async detect(): Promise<boolean> {
    try {
      const { code } = await this.run(this.config.bin, ['--version'], VERSION_TIMEOUT_MS)
      return code === 0
    } catch {
      return false
    }
  }

  async snapshot(): Promise<AdapterSnapshot> {
    const now = this.env.nowMs()
    // Asked again before pollMs is up (a refresh, a watch): the last answer stands.
    if (this.cached && now - this.cachedAtMs < this.pollMs) return this.cached

    const fetchedAt = new Date(now).toISOString()
    let snapshot: AdapterSnapshot
    try {
      const { stdout, code } = await this.run(this.config.bin, ['agents', '--json'], AGENTS_TIMEOUT_MS)
      if (code !== 0) {
        this.lastError = `claude agents --json exited with code ${code}`
        snapshot = { cliSessions: [], cliFetchedAt: fetchedAt, diagnostics: { unparsed: 0, errors: [this.lastError] } }
      } else {
        const parsed = parseAgentsJson(stdout)
        this.lastError = parsed.error
        snapshot = {
          cliSessions: parsed.sessions,
          cliFetchedAt: fetchedAt,
          diagnostics: { unparsed: parsed.unparsed, errors: parsed.error ? [parsed.error] : [] },
        }
      }
    } catch (err) {
      this.lastError = `cannot run claude agents --json: ${err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : 'failed'}`
      snapshot = { cliSessions: [], cliFetchedAt: fetchedAt, diagnostics: { unparsed: 0, errors: [this.lastError] } }
    }
    this.lastSessionCount = snapshot.cliSessions?.length ?? 0
    this.cached = snapshot
    this.cachedAtMs = now
    return snapshot
  }
}
