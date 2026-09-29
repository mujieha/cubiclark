// `hooks on|off|status|pause|resume`: the only code that reads or writes Claude Code's
// settings.json (PLAN.md phase 2 §3, Task 8). The rules, in one place:
//   - parse first, and refuse (nothing written anywhere) when the file does not parse;
//   - keep a backup of the original bytes before the first change;
//   - write through a temp file next to the real target plus rename, so a crash never leaves a
//     half-written settings file, and a symlinked settings.json (dotfile managers) stays a symlink;
//   - `off` restores the backup byte for byte when the file is exactly what `on` wrote, and
//     otherwise removes only our entries and keeps every other edit.

import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  COLLECTOR_BASENAME,
  SettingsParseError,
  collectorEntries,
  desiredEntries,
  detectFormat,
  parseSettings,
  serialiseSettings,
  withCollector,
  withoutCollector,
} from '../core/hooks/settings.js'
import { TOOL_HOOK_EVENTS, type HookEventName } from '../core/hooks/whitelist.js'
import { printableLines } from '../core/printable.js'
import type { HooksInspection } from '../core/types.js'

/** [path relative to dist/, path relative to <stateDir>/bin/]. The collector's whole import graph. */
export const COLLECTOR_FILES: readonly (readonly [from: string, to: string])[] = [
  ['hook/collector.js', 'hook/cubiclark-collector.js'],
  ['core/hooks/whitelist.js', 'core/hooks/whitelist.js'],
  ['core/transcript/tools.js', 'core/transcript/tools.js'],
]

export interface HooksPaths {
  configDir: string
  stateDir: string
  /** The dist/ directory holding COLLECTOR_FILES' sources. */
  distDir: string
  /** ~/.cubiclark: a state dir equal to this needs no --state-dir argument in the handlers. */
  defaultStateDir: string
}

/** The CLI prints the message and exits 1. */
export class HooksCommandError extends Error {}

interface InstallRecord {
  v: 1
  settingsPath: string
  originalAbsent: boolean
  backupPath?: string
  originalSha256?: string
  writtenSha256: string
  events: string[]
  tools: boolean
  installedAt: string
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Where the bytes really live: the file itself, or what a symlink points at. */
async function resolveTarget(settingsPath: string): Promise<string> {
  let link
  try {
    link = await lstat(settingsPath)
  } catch (err) {
    if (isNotFound(err)) return settingsPath
    throw new HooksCommandError(`cannot read ${settingsPath}: ${describe(err)}`)
  }
  if (!link.isSymbolicLink()) return settingsPath
  try {
    return await realpath(settingsPath)
  } catch {
    throw new HooksCommandError(`${settingsPath} is a symlink to a file that does not exist; nothing was changed`)
  }
}

async function readBytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw new HooksCommandError(`cannot read ${path}: ${describe(err)}`)
  }
}

function parseOrRefuse(path: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {}
  try {
    return parseSettings(text)
  } catch (err) {
    if (err instanceof SettingsParseError) {
      throw new HooksCommandError(`${path} does not parse (${err.message}); nothing was changed`)
    }
    throw err
  }
}

/** Temp file in the target's own directory, then rename over it. Keeps an existing mode. */
async function writeAtomic(target: string, data: Buffer | string): Promise<void> {
  let mode = 0o600
  try {
    mode = (await stat(target)).mode & 0o777
  } catch {
    // a new file: private by default
  }
  await mkdir(dirname(target), { recursive: true })
  const temp = join(dirname(target), `.settings.json.cubiclark-${process.pid}.tmp`)
  try {
    await writeFile(temp, data, { mode })
    await rename(temp, target)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw new HooksCommandError(`cannot write ${target}: ${describe(err)}`)
  }
}

async function readInstall(stateDir: string): Promise<InstallRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(stateDir, 'install.json'), 'utf8')) as InstallRecord
  } catch {
    return undefined
  }
}

