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
})
