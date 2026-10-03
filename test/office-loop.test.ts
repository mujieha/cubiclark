import { describe, expect, test } from 'vitest'
import { FRAME_MS, FrameLoop, type LoopHost } from '../src/client/office/loop.js'

/** A display: `advance(ms)` moves time and runs whichever rAF callbacks are queued. */
class FakeHost implements LoopHost {
  time = 0
  hidden = false
  private nextId = 1
  private queue = new Map<number, (t: number) => void>()
  private listeners = new Set<() => void>()
  cancelled = 0

  raf = (callback: (t: number) => void): number => {
    const id = this.nextId++
    this.queue.set(id, callback)
    return id
  }
  cancelRaf = (id: number): void => {
    if (this.queue.delete(id)) this.cancelled++
  }
  now = (): number => this.time
  isHidden = (): boolean => this.hidden
  onVisibilityChange = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  get pending(): number {
    return this.queue.size
  }
  get watchers(): number {
    return this.listeners.size
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden
    for (const listener of [...this.listeners]) listener()
  }
  /** One display refresh, `dt` ms after the last. */
  advance(dt: number): void {
    this.time += dt
    const callbacks = [...this.queue.values()]
    this.queue.clear()
    for (const callback of callbacks) callback(this.time)
  }
  run(seconds: number, refreshHz: number): void {
    const dt = 1000 / refreshHz
    const ticks = Math.round(seconds * refreshHz)
    for (let i = 0; i < ticks; i++) this.advance(dt)
  }
}

function makeLoop(cost = 0): { host: FakeHost; loop: FrameLoop; times: number[] } {
  const host = new FakeHost()
  const times: number[] = []
  const loop = new FrameLoop(host, (t) => {
    times.push(t)
    host.time += cost
  })
  return { host, loop, times }
}

describe('the 30 fps cap', () => {
  test.each([60, 120])('draws 30 frames per second on a %d Hz display', (hz) => {
    const { host, loop } = makeLoop()
    loop.start()
    host.run(1, hz)
    expect(loop.frames).toBeGreaterThanOrEqual(29)
    expect(loop.frames).toBeLessThanOrEqual(30)
  })

  test('never draws two frames closer than the frame interval (less the rAF jitter allowance)', () => {
    const { host, loop, times } = makeLoop()
    loop.start()
    host.run(2, 120)
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(FRAME_MS - 2)
  })

  test('fps() reads 30 from the drawn frames', () => {
    const { host, loop } = makeLoop()
    loop.start()
    host.run(3, 60)
    expect(loop.fps()).toBe(30)
    const again = makeLoop()
    again.loop.start()
    again.host.run(3, 120)
    expect(again.loop.fps()).toBe(30)
  })

  test('fps() is 0 before there are two frames', () => {
    const { host, loop } = makeLoop()
    expect(loop.fps()).toBe(0)
    loop.start()
    host.advance(17)
    expect(loop.fps()).toBe(0)
  })

  test('a 24 Hz display is not sped up: it draws on every refresh it has', () => {
    const { host, loop } = makeLoop()
    loop.start()
    host.run(1, 24)
    expect(loop.frames).toBe(24)
  })
})

describe('pausing when the tab is hidden', () => {
  test('a hidden tab draws nothing and asks for no frames; showing it again resumes', () => {
    const { host, loop } = makeLoop()
    loop.start()
    host.run(0.5, 60)
    const before = loop.frames
    host.setHidden(true)
    host.run(1, 60)
    expect(loop.frames).toBe(before)
    expect(host.pending).toBe(0)
    host.setHidden(false)
    expect(host.pending).toBe(1)
    host.run(0.5, 60)
    expect(loop.frames).toBeGreaterThan(before)
  })

  test('starting while hidden waits for the tab to be shown', () => {
    const host = new FakeHost()
    host.hidden = true
    const loop = new FrameLoop(host, () => undefined)
    loop.start()
    expect(host.pending).toBe(0)
    host.setHidden(false)
    host.run(0.2, 60)
    expect(loop.frames).toBeGreaterThan(0)
  })
})