async function writeInstall(stateDir: string, record: InstallRecord): Promise<void> {
  await writeFile(join(stateDir, 'install.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
}

async function copyCollector(p: HooksPaths): Promise<void> {
  await mkdir(p.stateDir, { recursive: true, mode: 0o700 })
  for (const [from, to] of COLLECTOR_FILES) {
    const destination = join(p.stateDir, 'bin', to)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    try {
      await copyFile(join(p.distDir, from), destination)
    } catch (err) {
      throw new HooksCommandError(
        `cannot copy the collector from ${join(p.distDir, from)} (${describe(err)}); run \`npm run build\` first`
      )
    }
  }
  await writeFile(join(p.stateDir, 'bin', 'package.json'), '{"type":"module"}\n')
}

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
}

export interface HooksOnResult {
  changed: boolean
  settingsPath: string
  events: HookEventName[]
  backupPath?: string
}

export async function hooksOn(p: HooksPaths, opts: { tools: boolean; nowMs: number }): Promise<HooksOnResult> {
  const settingsPath = join(p.configDir, 'settings.json')
  const target = await resolveTarget(settingsPath)
  const bytes = await readBytes(target)
  const originalText = bytes?.toString('utf8')
  const settings = parseOrRefuse(settingsPath, originalText)

  const collectorPath = join(p.stateDir, 'bin', 'hook', COLLECTOR_BASENAME)
  const desired = desiredEntries(collectorPath, p.stateDir === p.defaultStateDir ? undefined : p.stateDir, opts.tools)
  const events = desired.map((entry) => entry.event)

  await copyCollector(p) // always: an upgrade refreshes the installed copy

  const { settings: next, changed } = withCollector(settings, desired)
  if (!changed) return { changed: false, settingsPath, events }

  // The first change keeps the original bytes; switching tools on or off later keeps that
  // original, so `off` still returns to the file as it was before Cubiclark.
  let install = await readInstall(p.stateDir)
  const hadOurs = collectorEntries(settings).length > 0
  let backupPath: string | undefined
  if (!install || !hadOurs) {
    if (bytes) {
      backupPath = join(p.stateDir, 'backups', `settings-${stamp(opts.nowMs)}.json`)
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 })
      await writeFile(backupPath, bytes, { mode: 0o600 })
    }
    install = {
      v: 1,
      settingsPath,
      originalAbsent: bytes === undefined,
      backupPath,
      originalSha256: bytes ? sha256(bytes) : undefined,
      writtenSha256: '',
      events: [],
      tools: opts.tools,
      installedAt: new Date(opts.nowMs).toISOString(),
    }
  } else {
    backupPath = install.backupPath
  }

  const text = serialiseSettings(next, detectFormat(originalText))
  await writeAtomic(target, text)
  await writeInstall(p.stateDir, { ...install, writtenSha256: sha256(text), events, tools: opts.tools })
  return { changed: true, settingsPath, events, backupPath }
}

export interface HooksOffResult {
  removed: number
  restored: 'backup' | 'structural' | 'nothing'
  settingsPath: string
}

export async function hooksOff(p: HooksPaths, opts: { purge: boolean }): Promise<HooksOffResult> {
  const settingsPath = join(p.configDir, 'settings.json')
  const target = await resolveTarget(settingsPath)
  const bytes = await readBytes(target)
  const text = bytes?.toString('utf8')
  const settings = parseOrRefuse(settingsPath, text)
  const entries = collectorEntries(settings)
  const install = await readInstall(p.stateDir)

  let removed = 0
  let restored: HooksOffResult['restored'] = 'nothing'

  if (entries.length > 0 && bytes) {
    removed = entries.length
    const untouched = install !== undefined && install.writtenSha256 === sha256(bytes)
    const backup =
      untouched && !install.originalAbsent && install.backupPath ? await readBytes(install.backupPath) : undefined
    if (untouched && install.originalAbsent) {
      await unlink(target)
      restored = 'backup'
    } else if (untouched && backup) {
      await writeAtomic(target, backup)
      restored = 'backup'
    } else {
      const { settings: next } = withoutCollector(settings)
      await writeAtomic(target, serialiseSettings(next, detectFormat(text)))
      restored = 'structural'
    }
  }

  if (opts.purge) {
    await rm(p.stateDir, { recursive: true, force: true })
  } else {
    await rm(join(p.stateDir, 'bin'), { recursive: true, force: true })
    await rm(join(p.stateDir, 'install.json'), { force: true })
  }
  return { removed, restored, settingsPath }
}

