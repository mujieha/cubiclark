import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ServerResponse } from 'node:http'
import { WorldText, cookieValues, createHttpServer, sendSse, sessionCookieName } from '../src/server/http.js'
import { Store } from '../src/server/store.js'
import type { RunningHttpServer } from '../src/server/http.js'

interface Response {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(
  port: number,
  path: string,
  opts: { host?: string; origin?: string; method?: string; cookie?: string } = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          Host: opts.host ?? `127.0.0.1:${port}`,
          ...(opts.origin ? { Origin: opts.origin } : {}),
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

let clientDir: string
let server: RunningHttpServer
let store: Store
/** The Cookie header value of a browser that has used the one-time link of `server`. */
let cookie: string
const token = 'test-run-token-0123456789'
const code = 'one-time-code-abcdefghij'

/** Uses the one-time link and returns the cookie a browser would send back. */
async function login(target: RunningHttpServer): Promise<string> {
  const res = await request(target.port, `/${code}/`)
  expect(res.status).toBe(303)
  const set = res.headers['set-cookie']?.[0] ?? ''
  return set.split(';')[0] as string
}

/** A server whose one-time code has not been used. */
function fresh(extra: Partial<Parameters<typeof createHttpServer>[0]> = {}): Promise<RunningHttpServer> {
  return createHttpServer({ token, bootstrapCode: code, port: 0, clientDir, store, ...extra })
}

beforeEach(async () => {
  clientDir = await mkdtemp(join(tmpdir(), 'cubiclark-http-'))
  await writeFile(join(clientDir, 'index.html'), '<!doctype html><title>t</title>', 'utf8')
  await mkdir(join(clientDir, 'assets'), { recursive: true })
  await writeFile(join(clientDir, 'assets', 'app.js'), 'console.log(1)', 'utf8')

  store = new Store({ nowMs: () => Date.now(), transcriptsRoot: '/root' })
  server = await fresh()
  cookie = await login(server)
})

afterEach(async () => {
  await server.close()
  store.stop()
  await rm(clientDir, { recursive: true, force: true })
})

describe('the one-time link (S1-11)', () => {
  test('the first use sets an HttpOnly, SameSite=Strict, Path=/ cookie named for the port, and redirects to a code-free /', async () => {
    const other = await fresh()
    try {
      const res = await request(other.port, `/${code}/`)
      expect(res.status).toBe(303)
      expect(res.headers.location).toBe('/')
      expect(res.headers['set-cookie']).toEqual([`${sessionCookieName(other.port)}=${token}; HttpOnly; SameSite=Strict; Path=/`])
      // plain http on 127.0.0.1: a Secure cookie would never be sent back
      expect(res.headers['set-cookie']?.[0]).not.toMatch(/Secure/i)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers.location).not.toContain(code)
    } finally {
      await other.close()
    }
  })

  test('the printed url carries the code and never the token', async () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/${code}/`)
    expect(server.url).not.toContain(token)
  })

  test('a random code is made when none is given, and it is not the token', async () => {
    const other = await createHttpServer({ token, port: 0, clientDir, store })
    try {
      const path = new URL(other.url).pathname
      expect(path).toMatch(/^\/[A-Za-z0-9_-]{43}\/$/)
      expect(path).not.toContain(token)
    } finally {
      await other.close()
    }
  })

  test('a second use without the cookie is 403, and the same browser with the cookie is sent on to the page', async () => {
    const again = await request(server.port, `/${code}/`)
    expect(again.status).toBe(403)
    expect(again.headers['set-cookie']).toBeUndefined()
    expect(again.body).toContain('already used')

    const mine = await request(server.port, `/${code}/`, { cookie })
    expect(mine.status).toBe(303)
    expect(mine.headers.location).toBe('/')
    expect(mine.headers['set-cookie']).toBeUndefined()
  })

  test('two uses at the same moment: exactly one gets the cookie', async () => {
    const other = await fresh()
    try {
      const all = await Promise.all(Array.from({ length: 8 }, () => request(other.port, `/${code}/`)))
      expect(all.filter((r) => r.status === 303 && r.headers['set-cookie'] !== undefined)).toHaveLength(1)
      expect(all.filter((r) => r.status === 403)).toHaveLength(7)
    } finally {
      await other.close()
    }
  })

  test('a wrong code, a near miss and the code without its slash are 403 and do not spend the real one', async () => {
    const other = await fresh()
    try {
      for (const path of ['/not-the-code/', `/${code.slice(0, -1)}/`, `/${code}x/`, `/${code}`, `/${code}//`]) {
        expect((await request(other.port, path)).status, path).toBe(403)
      }
      expect((await request(other.port, `/${code}/`)).status).toBe(303)
    } finally {
      await other.close()
    }
  })

  test('HEAD does not spend the code', async () => {
    const other = await fresh()
    try {
      expect((await request(other.port, `/${code}/`, { method: 'HEAD' })).status).toBe(403)
      expect((await request(other.port, `/${code}/`)).status).toBe(303)
    } finally {
      await other.close()
    }
  })

  test('a foreign Host or Origin is refused before the code is looked at, and does not spend it', async () => {
    const other = await fresh()
    try {
      expect((await request(other.port, `/${code}/`, { host: 'evil.example' })).status).toBe(403)
      expect((await request(other.port, `/${code}/`, { origin: 'http://evil.example' })).status).toBe(403)
      expect((await request(other.port, `/${code}/`)).status).toBe(303)
    } finally {
      await other.close()
    }
  })

  test('POST to the one-time link is 405 and does not spend it', async () => {
    const other = await fresh()
    try {
      expect((await request(other.port, `/${code}/`, { method: 'POST' })).status).toBe(405)
      expect((await request(other.port, `/${code}/`)).status).toBe(303)
    } finally {
      await other.close()
    }
  })
})