describe('on-demand mode (reduced motion)', () => {
  test('draws exactly once per request and never on its own', () => {
    const { host, loop } = makeLoop()
    loop.setMode('on-demand')
    loop.start()
    host.run(1, 60)
    const settled = loop.frames
    expect(settled).toBe(1)
    host.run(2, 60)
    expect(loop.frames).toBe(settled)
    loop.requestDraw()
    host.run(1, 60)
    expect(loop.frames).toBe(settled + 1)
    loop.requestDraw()
    loop.requestDraw()
    host.run(1, 60)
    expect(loop.frames).toBe(settled + 2)
  })

  test('nothing is queued while idle', () => {
    const { host, loop } = makeLoop()
    loop.setMode('on-demand')
    loop.start()
    host.run(0.1, 60)
    expect(host.pending).toBe(0)
  })

  test('switching from continuous stops the stream after one still frame', () => {
    const { host, loop } = makeLoop()
    loop.start()
    host.run(1, 60)
    loop.setMode('on-demand')
    host.run(0.5, 60)
    const still = loop.frames
    host.run(2, 60)
    expect(loop.frames).toBe(still)
    expect(host.pending).toBe(0)
  })

  test('switching back to continuous resumes the stream', () => {
    const { host, loop } = makeLoop()
    loop.setMode('on-demand')
    loop.start()
    host.run(0.2, 60)
    const still = loop.frames
    loop.setMode('continuous')
    host.run(1, 60)
    expect(loop.frames).toBeGreaterThan(still + 25)
  })

  test('a request made while hidden is drawn once the tab is shown', () => {
    const { host, loop } = makeLoop()
    loop.setMode('on-demand')
    loop.start()
    host.run(0.1, 60)
    host.setHidden(true)
    loop.requestDraw()
    host.run(0.5, 60)
    const before = loop.frames
    host.setHidden(false)
    host.run(0.2, 60)
    expect(loop.frames).toBe(before + 1)
  })

  test('a request made from inside a draw is not lost', () => {
    const host = new FakeHost()
    let calls = 0
    const loop: FrameLoop = new FrameLoop(host, () => {
      calls++
      if (calls === 1) loop.requestDraw()
    })
    loop.setMode('on-demand')
    loop.start()
    host.run(0.5, 60)
    expect(calls).toBe(2)
  })
})

describe('lifecycle', () => {
  test('stop() cancels the queued frame and stops listening; nothing draws afterwards', () => {
    const { host, loop } = makeLoop()
    loop.start()
    host.advance(17)
    expect(host.pending).toBe(1)
    loop.stop()
    expect(host.pending).toBe(0)
    expect(host.watchers).toBe(0)
    const frames = loop.frames
    host.run(1, 60)
    expect(loop.frames).toBe(frames)
  })

  test('start() twice does not double the frame rate', () => {
    const { host, loop } = makeLoop()
    loop.start()
    loop.start()
    host.run(1, 60)
    expect(loop.frames).toBeLessThanOrEqual(30)
    expect(host.watchers).toBe(1)
  })

  test('requestDraw before start() draws nothing', () => {
    const { host, loop } = makeLoop()
    loop.requestDraw()
    host.run(0.2, 60)
    expect(loop.frames).toBe(0)
  })
})

describe('drawP95', () => {
  test('is 0 before any frame', () => {
    expect(makeLoop().loop.drawP95()).toBe(0)
  })

  test('is the cost of an ordinary draw when they are all alike', () => {
    const { host, loop } = makeLoop(2)
    loop.start()
    host.run(2, 60)
    expect(loop.drawP95()).toBe(2)
  })

  test('reflects slow draws once they are more than one in twenty', () => {
    const host = new FakeHost()
    let n = 0
    const loop = new FrameLoop(host, () => {
      n++
      host.time += n % 5 === 0 ? 25 : 1
    })
    loop.start()
    host.run(3, 60)
    expect(loop.drawP95()).toBe(25)
  })

  test('one slow draw in a hundred does not move it', () => {
    const host = new FakeHost()
    let n = 0
    const loop = new FrameLoop(host, () => {
      n++
      host.time += n === 40 ? 200 : 1
    })
    loop.start()
    host.run(3, 60)
    expect(loop.drawP95()).toBe(1)
  })
})

// R2-5: a value the draw cannot handle may stop a frame, never the loop.
describe('a draw that throws', () => {
  test('is reported once, and the loop keeps running and draws again', () => {
    const host = new FakeHost()
    const errors: unknown[] = []
    let calls = 0
    const loop = new FrameLoop(
      host,
      () => {
        calls++
        if (calls <= 3) throw new TypeError(`bad value ${calls}`)
      },
      (error) => errors.push(error)
    )
    loop.start()
    host.run(1, 60)
    expect(calls).toBeGreaterThan(10) // it kept asking for frames after the first throw
    expect(errors).toHaveLength(1) // and said so once, however many frames threw
    expect((errors[0] as Error).message).toBe('bad value 1')
    expect(loop.frames).toBe(calls - 3) // only the frames that were drawn are counted
    expect(host.pending).toBe(1) // still scheduled
  })

  test('a loop with no error handler still survives a throwing draw', () => {
    const host = new FakeHost()
    let calls = 0
    const loop = new FrameLoop(host, () => {
      calls++
      throw new Error('always')
    })
    loop.start()
    host.run(1, 60)
    expect(calls).toBeGreaterThan(10)
    expect(host.pending).toBe(1)
  })
})
