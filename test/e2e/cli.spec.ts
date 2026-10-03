// Raw HTTP checks the browser fixture can't do (Playwright's `fetch`/`page.goto` cannot set a
// custom Host header — that's controlled by the URL alone), run against the real, built CLI.

import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { login, rawGet, runCli } from './helpers.js'

const FIXTURE_HOME = fileURLToPath(new URL('../fixtures/home', import.meta.url))

test.describe('CLI HTTP surface (raw http.request)', () => {
  test('no cookie -> 403, on every route', async () => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
    try {
      for (const path of ['/', '/events', '/world.json', '/page-options.json', '/custom-assets.json']) {
        expect((await rawGet(cli, path)).status, path).toBe(403)
      }
      // the old tokenised path is not a way in either
      expect((await rawGet(cli, '/some-token/')).status).toBe(403)
    } finally {
      await cli.stop()
    }
  })

  test('a foreign Host header -> 403, even with the one-time code and with the cookie', async () => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
    try {
      expect((await rawGet(cli, `/${cli.code}/`, { host: 'evil.example' })).status).toBe(403)
      // the refused attempt did not spend the code
      const cookie = await login(cli)
      expect((await rawGet(cli, '/', { host: 'evil.example', cookie })).status).toBe(403)
    } finally {
      await cli.stop()
    }
  })

  test('the one-time link -> 303 to a code-free page with a cookie; the cookie and Host -> 200; a second use without the cookie -> 403', async () => {
    const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
    try {
      const first = await rawGet(cli, `/${cli.code}/`)
      expect(first.status).toBe(303)
      expect(first.location).toBe('/')
      expect(first.setCookie?.[0]).toMatch(/; HttpOnly; SameSite=Strict; Path=\/$/)
      const cookie = (first.setCookie?.[0] ?? '').split(';')[0] as string

      expect((await rawGet(cli, '/', { cookie })).status).toBe(200)
      // HEAD: a GET of the event stream would never end
      expect((await rawGet(cli, '/events', { cookie, method: 'HEAD' })).status).toBe(200)
      expect((await rawGet(cli, '/events', { method: 'HEAD' })).status).toBe(403)
      expect((await rawGet(cli, `/${cli.code}/`)).status).toBe(403)
      expect((await rawGet(cli, '/')).status).toBe(403)
    } finally {
      await cli.stop()
    }
  })
})
