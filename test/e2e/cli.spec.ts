// Raw HTTP checks the browser fixture can't do (Playwright's `fetch`/`page.goto` cannot set a
// custom Host header — that's controlled by the URL alone), run against the real, built CLI.

import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { runCli } from './helpers.js'

const FIXTURE_HOME = fileURLToPath(new URL('../fixtures/home', import.meta.url))

function requestStatus(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

test.describe('CLI HTTP surface (raw http.request)', () => {
  test('no token -> 403', async () => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
    try {
      expect(await requestStatus(cli.port, '/', `127.0.0.1:${cli.port}`)).toBe(403)
    } finally {
      await cli.stop()
    }
  })

  test('a foreign Host header -> 403, even with the correct token', async () => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
    try {
      expect(await requestStatus(cli.port, `/${cli.token}/`, 'evil.example')).toBe(403)
    } finally {
      await cli.stop()
    }
  })

  test('the correct token and Host -> 200', async () => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
    try {
      expect(await requestStatus(cli.port, `/${cli.token}/`, `127.0.0.1:${cli.port}`)).toBe(200)
    } finally {
      await cli.stop()
    }
  })
})
