import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ServerResponse } from 'node:http'
import { WorldText, createHttpServer, sendSse } from '../src/server/http.js'
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
  opts: { host?: string; origin?: string; method?: string } = {}
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
const token = 'test-run-token-0123456789'

beforeEach(async () => {
  clientDir = await mkdtemp(join(tmpdir(), 'cubiclark-http-'))
  await writeFile(join(clientDir, 'index.html'), '<!doctype html><title>t</title>', 'utf8')
  await mkdir(join(clientDir, 'assets'), { recursive: true })
  await writeFile(join(clientDir, 'assets', 'app.js'), 'console.log(1)', 'utf8')

  store = new Store({ nowMs: () => Date.now(), transcriptsRoot: '/root' })
  server = await createHttpServer({ token, port: 0, clientDir, store })
})

afterEach(async () => {
  await server.close()
  store.stop()
  await rm(clientDir, { recursive: true, force: true })
})

describe('createHttpServer', () => {
  test('200 with the correct token', async () => {
    const res = await request(server.port, `/${token}/`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('<title>t</title>')
  })

  test('403 without a token', async () => {
    const res = await request(server.port, '/')
    expect(res.status).toBe(403)
  })

  test('403 with a wrong token', async () => {
    const res = await request(server.port, '/not-the-token/')
    expect(res.status).toBe(403)
  })

  test('403 with a foreign Host header', async () => {
    const res = await request(server.port, `/${token}/`, { host: 'evil.example' })
    expect(res.status).toBe(403)
  })

  test('200 with Host localhost:<port>', async () => {
    const res = await request(server.port, `/${token}/`, { host: `localhost:${server.port}` })
    expect(res.status).toBe(200)
  })

  test('403 with a foreign Origin header', async () => {
    const res = await request(server.port, `/${token}/world.json`, { origin: 'http://evil.example' })
    expect(res.status).toBe(403)
  })

  test('a matching Origin is accepted', async () => {
    const res = await request(server.port, `/${token}/world.json`, { origin: `http://127.0.0.1:${server.port}` })
    expect(res.status).toBe(200)
  })

  test('405 on POST', async () => {
    const res = await request(server.port, `/${token}/world.json`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  test('404 on an asset outside the allowlist, including a traversal attempt', async () => {
    const missing = await request(server.port, `/${token}/assets/does-not-exist.js`)
    expect(missing.status).toBe(404)

    const traversal = await request(server.port, `/${token}/assets/..%2F..%2Fpackage.json`)
    expect(traversal.status).not.toBe(200)
  })

  test('200 for an asset in the allowlist', async () => {
    const res = await request(server.port, `/${token}/assets/app.js`)
    expect(res.status).toBe(200)
    expect(res.body).toBe('console.log(1)')
  })

  test('every response carries the security headers, and never a CORS header', async () => {
    const res = await request(server.port, `/${token}/world.json`)
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('world.json reflects the store', async () => {
    store.applyEvents([{ t: 'agent_meta', ts: 't0', agentId: 'a1', kind: 'session', cwd: '/home/user/projects/demo' }])
    const res = await request(server.port, `/${token}/world.json`)
    const world = JSON.parse(res.body) as { agents: Record<string, { cwd: string }> }
    expect(world.agents.a1?.cwd).toBe('demo') // publicWorld reduces cwd to its basename
  })

  test('SSE sends the first snapshot immediately, then an update after a change', async () => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: `/${token}/events`,
      headers: { Host: `127.0.0.1:${server.port}` },
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
      path: `/${token}/events`,
      headers: { Host: `127.0.0.1:${server.port}` },
    })
    req.end()
    await new Promise<void>((resolve) => req.on('response', () => resolve()))

    const start = Date.now()
    await server.close()
    expect(Date.now() - start).toBeLessThan(2000)

    // afterEach also closes `server`; give it a fresh, still-open one to close.
    server = await createHttpServer({ token, port: 0, clientDir, store })
  })

  test('custom-assets.json is empty without a pack and holds a valid pack\'s data with one, behind the token', async () => {
    const none = await request(server.port, `/${token}/custom-assets.json`)
    expect(none.status).toBe(200)
    expect(JSON.parse(none.body)).toEqual({ palettes: {}, sprites: {} })
    expect(none.headers['content-type']).toContain('application/json')
    expect((await request(server.port, '/custom-assets.json')).status).toBe(403)
    expect((await request(server.port, `/${token}/custom-assets.json`, { method: 'POST' })).status).toBe(405)

    const customAssets = { palettes: { day: { '7': '#d9a86c' } }, sprites: { 'accessory:cap': { rows: ['..'] } } }
    const other = await createHttpServer({ token, port: 0, clientDir, store, customAssets })
    try {
      const res = await request(other.port, `/${token}/custom-assets.json`)
      expect(JSON.parse(res.body)).toEqual(customAssets)
      expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    } finally {
      await other.close()
    }
  })

  test('page-options.json says Morty is on and five idle desks by default, and what --no-mascot and --idle-desks say, as JSON, behind the token', async () => {
    const on = await request(server.port, `/${token}/page-options.json`)
    expect(on.status).toBe(200)
    expect(on.headers['content-type']).toContain('application/json')
    expect(JSON.parse(on.body)).toEqual({ mascot: true, idleDesks: 5 })

    const head = await request(server.port, `/${token}/page-options.json`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect((await request(server.port, '/page-options.json')).status).toBe(403)
    expect((await request(server.port, `/${token}/page-options.json`, { method: 'POST' })).status).toBe(405)

    const off = await createHttpServer({ token, port: 0, clientDir, store, pageOptions: { mascot: false, idleDesks: 0 } })
    try {
      expect(JSON.parse((await request(off.port, `/${token}/page-options.json`)).body)).toEqual({ mascot: false, idleDesks: 0 })
    } finally {
      await off.close()
    }
  })

  // S1-13: the redirect branch compared the token with `===`.
  test('the token redirect works, a near miss is 403, and no plain comparison is left', async () => {
    const redirect = await request(server.port, `/${token}`)
    expect(redirect.status).toBe(301)
    expect(redirect.headers.location).toBe(`/${token}/`)
    expect((await request(server.port, `/${token.slice(0, -1)}`)).status).toBe(403)
    expect((await request(server.port, `/${token}x`)).status).toBe(403)
    const source = await readFile(new URL('../src/server/http.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/===\s*tokenPrefix|tokenPrefix\s*===/)
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
    const homed = await createHttpServer({ token, port: 0, clientDir, store: local, home })
    try {
      const res = await request(homed.port, `/${token}/world.json`)
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