describe('every route requires the cookie', () => {
  const ROUTES = ['/', '/index.html', '/assets/app.js', '/events', '/world.json', '/page-options.json', '/custom-assets.json']

  test.each(ROUTES)('%s: 403 without a cookie, before and after the link was used', async (path) => {
    const other = await fresh()
    try {
      expect((await request(other.port, path)).status).toBe(403)
      await login(other)
      expect((await request(other.port, path)).status).toBe(403)
      expect((await request(other.port, path, { method: 'HEAD' })).status).toBe(403)
    } finally {
      await other.close()
    }
  })

  test.each(ROUTES.filter((path) => path !== '/events'))('%s: 200 with the cookie', async (path) => {
    expect((await request(server.port, path, { cookie })).status).toBe(200)
  })

  test('a wrong cookie value, another run\'s cookie name and a cookie of the right name for the wrong port are 403', async () => {
    const name = sessionCookieName(server.port)
    for (const header of [`${name}=wrong`, `${name}=${token}x`, `${name}=${token.slice(0, -1)}`, `${name}=`, `cubiclark-1=${token}`, `${sessionCookieName(server.port + 1)}=${token}`, `other=${token}`, token]) {
      expect((await request(server.port, '/world.json', { cookie: header })).status, header).toBe(403)
    }
  })

  test('the cookie is found among others, and when the name is there twice either may match', async () => {
    const name = sessionCookieName(server.port)
    expect((await request(server.port, '/world.json', { cookie: `a=1; ${name}=wrong; b=2; ${name}=${token}` })).status).toBe(200)
    expect((await request(server.port, '/world.json', { cookie: `a=1; ${cookie}; b=2` })).status).toBe(200)
  })

  test('the token in the path is worth nothing any more', async () => {
    expect((await request(server.port, `/${token}/world.json`, { cookie })).status).toBe(404)
    expect((await request(server.port, `/${token}/`)).status).toBe(403)
    expect((await request(server.port, `/${token}`)).status).toBe(403)
  })

  test('the cookie does not outlive the run: another server rejects it', async () => {
    const other = await fresh({ token: 'another-run-token-0123456789' })
    try {
      expect((await request(other.port, '/world.json', { cookie })).status).toBe(403)
    } finally {
      await other.close()
    }
  })
})

