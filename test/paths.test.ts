import { describe, expect, test } from 'vitest'
import { classifyPath, projectName } from '../src/core/transcript/paths.js'

describe('classifyPath', () => {
  test('classifies a session transcript', () => {
    expect(classifyPath('projects/-home-user-projects-demo/00000000-0000-4000-8000-000000000001.jsonl')).toEqual({
      kind: 'session',
      sessionId: '00000000-0000-4000-8000-000000000001',
    })
  })

  test('classifies a subagent transcript', () => {
    expect(
      classifyPath(
        'projects/-home-user-projects-demo/00000000-0000-4000-8000-000000000003/subagents/agent-fx0000000000000e1.jsonl'
      )
    ).toEqual({
      kind: 'subagent',
      parentId: '00000000-0000-4000-8000-000000000003',
      agentId: 'fx0000000000000e1',
    })
  })

  test('classifies a subagent sidecar meta file', () => {
    expect(
      classifyPath(
        'projects/-home-user-projects-demo/00000000-0000-4000-8000-000000000003/subagents/agent-fx0000000000000e1.meta.json'
      )
    ).toEqual({
      kind: 'subagent-meta',
      parentId: '00000000-0000-4000-8000-000000000003',
      agentId: 'fx0000000000000e1',
    })
  })

  test('ignores files outside the known shape', () => {
    expect(classifyPath('.DS_Store')).toEqual({ kind: 'ignore' })
    expect(classifyPath('projects/-home-user-projects-demo/notes.txt')).toEqual({ kind: 'ignore' })
    expect(classifyPath('projects/-home-user-projects-demo/00000000-0000-4000-8000-000000000001/other.json')).toEqual(
      { kind: 'ignore' }
    )
  })

  test('normalizes backslashes and a leading slash', () => {
    expect(classifyPath('\\projects\\demo\\00000000-0000-4000-8000-000000000001.jsonl')).toEqual({
      kind: 'session',
      sessionId: '00000000-0000-4000-8000-000000000001',
    })
  })
})

describe('projectName', () => {
  test('is the cwd basename', () => {
    expect(projectName('/home/user/projects/demo')).toBe('demo')
    expect(projectName('/home/user/projects/shop')).toBe('shop')
  })

  test('handles a trailing slash', () => {
    expect(projectName('/home/user/projects/demo/')).toBe('demo')
  })
})
