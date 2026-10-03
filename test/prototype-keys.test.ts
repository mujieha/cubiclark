// S1-1: an id that is also a property of every plain object (`constructor`, `__proto__`, ...) must
// never crash the reducer or corrupt a count. Such an id is not a real Claude Code id, so the event
// is ignored, leaves one source error, and everything else carries on.

import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TaskFoldersAdapter } from '../src/server/adapters/task-folders.js'
import { applyAdapters } from '../src/core/adapters/apply.js'
import { agentCard, defaultTaskId } from '../src/core/hud.js'
import { reduce } from '../src/core/reducer.js'
import { isSafeKey, bump, ownEntry } from '../src/core/keys.js'
import { classifyPath } from '../src/core/transcript/paths.js'
import { normaliseHookLine, initialHookNormState } from '../src/core/hooks/normalise.js'
import { parseLog } from '../src/core/adapters/task-log.js'
import { mergeUnparsedBy } from '../src/core/world.js'
import type { Agent, AgentEvent, Task, World } from '../src/core/types.js'
import { emptyWorld } from '../src/core/world.js'

const TS = '2026-01-15T10:00:00.000Z'
const UNSAFE = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']

function run(events: AgentEvent[], from: World = emptyWorld(TS, '/root')): World {
  return events.reduce((w, e) => reduce(w, e), from)
}

