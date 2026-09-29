// Proves the two lint rules the office depends on actually fire: no HTML sinks anywhere (design §9,
// "all text through textContent or fillText, never innerHTML") and a pure src/core (design §3.7).
// The code under test is linted from memory with a made-up file path, so nothing on disk is touched.

import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = new ESLint({ cwd: REPO_ROOT })

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${REPO_ROOT}${filePath}` })
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'parse-error')
}

describe('the HTML-sink ban', () => {
  test('innerHTML is an error in the client', async () => {
    expect(await ruleIds('export function f(el: HTMLElement, x: string): void { el.innerHTML = x }\n', 'src/client/probe.ts')).toContain(
      'no-restricted-properties'
    )
  })

  test('outerHTML is an error in the client', async () => {
    expect(await ruleIds('export function f(el: HTMLElement, x: string): void { el.outerHTML = x }\n', 'src/client/probe.ts')).toContain(
      'no-restricted-properties'
    )
  })

  test('insertAdjacentHTML is an error in the client', async () => {
    const code = "export function f(el: HTMLElement, x: string): void { el.insertAdjacentHTML('beforeend', x) }\n"
    expect(await ruleIds(code, 'src/client/probe.ts')).toContain('no-restricted-properties')
  })

  test('textContent is fine', async () => {
    expect(await ruleIds('export function f(el: HTMLElement, x: string): void { el.textContent = x }\n', 'src/client/probe.ts')).toEqual([])
  })
})

describe('the purity rule for src/core', () => {
  test('Date.now() is an error', async () => {
    expect(await ruleIds('export const t = Date.now()\n', 'src/core/office/probe.ts')).toContain('no-restricted-properties')
  })

  test('touching document is an error', async () => {
    expect(await ruleIds('export const b = document.body\n', 'src/core/office/probe.ts')).toContain('no-restricted-globals')
  })

  test('the merged block still bans innerHTML', async () => {
    expect(await ruleIds('export function f(el: { innerHTML: string }): void { el.innerHTML = "x" }\n', 'src/core/office/probe.ts')).toContain(
      'no-restricted-properties'
    )
  })

  test('the same code is fine outside src/core', async () => {
    expect(await ruleIds('export const t = Date.now()\n', 'src/server/probe.ts')).toEqual([])
  })
})
