// `hooks on|off|status|pause|resume`: the only code that reads or writes Claude Code's
// settings.json (PLAN.md phase 2 §3, Task 8). The rules, in one place:
//   - parse first, and refuse (nothing written anywhere) when the file does not parse;
//   - keep a backup of the original bytes before the first change;
//   - write through a temp file next to the real target plus rename, so a crash never leaves a
//     half-written settings file, and a symlinked settings.json (dotfile managers) stays a symlink;
//   - `off` restores the backup byte for byte when the file is exactly what `on` wrote, and
//     otherwise removes only our entries and keeps every other edit.

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
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
import { openRegular, readRegularText, type OpenFile } from './open-regular.js'

/** [path relative to dist/, path relative to <stateDir>/bin/]. The collector's whole import graph. */
export const COLLECTOR_FILES: readonly (readonly [from: string, to: string])[] = [
  ['hook/collector.js', 'hook/cubiclark-collector.js'],
  ['core/hooks/whitelist.js', 'core/hooks/whitelist.js'],
  ['core/transcript/tools.js', 'core/transcript/tools.js'],
]

/** What `hooks on` writes to `bin/package.json`: `off` removes that file only when it still holds exactly this. */
export const COLLECTOR_PACKAGE_JSON = '{"type":"module"}\n'

export interface HooksPaths {
  configDir: string
  stateDir: string
  /** The dist/ directory holding COLLECTOR_FILES' sources. */
  distDir: string
  /** ~/.cubiclark: a state dir equal to this needs no --state-dir argument in the handlers. */
  defaultStateDir: string
  /** The home directory `--purge` must never remove or contain. Default: the user's. */
  home?: string
  /** The user id the state directory must belong to. Default: this process's. */
  uid?: number
}

/** The CLI prints the message and exits 1. */
export class HooksCommandError extends Error {}

interface InstallRecord {
  v: 1
  settingsPath: string
  originalAbsent: boolean
  backupPath?: string
  originalSha256?: string
  /** True when the file already held collector entries at the first install (S1-6). */
  originalHadCollector?: boolean
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
  // A random name and O_EXCL: a symlink planted at a predictable name is never followed (S1-17).
  const temp = join(dirname(target), `.settings.json.cubiclark-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, data, { mode, flag: 'wx' })
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

/** A directory that will hold a file Claude Code runs as this user (S1-8): it must be a real
 * directory (not a symlink), owned by this user, and not writable by group or others. Nothing is
 * chmod-ed silently: the person is told which directory to fix. */
async function requirePrivateDir(dir: string, uid: number | undefined): Promise<void> {
  let info
  try {
    info = await lstat(dir)
  } catch (err) {
    throw new HooksCommandError(`cannot inspect ${dir}: ${describe(err)}`)
  }
  const fix = `; nothing was installed. Use a directory only you can write (chmod 700 ${dir}), or another --state-dir`
  if (info.isSymbolicLink()) throw new HooksCommandError(`${dir} is a symlink${fix}`)
  if (!info.isDirectory()) throw new HooksCommandError(`${dir} is not a directory${fix}`)
  if (uid !== undefined && info.uid !== uid) throw new HooksCommandError(`${dir} is owned by another user${fix}`)
  if ((info.mode & 0o022) !== 0) throw new HooksCommandError(`${dir} is writable by group or others${fix}`)
}

/** The user this process runs as, where the platform has one (not Windows). */
function currentUid(p: HooksPaths): number | undefined {
  return p.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
}

/** Copies through a temp file and a rename, so a symlink already sitting at the destination is
 * replaced and never followed. */
async function placeFile(source: string | undefined, destination: string, data?: string): Promise<void> {
  const temp = `${destination}.${randomBytes(6).toString('hex')}.tmp`
  try {
    if (source !== undefined) await copyFile(source, temp, constants.COPYFILE_EXCL)
    else await writeFile(temp, data ?? '', { flag: 'wx', mode: 0o644 })
    await rename(temp, destination)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}

async function copyCollector(p: HooksPaths): Promise<void> {
  await mkdir(p.stateDir, { recursive: true, mode: 0o700 })
  const uid = currentUid(p)
  await requirePrivateDir(p.stateDir, uid)
  await mkdir(join(p.stateDir, 'bin'), { recursive: true, mode: 0o700 })
  await requirePrivateDir(join(p.stateDir, 'bin'), uid)
  for (const [from, to] of COLLECTOR_FILES) {
    const destination = join(p.stateDir, 'bin', to)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await requirePrivateDir(dirname(destination), uid)
    try {
      await placeFile(join(p.distDir, from), destination)
    } catch (err) {
      throw new HooksCommandError(
        `cannot copy the collector from ${join(p.distDir, from)} (${describe(err)}); run \`npm run build\` first`
      )
    }
  }
  await placeFile(undefined, join(p.stateDir, 'bin', 'package.json'), COLLECTOR_PACKAGE_JSON)
}