describe('isSafeKey', () => {
  test('names every plain object already has are unsafe; ordinary ids are safe', () => {
    for (const key of UNSAFE) expect(isSafeKey(key), key).toBe(false)
    expect(isSafeKey('')).toBe(false)
    expect(isSafeKey('00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isSafeKey('fx000000000000001')).toBe(true)
  })

  test('bump counts under an own property, even for a name every object has', () => {
    const map: Record<string, number> = {}
    bump(map, 'constructor')
    bump(map, 'constructor')
    bump(map, '__proto__')
    bump(map, 'ordinary')
    expect(map.ordinary).toBe(1)
    expect(map['(invalid)']).toBe(3)
    expect(Object.keys(map).sort()).toEqual(['(invalid)', 'ordinary'])
  })
})

describe('the reducer', () => {
  test.each(UNSAFE)('a prompt for an agent called %s is ignored and the next agent is fine', (id) => {
    const world = run([
      { t: 'prompt', ts: TS, agentId: id },
      { t: 'prompt', ts: TS, agentId: id },
      { t: 'prompt', ts: TS, agentId: 'good' },
    ])
    expect(Object.keys(world.agents)).toEqual(['good'])
    expect(world.agents.good?.counters.prompts).toBe(1)
    expect(world.diagnostics.sourceErrors.length).toBeGreaterThan(0)
  })

  test.each(UNSAFE)('a subagent link whose parent is called %s is ignored', (id) => {
    const world = run([{ t: 'subagent_link', ts: TS, agentId: 'child', parentId: id, agentType: 'Explore' }])
    expect(world.agents.child).toBeUndefined()
  })

  test.each(UNSAFE)('a hook_seen and a session start for %s do not throw', (id) => {
    const world = run([
      { t: 'hook_seen', ts: TS, agentId: id, tools: false },
      { t: 'session_start', ts: TS, agentId: id, source: 'startup' },
      { t: 'tool_start', ts: TS, agentId: id, toolUseId: 't1', name: 'Bash' },
    ])
    expect(Object.keys(world.agents)).toEqual([])
  })

  test('the same complaint is not repeated for every event', () => {
    const events: AgentEvent[] = Array.from({ length: 100 }, () => ({ t: 'prompt', ts: TS, agentId: 'constructor' }))
    const world = run(events)
    expect(world.diagnostics.sourceErrors).toHaveLength(1)
  })

  test('diagnostics for a type called constructor count as numbers', () => {
    // JSON.parse, as real input arrives: an object literal's __proto__ would set the prototype instead.
    const unknownTypes = JSON.parse('{"constructor":1,"__proto__":1}') as Record<string, number>
    const event: AgentEvent = { t: 'diagnostics', ts: TS, unparsed: 2, unknownTypes, versions: [] }
    const world = run([event, event])
    for (const count of Object.values(world.diagnostics.unknownTypes)) expect(typeof count).toBe('number')
    expect(world.diagnostics.unknownTypes['(invalid)']).toBe(4)
  })

  test('mergeUnparsedBy counts a record type called constructor under (invalid)', () => {
    const types = JSON.parse('{"constructor":2,"__proto__":1}') as Record<string, number>
    const merged = mergeUnparsedBy({}, { unknown_type: types })
    expect(merged.unknown_type).toEqual({ '(invalid)': 3 })
  })
})

describe('the file layout', () => {
  test('a transcript, subagent transcript or sidecar named after an object property is ignored', () => {
    for (const id of UNSAFE) {
      expect(classifyPath(`projects/-demo/${id}.jsonl`).kind, id).toBe('ignore')
      expect(classifyPath(`projects/-demo/${id}/subagents/agent-a1.jsonl`).kind, id).toBe('ignore')
      expect(classifyPath(`projects/-demo/s1/subagents/agent-${id}.jsonl`).kind, id).toBe('ignore')
      expect(classifyPath(`projects/-demo/s1/subagents/agent-${id}.meta.json`).kind, id).toBe('ignore')
    }
    expect(classifyPath('projects/-demo/s1.jsonl').kind).toBe('session')
  })
})

describe('hook lines', () => {
  test.each(UNSAFE)('a stored line with sid %s becomes no events and is not an unknown shape', (id) => {
    const line = JSON.stringify({ v: 1, ts: TS, e: 'UserPromptSubmit', sid: id })
    const result = normaliseHookLine(line, initialHookNormState())
    expect(result.events).toEqual([])
    expect(result.unknownShape).toBe(true)
  })

  test('an aid that is an object property is refused too', () => {
    const line = JSON.stringify({ v: 1, ts: TS, e: 'PreToolUse', sid: 's1', aid: 'constructor', tool: 'Bash', tuid: 't1' })
    const result = normaliseHookLine(line, initialHookNormState())
    expect(result.events).toEqual([])
    expect(result.unknownShape).toBe(true)
  })
})

describe('task ids (R2-5)', () => {
  const SESSION = '00000000-0000-4000-8000-0000000000aa'
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cubiclark-taskkeys-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('a task folder named like an object property is skipped, counted once, and links nothing', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 'good']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'TASK.md'), `# ${name}\nGoal: g\nProject: /work/demo\n`)
      await writeFile(join(root, name, 'LOG.md'), `${TS} dispatched session ${SESSION} in /work/demo model=claude-opus-5-5 effort=high perms=default\n`)
    }
    const adapter = new TaskFoldersAdapter({ roots: [root], orchestratorCwds: [], windowHours: null }, { nowMs: () => Date.parse(TS), home: '/home/user' })
    const snap = await adapter.snapshot()
    expect((snap.tasks ?? []).map((task) => task.id)).toEqual(['good'])
    expect((snap.links ?? []).map((l) => l.taskId)).toEqual(['good'])
    expect(snap.diagnostics.errors.filter((e) => e.includes('skipped'))).toEqual(['skipped 3 task folders named like an object property'])
  })

  const SNAPSHOT_AT = Date.parse(TS)
  const emptySnapshot = { tasks: [], links: [], diagnostics: { unparsed: 0, errors: [] } }

  function worldWithTaskId(taskId: string): World {
    const world = run([{ t: 'prompt', ts: TS, agentId: 'a1' }])
    return { ...world, agents: { ...world.agents, a1: { ...(world.agents.a1 as Agent), taskId } } }
  }

  test('a task that has left the snapshot is forgotten by its agent', () => {
    for (const id of ['constructor', '__proto__', 'good']) {
      const next = applyAdapters(worldWithTaskId(id), emptySnapshot, SNAPSHOT_AT, { replay: false })
      expect(next.agents.a1?.taskId, id).toBeUndefined()
    }
  })

  test('a snapshot that carries no tasks at all (quota only) leaves the task id alone', () => {
    const world = worldWithTaskId('good')
    const withTask: World = { ...world, tasks: { good: { id: 'good', timeline: [] } as unknown as Task } }
    const next = applyAdapters(withTask, { diagnostics: { unparsed: 0, errors: [] } }, SNAPSHOT_AT, { replay: false })
    expect(next.agents.a1?.taskId).toBe('good')
  })

  test.each(['constructor', '__proto__', 'toString'])('a selected agent whose task id is %s has no default task, and its card does not throw', (id) => {
    const world = worldWithTaskId(id) // tasks: {}
    expect(defaultTaskId(world, 'a1')).toBeUndefined()
    expect(() => agentCard(world, 'a1', SNAPSHOT_AT)).not.toThrow()
    expect(ownEntry(world.tasks, id)).toBeUndefined()
  })

  test('ownEntry finds an own entry, even one called constructor, and nothing inherited', () => {
    const tasks = JSON.parse('{"constructor":{"id":"constructor"},"good":{"id":"good"}}') as Record<string, { id: string }>
    expect(ownEntry(tasks, 'constructor')).toEqual({ id: 'constructor' })
    expect(ownEntry(tasks, 'good')).toEqual({ id: 'good' })
    expect(ownEntry(tasks, 'toString')).toBeUndefined()
    expect(ownEntry({}, '__proto__')).toBeUndefined()
    expect(ownEntry(tasks, undefined)).toBeUndefined()
  })

  test('no source file looks a task up with a bare tasks[...]', () => {
    const files = (readdirSync(new URL('../src', import.meta.url), { recursive: true }) as string[]).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(50)
    for (const name of files) {
      const text = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
      expect(/\btasks\??\.?\[/.test(text), `src/${name} indexes tasks directly`).toBe(false)
    }
  })
})

describe('task-log verbs', () => {
  test('an unknown verb called constructor is counted as a number', () => {
    const log = parseLog(`${TS} constructor a\n${TS} constructor b\n${TS} __proto__ c`)
    for (const count of Object.values(log.unknownVerbs)) expect(typeof count).toBe('number')
    expect(log.unknownVerbs['(invalid)']).toBe(3)
  })
})
