import { appendFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { serialiseStoredLine, toStoredLine } from '../src/core/hooks/whitelist.js'
import type { AgentEvent } from '../src/core/types.js'
import { HookSource, type HookSourceOptions } from '../src/server/hook-source.js'

let dir: string
let eventsFile: string
let open: HookSource[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubiclark-hooksource-'))
  eventsFile = join(dir, 'events.jsonl')
})

afterEach(async () => {
  for (const source of open) source.stop()
  open = []
  await rm(dir, { recursive: true, force: true })
})

const T = (n: number): string => new Date(Date.parse('2026-01-15T10:00:00.000Z') + n * 1000).toISOString()

function line(payload: Record<string, unknown>, n: number): string {
  return serialiseStoredLine(toStoredLine(payload, T(n)))
}

const prompt = (n: number): string => line({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, n)

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function makeSource(overrides: Partial<HookSourceOptions> = {}): { source: HookSource; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const source = new HookSource({
    eventsFile,
    sinceMs: null,
    watch: false,
    pollMs: 20,
    onEvents: (batch) => events.push(...batch),
    nowMs: () => Date.parse(T(100)),
    ...overrides,
  })
  open.push(source)
  return { source, events }
}

const prompts = (events: AgentEvent[]): number => events.filter((e) => e.t === 'prompt').length

describe('HookSource', () => {
  test('lines already in the file are delivered on start', async () => {
    await writeFile(eventsFile, prompt(1) + prompt(2))
    const { source, events } = makeSource()
    await source.start()
    expect(prompts(events)).toBe(2)
    expect(source.getStats()).toMatchObject({ events: 2, lastEventTs: T(2) })
  })

  test('lines appended after start arrive through the poll alone (no fs.watch)', async () => {
    await writeFile(eventsFile, prompt(1))
    const { source, events } = makeSource({ watch: false })
    await source.start()
    await appendFile(eventsFile, prompt(2))
    await waitFor(() => prompts(events) === 2)
  })

  test('with fs.watch on as well as the poll, an appended line is delivered exactly once', async () => {
    // fs.watch is only ever a speed-up (the poll always runs beneath it), and it is not
    // deterministic: macOS FSEvents can miss a change made just after the watcher is created, and
    // under a parallel test run it can lag. So this does not assert that the watch alone is fast;
    // it asserts that having both running never drops or duplicates a line.
    await writeFile(eventsFile, prompt(1))
    const { source, events } = makeSource({ watch: true, pollMs: 100 })
    await source.start()
    await appendFile(eventsFile, prompt(2))
    await waitFor(() => prompts(events) === 2)
    await new Promise((resolve) => setTimeout(resolve, 400)) // several more polls and watch events
    expect(prompts(events)).toBe(2)
  })

  test('a partial trailing line is held back until its newline arrives', async () => {
    const whole = prompt(2)
    await writeFile(eventsFile, prompt(1) + whole.slice(0, 20))
    const { source, events } = makeSource()
    await source.start()
    expect(prompts(events)).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(prompts(events)).toBe(1)
    await appendFile(eventsFile, whole.slice(20))
    await waitFor(() => prompts(events) === 2)
  })

  test('a missing file is not an error; lines appear once it is created', async () => {
    const { source, events } = makeSource()
    await source.start()
    expect(source.getStats().error).toBeUndefined()
    await writeFile(eventsFile, prompt(1))
    await waitFor(() => prompts(events) === 1)
  })

  test('rotation: the file renamed away and a fresh one started is still followed', async () => {
    await writeFile(eventsFile, prompt(1) + prompt(2) + prompt(3))
    const { source, events } = makeSource()
    await source.start()
    expect(prompts(events)).toBe(3)
    await rename(eventsFile, join(dir, 'events.1.jsonl'))
    await writeFile(eventsFile, prompt(4))
    await waitFor(() => prompts(events) === 4)
  })

  test('deleted and recreated with longer content is read from the start', async () => {
    await writeFile(eventsFile, prompt(1))
    const { source, events } = makeSource()
    await source.start()
    await unlink(eventsFile)
    await new Promise((resolve) => setTimeout(resolve, 60)) // let a poll see it missing
    await writeFile(eventsFile, prompt(2) + prompt(3) + prompt(4))
    await waitFor(() => prompts(events) === 4)
  })

  test('the age window drops old lines but still remembers the subagents they started', async () => {
    const start = line({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore' }, 1)
    const stop = line({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'agent-x1', agent_type: 'Explore' }, 50)
    await writeFile(eventsFile, start + stop)
    const { source, events } = makeSource({ sinceMs: Date.parse(T(40)) })
    await source.start()
    const kinds = events.map((e) => e.t)
    expect(kinds).not.toContain('subagent_link') // the start is outside the window...
    expect(kinds).toContain('turn_end') // ...but its stop, inside it, is still recognised as a real subagent's
  })

  test('a malformed line is counted, not thrown', async () => {
    await writeFile(eventsFile, 'garbage\n' + prompt(1) + '{"v":1,"ts":"2026-01-15T10:00:00.000Z","e":"_malformed"}\n')
    const { source, events } = makeSource()
    await source.start()
    expect(prompts(events)).toBe(1)
    const diag = events.find((e) => e.t === 'diagnostics')
    expect(diag).toMatchObject({ t: 'diagnostics', unparsed: 1, unknownHookShapes: 1 })
  })

  test('an events file inside a directory that does not exist yet is picked up when it appears', async () => {
    eventsFile = join(dir, 'later', 'events.jsonl')
    const { source, events } = makeSource({ watch: true })
    await source.start()
    await mkdir(join(dir, 'later'))
    await writeFile(eventsFile, prompt(1))
    await waitFor(() => prompts(events) === 1)
  })
})