function backupHoldsCollector(bytes: Buffer): boolean {
  try {
    return collectorEntries(parseSettings(bytes.toString('utf8'))).length > 0
  } catch {
    return false
  }
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

/** `on` writes `bin/package.json` and `off` removes it as its own, so a file already there that is not
 * exactly what `on` writes belongs to someone else: refuse, before anything is changed (R3-2). */
async function requireNoForeignPackageJson(p: HooksPaths): Promise<void> {
  const packageJson = join(p.stateDir, 'bin', 'package.json')
  let info
  try {
    info = await lstat(packageJson)
  } catch (err) {
    // Absent is fine; a `bin` that is not a directory is for requirePrivateDir to name, later.
    if (isNotFound(err) || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return
    throw new HooksCommandError(`cannot inspect ${packageJson}: ${describe(err)}; nothing was changed`)
  }
  if (info.isFile()) {
    try {
      if ((await readFile(packageJson, 'utf8')) === COLLECTOR_PACKAGE_JSON) return
    } catch (err) {
      throw new HooksCommandError(`cannot read ${packageJson}: ${describe(err)}; nothing was changed`)
    }
  }
  throw new HooksCommandError(`${packageJson} is not Cubiclark's; choose another state directory; nothing was changed`)
}

/** The handlers' paths are resolved by Claude Code against each session's project directory and take no
 * `~` expansion, so a relative state directory (or a `~` the shell left alone) would run a file of the
 * project as a user-level hook: refuse it and name the absolute path that was probably meant (C1). */
function requireAbsoluteStateDir(p: HooksPaths): void {
  if (isAbsolute(p.stateDir)) return
  const first = p.stateDir.split(/[\\/]/)[0]
  const meant = first === '~' ? join(p.home ?? homedir(), p.stateDir.slice(1)) : resolve(p.stateDir)
  throw new HooksCommandError(`the state directory must be an absolute path; did you mean \`${meant}\`? nothing was changed`)
}

export async function hooksOn(p: HooksPaths, opts: { tools: boolean; nowMs: number }): Promise<HooksOnResult> {
  requireAbsoluteStateDir(p)
  await requireSafeStateDir(p, 'install into')
  await requireNoForeignPackageJson(p)
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
      // The install record was lost while entries remained: this is not a clean original.
      ...(hadOurs ? { originalHadCollector: true } : {}),
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
  // On every `off`, not only `--purge`: a wrong CUBICLARK_HOME must never point this at real data (R2-2).
  await requireSafeStateDir(p, opts.purge ? 'purge' : 'remove hooks from')
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
    let backup =
      untouched && !install.originalAbsent && !install.originalHadCollector && install.backupPath
        ? await readBytes(install.backupPath)
        : undefined
    // A backup that itself runs the collector is not "the file before Cubiclark" (S1-6): restoring
    // it would leave Claude Code running a collector that `off` just deleted.
    if (backup && backupHoldsCollector(backup)) backup = undefined
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

  await removeCollector(p.stateDir)
  await rm(join(p.stateDir, 'install.json'), { force: true })
  if (opts.purge) await purgeStateDir(p.stateDir)
  return { removed, restored, settingsPath }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory() // lstat: a symlink to a directory is not one
  } catch {
    return false
  }
}

/** Takes out of `<state dir>/bin` what `hooks on` placed there and nothing else: the collector's files,
 * `package.json` when it is still exactly what `on` wrote, and then each directory `on` made, only when
 * it is empty. Never recursive, and a `bin` or a subdirectory that is a symlink is not entered (R2-2). */
async function removeCollector(stateDir: string): Promise<void> {
  const bin = join(stateDir, 'bin')
  if (!(await isRealDirectory(bin))) return

  // `to` is written with `/`: every directory above a file, as a list of segments, shallowest first.
  const segments = (to: string): string[][] => {
    const parts = to.split('/')
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1))
  }
  const directories = new Map<string, string[]>()
  for (const [, to] of COLLECTOR_FILES) for (const dir of segments(to)) directories.set(dir.join('/'), dir)

  for (const [, to] of COLLECTOR_FILES) {
    let inside = true
    for (const dir of segments(to)) if (inside && !(await isRealDirectory(join(bin, ...dir)))) inside = false
    if (inside) await unlink(join(bin, ...to.split('/'))).catch(() => undefined)
  }

  const packageJson = join(bin, 'package.json')
  try {
    const info = await lstat(packageJson)
    if (info.isFile() && (await readFile(packageJson, 'utf8')) === COLLECTOR_PACKAGE_JSON) await unlink(packageJson)
  } catch {
    // absent, or not ours to read
  }

  // Deepest first; a directory that still holds anything is left as it is.
  const deepestFirst = [...directories.values()].sort((a, b) => b.length - a.length)
  for (const dir of deepestFirst) {
    if (await isRealDirectory(join(bin, ...dir))) await rmdir(join(bin, ...dir)).catch(() => undefined)
  }
  await rmdir(bin).catch(() => undefined)
}

