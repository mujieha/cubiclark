import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createHttpServer } from '../src/server/http.js'
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

  test('the socket is bound to 127.0.0.1 specifically, not every interface', async () => {
    // A live network probe of "is 0.0.0.0 reachable" is flaky across sandboxes (interfaces and
    // firewalling vary); the structural guarantee is that the server only ever calls
    // server.listen() with '127.0.0.1' as the host, which this greps for directly.
    const source = await readFile(new URL('../src/server/http.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/\.listen\([^)]*'127\.0\.0\.1'/)
  })
})
