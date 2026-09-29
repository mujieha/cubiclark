import { describe, expect, test } from 'vitest'
import {
  COLLECTOR_BASENAME,
  SettingsParseError,
  collectorEntries,
  collectorHandler,
  desiredEntries,
  detectFormat,
  isCollectorHandler,
  parseSettings,
  serialiseSettings,
  withCollector,
  withoutCollector,
} from '../src/core/hooks/settings.js'
import { PARSEABLE_FIXTURES, REFUSED_FIXTURES, SETTINGS_FIXTURES } from './hooks-fixtures.js'

const COLLECTOR = '/state/bin/hook/' + COLLECTOR_BASENAME

function fixture(name: string): string {
  const text = SETTINGS_FIXTURES[name]
  if (text === null || text === undefined) throw new Error(`no such fixture text: ${name}`)
  return text
}

describe('parseSettings', () => {
  for (const name of PARSEABLE_FIXTURES) {
    test(`accepts ${name}`, () => {
      expect(() => parseSettings(fixture(name))).not.toThrow()
    })
  }
  for (const name of REFUSED_FIXTURES) {
    test(`refuses ${name}`, () => {
      expect(() => parseSettings(fixture(name))).toThrow(SettingsParseError)
    })
  }
  test('refuses a hook group whose hooks is not an array, and an empty file', () => {
    expect(() => parseSettings('{"hooks":{"Stop":[{"hooks":"x"}]}}')).toThrow(SettingsParseError)
    expect(() => parseSettings('')).toThrow(SettingsParseError)
  })
})

describe('detectFormat and serialiseSettings', () => {
  test('detects indent, line ending and trailing newline', () => {
    expect(detectFormat(fixture('canonical'))).toEqual({ indent: '  ', eol: '\n', trailingNewline: true })
    expect(detectFormat(fixture('fourSpace'))).toEqual({ indent: '    ', eol: '\n', trailingNewline: false })
    expect(detectFormat(fixture('crlf'))).toEqual({ indent: '  ', eol: '\r\n', trailingNewline: true })
    expect(detectFormat(fixture('nonCanonical')).trailingNewline).toBe(false)
    expect(detectFormat(undefined)).toEqual({ indent: '  ', eol: '\n', trailingNewline: true })
  })

  test('a tab-indented file keeps its tabs', () => {
    expect(detectFormat('{\n\t"a": 1\n}\n').indent).toBe('\t')
  })

  for (const name of ['canonical', 'fourSpace', 'crlf'] as const) {
    test(`round trip keeps ${name} byte for byte`, () => {
      const text = fixture(name)
      expect(serialiseSettings(parseSettings(text), detectFormat(text))).toBe(text)
    })
  }
})

describe('collectorHandler', () => {
  test('exec form: node plus the collector path, async for the high-frequency events', () => {
    expect(collectorHandler('PreToolUse', COLLECTOR, undefined)).toEqual({
      type: 'command',
      command: 'node',
      args: [COLLECTOR],
      async: true,
      timeout: 5,
    })
  })

  test('the turn and session ends are synchronous', () => {
    for (const event of ['Stop', 'StopFailure', 'SubagentStop', 'SessionEnd'] as const) {
      const handler = collectorHandler(event, COLLECTOR, undefined)
      expect(handler.async).toBeUndefined()
      expect(handler.timeout).toBe(5)
    }
  })

  test('a non-default state dir is passed through --state-dir', () => {
    expect(collectorHandler('Stop', COLLECTOR, '/custom/state').args).toEqual([COLLECTOR, '--state-dir', '/custom/state'])
  })
})