describe('createHttpServer', () => {
  test('200 with the cookie', async () => {
    const res = await request(server.port, '/', { cookie })
    expect(res.status).toBe(200)
    expect(res.body).toContain('<title>t</title>')
  })

  test('403 with a foreign Host header, even with the cookie', async () => {
    const res = await request(server.port, '/', { host: 'evil.example', cookie })
    expect(res.status).toBe(403)
  })

  test('200 with Host localhost:<port>', async () => {
    const res = await request(server.port, '/', { host: `localhost:${server.port}`, cookie })
    expect(res.status).toBe(200)
  })

  test('403 with a foreign Origin header, even with the cookie', async () => {
    const res = await request(server.port, '/world.json', { origin: 'http://evil.example', cookie })
    expect(res.status).toBe(403)
  })

  test('a matching Origin is accepted', async () => {
    const res = await request(server.port, '/world.json', { origin: `http://127.0.0.1:${server.port}`, cookie })
    expect(res.status).toBe(200)
  })

  test('405 on POST', async () => {
    const res = await request(server.port, '/world.json', { method: 'POST', cookie })
    expect(res.status).toBe(405)
  })

  test('404 on an asset outside the allowlist, including a traversal attempt', async () => {
    const missing = await request(server.port, '/assets/does-not-exist.js', { cookie })
    expect(missing.status).toBe(404)

    const traversal = await request(server.port, '/assets/..%2F..%2Fpackage.json', { cookie })
    expect(traversal.status).not.toBe(200)
  })

  test('200 for an asset in the allowlist', async () => {
    const res = await request(server.port, '/assets/app.js', { cookie })
    expect(res.status).toBe(200)
    expect(res.body).toBe('console.log(1)')
  })

  test('every response carries the security headers, and never a CORS header', async () => {
    const res = await request(server.port, '/world.json', { cookie })
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    // and the refusals too
    const refused = await request(server.port, '/world.json')
    expect(refused.status).toBe(403)
    expect(refused.headers['content-security-policy']).toContain("default-src 'none'")
  })

  test('world.json reflects the store', async () => {
    store.applyEvents([{ t: 'agent_meta', ts: 't0', agentId: 'a1', kind: 'session', cwd: '/home/user/projects/demo' }])
    const res = await request(server.port, '/world.json', { cookie })
    const world = JSON.parse(res.body) as { agents: Record<string, { cwd: string }> }
    expect(world.agents.a1?.cwd).toBe('demo') // publicWorld reduces cwd to its basename
  })

  test('SSE connects only with the cookie, sends the first snapshot immediately, then an update after a change', async () => {
    expect((await request(server.port, '/events')).status).toBe(403)

    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/events',
      headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie },
    })
    req.end()

    const res = await new Promise<http.IncomingMessage>((resolve) => req.on('response', resolve))
    expect(res.statusCode).toBe(200)

    const nextChunk = (): Promise<string> =>
      new Promise((resolve) => {
        res.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
      })

    const first = await nextChunk()
    expect(first).toContain('event: world')

    store.applyEvents([{ t: 'agent_meta', ts: 't0', agentId: 'new-agent', kind: 'session' }])
    const second = await nextChunk()
    expect(second).toContain('new-agent')

    req.destroy()
  })

  test('close() resolves promptly even with an open SSE connection left dangling', async () => {
    // This is exactly what a browser tab left open looks like from the server's side.
    // server.close() alone waits for every open connection to end on its own, which an SSE
    // stream never does from the server side — a real Ctrl+C must not hang on that.
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/events',
      headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie },
    })
    req.end()
    await new Promise<void>((resolve) => req.on('response', () => resolve()))

    const start = Date.now()
    await server.close()
    expect(Date.now() - start).toBeLessThan(2000)

    // afterEach also closes `server`; give it a fresh, still-open one to close.
    server = await fresh()
  })

  test('custom-assets.json is empty without a pack and holds a valid pack\'s data with one, behind the cookie', async () => {
    const none = await request(server.port, '/custom-assets.json', { cookie })
    expect(none.status).toBe(200)
    expect(JSON.parse(none.body)).toEqual({ palettes: {}, sprites: {} })
    expect(none.headers['content-type']).toContain('application/json')
    expect((await request(server.port, '/custom-assets.json')).status).toBe(403)
    expect((await request(server.port, '/custom-assets.json', { method: 'POST', cookie })).status).toBe(405)

    const customAssets = { palettes: { day: { '7': '#d9a86c' } }, sprites: { 'accessory:cap': { rows: ['..'] } } }
    const other = await fresh({ customAssets })
    try {
      const res = await request(other.port, '/custom-assets.json', { cookie: await login(other) })
      expect(JSON.parse(res.body)).toEqual(customAssets)
      expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    } finally {
      await other.close()
    }
  })

  test('page-options.json says Morty is on and five idle desks by default, and what --no-mascot and --idle-desks say, as JSON, behind the cookie', async () => {
    const on = await request(server.port, '/page-options.json', { cookie })
    expect(on.status).toBe(200)
    expect(on.headers['content-type']).toContain('application/json')
    expect(JSON.parse(on.body)).toEqual({ mascot: true, idleDesks: 5 })

    const head = await request(server.port, '/page-options.json', { method: 'HEAD', cookie })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect((await request(server.port, '/page-options.json')).status).toBe(403)
    expect((await request(server.port, '/page-options.json', { method: 'POST', cookie })).status).toBe(405)

    const off = await fresh({ pageOptions: { mascot: false, idleDesks: 0 } })
    try {
      expect(JSON.parse((await request(off.port, '/page-options.json', { cookie: await login(off) })).body)).toEqual({ mascot: false, idleDesks: 0 })
    } finally {
      await off.close()
    }
  })

  // S1-13: no secret is compared with a plain string comparison, and there is no redirect on the token any more.
  test('no secret is compared with ===, and the old token redirect is gone', async () => {
    const source = await readFile(new URL('../src/server/http.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/===\s*(?:bootstrapPath|bootstrapCode|opts\.token)|(?:bootstrapPath|bootstrapCode|opts\.token)\s*===/)
    expect(source).not.toMatch(/!==\s*(?:bootstrapPath|bootstrapCode|opts\.token)|(?:bootstrapPath|bootstrapCode|opts\.token)\s*!==/)
    expect(source).not.toMatch(/\b301\b/)
    expect(source).toMatch(/timingSafeStringEqual\(pathname, bootstrapPath\)/)
    expect(source).toMatch(/timingSafeStringEqual\(value, opts\.token\)/)
  })

  // S1-15: no home directory leaves in the World.
  test('world.json and the SSE payload name no path under the home directory', async () => {
    const home = '/Users/fake-person'
    const local = new Store({ nowMs: () => Date.now(), transcriptsRoot: `${home}/.claude` })
    local.mergeSources({
      transcripts: { status: 'unreadable', root: `${home}/.claude`, error: `ENOENT: no such file or directory, scandir '${home}/.claude'`, files: 0, inWindow: 0, windowHours: 12 },
      hooks: { status: 'live', events: 1, eventsFile: `${home}/.cubiclark/events.jsonl` },
    })
    local.applyEvents([{ t: 'diagnostics', ts: 't0', unparsed: 0, unknownTypes: {}, versions: [], sourceError: `cannot read ${home}/.claude/projects/-x/y.jsonl` }])
    const homed = await fresh({ store: local, home })
    try {
      const res = await request(homed.port, '/world.json', { cookie: await login(homed) })
      expect(res.body).not.toContain(home)
      expect(res.body).not.toContain('/Users/')
      const world = JSON.parse(res.body) as { sources: { transcripts: { root: string }; hooks: { eventsFile: string } } }
      expect(world.sources.transcripts.root).toBe('~/.claude')
      expect(world.sources.hooks.eventsFile).toBe('~/.cubiclark/events.jsonl')
    } finally {
      await homed.close()
      local.stop()
    }
  })

  // S1-14: one serialisation per World, and a client that stopped reading is dropped.
  test('WorldText serialises a World once however often it is asked', () => {
    const world = store.getWorld()
    let reads = 0
    const counted = { ...world }
    Object.defineProperty(counted, 'agents', {
      get() {
        reads += 1
        return world.agents
      },
      enumerable: true,
    })
    const text = new WorldText(undefined)
    const first = text.of(counted)
    const readsAfterFirst = reads
    expect(readsAfterFirst).toBeGreaterThan(0)
    expect(text.of(counted)).toBe(first)
    expect(reads).toBe(readsAfterFirst)
  })

  test('a client whose unsent output passes the cap is dropped, and the others are not', () => {
    const fakeRes = (writableLength: number): { res: ServerResponse; writes: string[]; destroyed: () => boolean } => {
      const writes: string[] = []
      let destroyed = false
      const res = {
        statusCode: 0,
        setHeader: () => undefined,
        flushHeaders: () => undefined,
        write: (chunk: string) => writes.push(chunk),
        on: () => undefined,
        destroy: () => {
          destroyed = true
        },
        get writableLength() {
          return writableLength
        },
      } as unknown as ServerResponse
      return { res, writes, destroyed: () => destroyed }
    }
    const text = new WorldText(undefined)
    const stalled = fakeRes(2_000)
    const healthy = fakeRes(10)
    const req = { on: () => req } as unknown as http.IncomingMessage
    sendSse(req, stalled.res, store, text, 1_000)
    sendSse(req, healthy.res, store, text, 1_000)
    expect(stalled.destroyed()).toBe(true)
    expect(stalled.writes).toHaveLength(0)
    expect(healthy.destroyed()).toBe(false)
    expect(healthy.writes).toHaveLength(1)
  })

  test('the socket is bound to 127.0.0.1 specifically, not every interface', async () => {
    // A live network probe of "is 0.0.0.0 reachable" is flaky across sandboxes (interfaces and
    // firewalling vary); the structural guarantee is that the server only ever calls
    // server.listen() with '127.0.0.1' as the host, which this greps for directly.
    const source = await readFile(new URL('../src/server/http.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/\.listen\([^)]*'127\.0\.0\.1'/)
  })
})

describe('cookieValues', () => {
  test('finds every value under the name, trimmed, and nothing else', () => {
    expect(cookieValues('a=1; b=2', 'b')).toEqual(['2'])
    expect(cookieValues('b=1;b=2 ;  c=3', 'b')).toEqual(['1', '2'])
    expect(cookieValues('ab=1; b=2', 'b')).toEqual(['2'])
    expect(cookieValues('b=x=y', 'b')).toEqual(['x=y'])
    expect(cookieValues('=b; b', 'b')).toEqual([])
    expect(cookieValues('', 'b')).toEqual([])
    expect(cookieValues(undefined, 'b')).toEqual([])
  })
})
