// The one-time link, on the real page and the real built CLI (S1-11): the browser trades the code in the
// opened URL for an HttpOnly cookie and is redirected to a code-free URL; the secret is never in the page's
// URL or in stdout; a browser without the cookie gets 403 on every route, and the used link does not work
// a second time.

import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { runCli } from './helpers.js'

const FIXTURE_HOME = fileURLToPath(new URL('../fixtures/home', import.meta.url))

test('the opened link works once: a code-free URL, an HttpOnly cookie, a working page, and nothing secret in stdout', async ({ page, context }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
  try {
    expect(cli.url).toBe(`${cli.origin}/${cli.code}/`)
    await page.goto(`${cli.url}#list`)

    // the redirect left a URL with neither the code nor anything else secret, and kept the fragment
    const url = new URL(page.url())
    expect(url.pathname).toBe('/')
    expect(url.search).toBe('')
    expect(url.hash).toBe('#list')
    expect(page.url()).not.toContain(cli.code)

    // the page works with the cookie alone: it fetched its options and asset list, and the list shows the agents
    await expect(page.locator('table tbody tr')).toHaveCount(5)

    // the cookie: HttpOnly (the page's own script cannot read it), SameSite=Strict, for the whole origin
    const cookies = await context.cookies(cli.origin)
    const session = cookies.find((c) => c.name === `cubiclark-${cli.port}`)
    expect(session).toBeDefined()
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/', secure: false })
    const token = session?.value ?? ''
    expect(token.length).toBeGreaterThanOrEqual(40)
    expect(token).not.toBe(cli.code)
    expect(await page.evaluate(() => document.cookie)).toBe('')
    expect(page.url()).not.toContain(token)
    expect(await page.content()).not.toContain(token)

    // stdout names the one-time link and never the cookie's value
    expect(cli.stdout()).toContain(cli.url)
    expect(cli.stdout()).not.toContain(token)

    // a reload is the same page: the cookie, not the code, is what lets it in
    await page.reload()
    await expect(page.locator('table tbody tr')).toHaveCount(5)
  } finally {
    await cli.stop()
  }
})

test('a fresh browser context has no way in: 403 on the event stream, on the data, and on the used link', async ({ browser, page }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('#hud')).toBeVisible()

    const stranger = await browser.newContext()
    try {
      for (const path of ['/events', '/world.json', '/page-options.json', '/custom-assets.json', '/']) {
        expect((await stranger.request.get(`${cli.origin}${path}`)).status(), path).toBe(403)
      }
      const used = await stranger.newPage()
      const response = await used.goto(cli.url)
      expect(response?.status()).toBe(403)
      expect(await used.locator('body').innerText()).toContain('already used')
      // and it did not hand the stranger a cookie
      expect((await stranger.cookies(cli.origin)).filter((c) => c.name.startsWith('cubiclark-'))).toEqual([])
    } finally {
      await stranger.close()
    }

    // the first browser is unaffected
    expect((await page.request.get(`${cli.origin}/world.json`)).status()).toBe(200)
  } finally {
    await cli.stop()
  }
})

test('the cookie is what opens the event stream: the page is live with it, and the same cookie carried to another context opens it too', async ({ browser, page }) => {
  const cli = await runCli(['--fixture-home', FIXTURE_HOME, '--no-open', '--port', '0'])
  try {
    await page.goto(cli.url)
    await expect(page.locator('#hud-status')).toContainText('transcripts live')

    // the same cookie, sent by hand to a context that never used the link, opens the stream: it is the cookie that matters
    const cookies = await page.context().cookies(cli.origin)
    const borrowed = await browser.newContext()
    try {
      await borrowed.addCookies(cookies)
      expect((await borrowed.request.fetch(`${cli.origin}/events`, { method: 'HEAD' })).status()).toBe(200)
    } finally {
      await borrowed.close()
    }
  } finally {
    await cli.stop()
  }
})
