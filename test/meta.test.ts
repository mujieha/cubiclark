import { describe, expect, test } from 'vitest'
import { parseSubagentMeta } from '../src/core/transcript/meta.js'

describe('parseSubagentMeta', () => {
  test('parses a full meta file', () => {
    const result = parseSubagentMeta(
      JSON.stringify({
        agentType: 'Explore',
        description: 'look around',
        toolUseId: 'toolu_fx000001',
        model: 'claude-sonnet-5',
        spawnDepth: 1,
      })
    )
    expect(result).toEqual({
      ok: true,
      meta: {
        agentType: 'Explore',
        description: 'look around',
        toolUseId: 'toolu_fx000001',
        model: 'claude-sonnet-5',
        name: undefined,
        spawnDepth: 1,
      },
    })
  })

  test('parses a minimal meta file with only agentType', () => {
    const result = parseSubagentMeta(JSON.stringify({ agentType: 'Explore' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.agentType).toBe('Explore')
      expect(result.meta.name).toBeUndefined()
    }
  })

  test('a name field marks a named teammate', () => {
    const result = parseSubagentMeta(JSON.stringify({ agentType: 'reviewer', name: 'Rex' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meta.name).toBe('Rex')
  })

  test('garbage input is reported, never thrown', () => {
    expect(parseSubagentMeta('{not json')).toEqual({ ok: false, error: expect.any(String) })
    expect(parseSubagentMeta('[]')).toEqual({ ok: false, error: 'not a JSON object' })
    expect(parseSubagentMeta('null')).toEqual({ ok: false, error: 'not a JSON object' })
    expect(parseSubagentMeta('"just a string"')).toEqual({ ok: false, error: 'not a JSON object' })
  })

  // R2-7: a label from a sidecar follows the collector's rule too.
  test('an agentType that is too long, or holds a control character or a separator, gives no label', () => {
    for (const bad of ['x'.repeat(200), 'a\u001b[2Jb', 'a/b']) {
      const result = parseSubagentMeta(JSON.stringify({ agentType: bad }))
      expect(result.ok && result.meta.agentType === undefined, JSON.stringify(bad.slice(0, 12))).toBe(true)
    }
    const fine = parseSubagentMeta(JSON.stringify({ agentType: 'Explore' }))
    expect(fine.ok && fine.meta.agentType).toBe('Explore')
  })

  test('a name that is too long still makes a teammate, and is never kept as text', () => {
    const result = parseSubagentMeta(JSON.stringify({ name: 'n'.repeat(200) }))
    expect(result.ok && result.meta.name === 'teammate').toBe(true)
    const absent = parseSubagentMeta(JSON.stringify({ agentType: 'Explore' }))
    expect(absent.ok && absent.meta.name).toBeUndefined()
    const fine = parseSubagentMeta(JSON.stringify({ name: 'researcher' }))
    expect(fine.ok && fine.meta.name).toBe('researcher')
  })
})