/** What `--purge` removes besides `bin/` and `install.json`: the names Cubiclark itself writes.
 * `config.json`, `assets/` and `backups/` stay (the backup may be the only copy of the settings
 * from before Cubiclark), and so does anything else that is in the directory (S1-4). */
export const PURGE_NAMES = ['events.jsonl', 'events.1.jsonl', 'off'] as const

async function purgeStateDir(stateDir: string): Promise<void> {
  for (const name of PURGE_NAMES) await rm(join(stateDir, name), { force: true })
  await rmdir(stateDir).catch(() => undefined) // only when nothing else is left in it
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** `on`, `off` and `off --purge` refuse, before anything is changed, a state directory that is `/`, the
 * home directory or one that contains it: a wrong CUBICLARK_HOME must not point them at real data
 * (S1-4, R2-2). `verb` is what the refusal says was being done. */
async function requireSafeStateDir(p: HooksPaths, verb: string): Promise<void> {
  const state = await realpathOrResolve(p.stateDir)
  const home = await realpathOrResolve(p.home ?? homedir())
  const prefix = state.endsWith(sep) ? state : state + sep
  if (state === sep || state === home || home.startsWith(prefix)) {
    throw new HooksCommandError(`refusing to ${verb} ${p.stateDir}: it is your home directory or contains it; nothing was changed`)
  }
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
async function lastEventTime(eventsFile: string, size: number, openFile?: OpenFile): Promise<string | undefined> {
  if (Math.min(size, 4096) === 0) return undefined
  // Opened without waiting for a writer and judged by its own fstat (R4-4): this runs every 2 s under
  // `serve` and `tui`, and a FIFO swapped in after the caller's stat must not block a thread. The size is the
  // descriptor's, so a file that grew or shrank since the stat is still read at its own end.
  const { handle, size: opened } = await openRegular(eventsFile, openFile)
  try {
    const length = Math.min(opened, 4096)
    if (length === 0) return undefined
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, opened - length)
    const lines = buffer.toString('utf8').split('\n')
    lines.pop() // after the last newline: empty, or a line still being written
    if (opened > length) lines.shift() // began mid-line
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

/** `openFile` is a seam for tests: how settings.json and the events file are opened. */
export async function inspectHooks(configDir: string, stateDir: string, openFile?: OpenFile): Promise<HooksInspection> {
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
    // Opened without waiting for a writer and judged by its own fstat (R4-4), like the events file below.
    text = await readRegularText(settingsPath, undefined, openFile)
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
    inspection.lastEventTs = await lastEventTime(eventsFile, size, openFile)
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