export async function pauseHooks(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(join(stateDir, 'off'), 'paused by cubiclark hooks pause\n')
}

export async function resumeHooks(stateDir: string): Promise<void> {
  await rm(join(stateDir, 'off'), { force: true })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The `ts` of the last complete line in the last 4 KiB of the events file. */
async function lastEventTime(eventsFile: string, size: number): Promise<string | undefined> {
  const length = Math.min(size, 4096)
  if (length === 0) return undefined
  const handle = await open(eventsFile, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    lines.pop() // after the last newline: empty, or a line still being written
    if (size > length) lines.shift() // began mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ts = (JSON.parse(lines[i] as string) as { ts?: unknown }).ts
        if (typeof ts === 'string') return ts
      } catch {
        // a damaged line: look at the one before it
      }
    }
  } finally {
    await handle.close()
  }
  return undefined
}

export async function inspectHooks(configDir: string, stateDir: string): Promise<HooksInspection> {
  const settingsPath = join(configDir, 'settings.json')
  const eventsFile = join(stateDir, 'events.jsonl')
  const inspection: HooksInspection = {
    settingsPath,
    settingsState: 'absent',
    events: [],
    tools: false,
    collectorExists: false,
    paused: await exists(join(stateDir, 'off')),
    eventsFile,
  }

  let text: string | undefined
  try {
    text = await readFile(settingsPath, 'utf8')
  } catch (err) {
    if (!isNotFound(err)) {
      return { ...inspection, settingsState: 'unparseable', parseError: `cannot read: ${describe(err)}` }
    }
  }
  if (text !== undefined) {
    try {
      const entries = collectorEntries(parseSettings(text))
      inspection.settingsState = 'ok'
      inspection.events = [...new Set(entries.map((entry) => entry.event))]
      inspection.tools = inspection.events.some((event) => (TOOL_HOOK_EVENTS as readonly string[]).includes(event))
      for (const entry of entries) {
        const args = Array.isArray(entry.handler.args) ? entry.handler.args : []
        const found = args.find((arg) => typeof arg === 'string' && arg.endsWith(COLLECTOR_BASENAME))
        if (typeof found === 'string') {
          inspection.collectorPath = found
          break
        }
      }
      if (inspection.collectorPath) inspection.collectorExists = await exists(inspection.collectorPath)
    } catch (err) {
      inspection.settingsState = 'unparseable'
      inspection.parseError = describe(err)
    }
  }

  try {
    const { size } = await stat(eventsFile)
    inspection.eventsBytes = size
    inspection.lastEventTs = await lastEventTime(eventsFile, size)
  } catch {
    // no events yet
  }
  return inspection
}

/** The text of `cubiclark hooks status`. */
export function formatHooksStatus(i: HooksInspection): string {
  const settings =
    i.settingsState === 'ok' ? 'ok' : i.settingsState === 'absent' ? 'not found' : `does not parse: ${i.parseError ?? 'unknown error'}`
  const lines = ['cubiclark hooks status', `settings.json: ${i.settingsPath} (${settings})`]
  if (i.events.length > 0) {
    lines.push(`installed: yes, ${i.events.length} events, tool events ${i.tools ? 'on' : 'off'}`)
    lines.push(`collector: ${i.collectorPath ?? 'unknown'} (${i.collectorExists ? 'present' : 'missing'})`)
  } else {
    lines.push('installed: no')
  }
  lines.push(`paused: ${i.paused ? 'yes' : 'no'}`)
  lines.push(
    i.eventsBytes === undefined
      ? `events file: ${i.eventsFile} (none yet)`
      : `events file: ${i.eventsFile}, ${i.eventsBytes} bytes${i.lastEventTs ? `, last event ${i.lastEventTs}` : ''}`
  )
  return printableLines(lines)
}