describe('isCollectorHandler', () => {
  test('recognises the exec form and a hand-written shell form', () => {
    expect(isCollectorHandler(collectorHandler('Stop', COLLECTOR, undefined))).toBe(true)
    expect(isCollectorHandler({ type: 'command', command: `node /x/y/${COLLECTOR_BASENAME}` })).toBe(true)
    expect(isCollectorHandler({ type: 'command', command: `node "/x/y/${COLLECTOR_BASENAME}" --state-dir /z` })).toBe(true)
  })

  test('never claims a foreign handler, even one whose path mentions cubiclark', () => {
    expect(isCollectorHandler({ type: 'command', command: '/opt/cubiclark/lint.sh' })).toBe(false)
    expect(isCollectorHandler({ type: 'command', command: 'say done' })).toBe(false)
    expect(isCollectorHandler({ type: 'http', url: `http://x/${COLLECTOR_BASENAME}` })).toBe(false)
    expect(isCollectorHandler('nope')).toBe(false)
    expect(isCollectorHandler(null)).toBe(false)
  })
})

describe('withCollector and withoutCollector', () => {
  const desired = desiredEntries(COLLECTOR, undefined, true)

  test('desiredEntries: 14 events with tools, 11 without', () => {
    expect(desired).toHaveLength(14)
    const lifecycleOnly = desiredEntries(COLLECTOR, undefined, false)
    expect(lifecycleOnly).toHaveLength(11)
    expect(lifecycleOnly.some((d) => d.event.endsWith('ToolUse') || d.event === 'PostToolUseFailure')).toBe(false)
  })

  test('adds 14 entries to canonical and leaves the foreign groups first and intact', () => {
    const original = parseSettings(fixture('canonical'))
    const { settings, changed } = withCollector(original, desired)
    expect(changed).toBe(true)
    expect(collectorEntries(settings)).toHaveLength(14)
    const hooks = settings.hooks as Record<string, unknown[]>
    expect((hooks.PostToolUse as unknown[])[0]).toEqual((original.hooks as Record<string, unknown[]>).PostToolUse?.[0])
    expect((hooks.Stop as unknown[])[0]).toEqual((original.hooks as Record<string, unknown[]>).Stop?.[0])
    expect(hooks.PostToolUse).toHaveLength(2)
    expect(settings.permissions).toEqual(original.permissions)
  })

  test('is idempotent: a second application changes nothing and returns the same object', () => {
    const once = withCollector(parseSettings(fixture('canonical')), desired).settings
    const twice = withCollector(once, desired)
    expect(twice.changed).toBe(false)
    expect(twice.settings).toBe(once)
    expect(collectorEntries(twice.settings)).toHaveLength(14)
  })

  test('switching from lifecycle-only to all events adds the tool entries once', () => {
    const lifecycle = withCollector(parseSettings(fixture('empty')), desiredEntries(COLLECTOR, undefined, false)).settings
    expect(collectorEntries(lifecycle)).toHaveLength(11)
    const all = withCollector(lifecycle, desired)
    expect(all.changed).toBe(true)
    expect(collectorEntries(all.settings)).toHaveLength(14)
  })

  for (const name of PARSEABLE_FIXTURES) {
    test(`withoutCollector(withCollector(x)) deep-equals x for ${name}`, () => {
      const original = parseSettings(fixture(name))
      const added = withCollector(original, desired).settings
      const removed = withoutCollector(added)
      expect(removed.removed).toBe(14)
      expect(removed.settings).toEqual(original)
    })
  }

  test('withoutCollector keeps key order and touches nothing foreign', () => {
    const original = parseSettings(fixture('canonical'))
    const back = withoutCollector(withCollector(original, desired).settings).settings
    expect(Object.keys(back)).toEqual(Object.keys(original))
    expect(JSON.stringify(back)).toBe(JSON.stringify(original))
  })

  test('withoutCollector on a file with none of ours returns the same object', () => {
    const original = parseSettings(fixture('canonical'))
    const result = withoutCollector(original)
    expect(result.removed).toBe(0)
    expect(result.settings).toBe(original)
  })

  test('a collector handler that shares a matcher group with a foreign one leaves the foreign one', () => {
    const mixed = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }, collectorHandler('Stop', COLLECTOR, undefined)] }],
      },
    }
    const result = withoutCollector(mixed)
    expect(result.removed).toBe(1)
    expect(result.settings).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
  })
})
