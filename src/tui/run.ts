// `cubiclark tui`: starts the same sources as `serve` (without the server), then either prints frames
// (for a pipe, `--once` and `--frames`) or runs the interactive screen. The two loops take everything
// they touch as arguments (the source of Worlds, the controller, the terminal session, the timers), so
// the tests drive them with fakes and no terminal.

import { emitKeypressEvents } from 'node:readline'
import { MIN_FRAME_MS, ANIMATION_FRAME_MS } from '../core/tui/gate.js'
import type { TuiSize } from '../core/tui/render.js'
import { publicWorld } from '../core/view.js'
import type { World } from '../core/types.js'
import { startWorld } from '../start-world.js'
import { TuiController } from './controller.js'
import { animationOn, colorOn, frameSize, tuiMode, unicodeOn, type Env } from './env.js'
import { FrameScheduler, type SchedulerDeps } from './loop.js'
import { TerminalSession, type TerminalIn, type TerminalOut, type TerminalProc, type TerminalSignal } from './terminal.js'

/** Everything `runTui` needs, resolved by cli.ts the way `serve` resolves its own (a fixture home never reaches the real state directory). */
export interface RunTuiOptions {
  root: string
  fixtureMode: boolean
  sinceHours: number
  stateDir?: string
  configPath?: string
  mascot: boolean
  idleDesks: number
  once: boolean
  frames?: number
  size?: TuiSize
  /** False with `--no-color`. */
  color: boolean
  /** False with `--no-animation`. */
  animation: boolean
  ascii: boolean
}

/** The Worlds to show: the current one, and a call when it changes. */
export interface WorldSource {
  getWorld(): World
  subscribe(listener: (world: World) => void): () => void
}

/** What `printFrames` writes with, waits with and reads the clock with. */
export interface PrintDeps {
  write: (text: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/** `count` frames, a tenth of a second apart, each followed by a newline. */
export async function printFrames(source: WorldSource, controller: TuiController, count: number, size: TuiSize, deps: PrintDeps): Promise<void> {
  for (let i = 0; i < count; i++) {
    if (i > 0) await deps.sleep(MIN_FRAME_MS)
    const frame = controller.frame(source.getWorld(), size, deps.now())
    await deps.write(`${frame.lines.join('\n')}\n`)
  }
}

export interface ProcLike {
  on(event: string, listener: (arg?: unknown) => void): unknown
  off(event: string, listener: (arg?: unknown) => void): unknown
}

export interface InteractiveDeps {
  source: WorldSource
  controller: TuiController
  session: TerminalSession
  /** The frame size, asked for at every frame: the terminal can be resized. */
  sizeOf: () => TuiSize
  timers: SchedulerDeps & {
    setInterval: (callback: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  /** The animation clock. */
  now: () => number
  proc: ProcLike
  /** Where a fatal error's name goes, after the terminal is back. */
  stderr: (text: string) => void
}

const SIGNAL_EXIT: Record<TerminalSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

/** The interactive screen. Resolves with the exit code once the terminal is back: 0 for `q`, 130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP, 1 for an error. */
export function runInteractive(deps: InteractiveDeps): Promise<number> {
  const { source, controller, session, timers, proc } = deps
  return new Promise<number>((resolve) => {
    let finished = false
    // what finish() has to undo, filled in as the pieces start
    const started: { unsubscribe?: () => void; animation?: unknown } = {}

    const draw = (): void => {
      const frame = controller.frame(source.getWorld(), deps.sizeOf(), deps.now())
      session.draw(frame.lines)
    }
    const scheduler = new FrameScheduler(timers, draw)

    // A rejection nobody awaits must not tear the screen: it is dropped. An exception ends the run,
    // with the terminal given back first.
    const onRejection = (): undefined => undefined
    const onException = (error?: unknown): void => {
      finish(1)
      deps.stderr(`cubiclark: stopped by an error (${error instanceof Error ? error.name : typeof error})\n`)
    }

    function finish(code: number): void {
      if (finished) return
      finished = true
      if (started.animation !== undefined) timers.clearInterval(started.animation)
      started.unsubscribe?.()
      scheduler.stop()
      session.stop()
      proc.off('unhandledRejection', onRejection)
      proc.off('uncaughtException', onException)
      resolve(code)
    }

    proc.on('unhandledRejection', onRejection)
    proc.on('uncaughtException', onException)
    session.start({
      onKey: (key) => {
        if (controller.key(key)) finish(0)
        else scheduler.request()
      },
      onResize: () => scheduler.request(),
      onSignal: (signal) => finish(SIGNAL_EXIT[signal]),
    })
    started.unsubscribe = source.subscribe(() => scheduler.request())
    started.animation = timers.setInterval(() => {
      if (controller.animated) scheduler.request()
    }, ANIMATION_FRAME_MS)
    scheduler.request()
  })
}

/** The real streams and clocks. */
export interface TuiIo {
  stdout: TerminalOut & { isTTY?: boolean }
  stdin: TerminalIn & { isTTY?: boolean }
  stderr: (text: string) => void
  env: Env
  proc: ProcLike & TerminalProc
  now: () => number
}

export function processIo(): TuiIo {
  return {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: (text) => {
      process.stderr.write(text)
    },
    env: process.env,
    proc: process,
    now: () => performance.now(),
  }
}

const realTimers = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** Runs the terminal mode and returns the exit code. */
export async function runTui(options: RunTuiOptions, io: TuiIo = processIo()): Promise<number> {
  const mode = tuiMode({ once: options.once, frames: options.frames }, io.stdin.isTTY === true, io.stdout.isTTY === true)

  let running: Awaited<ReturnType<typeof startWorld>>
  try {
    running = await startWorld({
      root: options.root,
      fixtureMode: options.fixtureMode,
      sinceHours: options.sinceHours,
      stateDir: options.stateDir,
      configPath: options.configPath,
    })
  } catch (err) {
    io.stderr(`cubiclark: failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  try {
    // The World as the page gets it (a reduced cwd, `~` for the home), made once per change of the store's.
    let raw: World | undefined
    let shown: World | undefined
    const current = (): World => {
      const world = running.store.getWorld()
      if (world !== raw) {
        raw = world
        shown = publicWorld(world, running.home)
      }
      return shown as World
    }
    const source: WorldSource = {
      getWorld: current,
      subscribe: (listener) => running.store.subscribe(() => listener(current())),
    }
    const controller = new TuiController({
      idleDesks: options.idleDesks,
      mascot: options.mascot,
      animate: animationOn(options.animation, io.env),
      color: colorOn(options.color, io.env, io.stdout.isTTY === true),
      unicode: unicodeOn(options.ascii, io.env),
    })

    if (mode.kind === 'print') {
      const size = frameSize(options.size, io.stdout, 'print')
      let broken = false
      await printFrames(source, controller, mode.frames, size, {
        write: (text) =>
          broken
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                // A reader that went away (`| head`) ends the output, not the program with an error.
                io.stdout.write(text, (error) => {
                  if (error) broken = true
                  resolve()
                })
              }),
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        now: io.now,
      })
      return 0
    }

    const session = new TerminalSession({ out: io.stdout, input: io.stdin, proc: io.proc, emitKeypress: (input) => emitKeypressEvents(input as NodeJS.ReadableStream) })
    return await runInteractive({
      source,
      controller,
      session,
      sizeOf: () => (options.size ? options.size : frameSize(undefined, io.stdout, 'interactive')),
      timers: realTimers,
      now: io.now,
      proc: io.proc,
      stderr: io.stderr,
    })
  } finally {
    running.close()
  }
}
