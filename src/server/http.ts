// node:http on 127.0.0.1, no framework. Every route sits under /<token>/, so the token travels
// in the path and Vite's relative asset URLs carry it automatically (design §4/§9). Order of
// checks, all from PLAN.md §1.8: Host, then the token prefix, then the method, then the route.

import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { publicWorld } from '../core/view.js'
import type { Store } from './store.js'

export interface HttpServerOptions {
  token: string
  port: number
  clientDir: string
  store: Store
}

export interface RunningHttpServer {
  url: string
  port: number
  close: () => Promise<void>
}

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Frame-Options', 'DENY')
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filename.endsWith('.svg')) return 'image/svg+xml'
  if (filename.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

async function listAssetFiles(clientDir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(join(clientDir, 'assets')))
  } catch {
    return new Set()
  }
}

function sendSse(req: IncomingMessage, res: ServerResponse, store: Store): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (world: Parameters<typeof publicWorld>[0]): void => {
    res.write(`event: world\ndata: ${JSON.stringify(publicWorld(world))}\n\n`)
  }
  send(store.getWorld())
  const unsubscribe = store.subscribe(send)

  const pingTimer = setInterval(() => {
    res.write(': ping\n\n')
  }, 15_000)

  const cleanup = (): void => {
    clearInterval(pingTimer)
    unsubscribe()
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

export async function createHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const assetFiles = await listAssetFiles(opts.clientDir)
  const indexHtml = await readFile(join(opts.clientDir, 'index.html'))
  const tokenPrefix = `/${opts.token}`

  // opts.port is 0 for an ephemeral port; every Host/Origin/URL check below must use the port
  // the OS actually bound, which is only known once listen() resolves.
  let boundPort = opts.port

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCommonHeaders(res)

    const hostHeader = req.headers.host ?? ''
    const expectedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]
    if (!expectedHosts.some((h) => timingSafeStringEqual(h, hostHeader))) {
      res.statusCode = 403
      res.end('forbidden: unexpected Host header')
      return
    }

    const origin = req.headers.origin
    if (typeof origin === 'string') {
      const expectedOrigins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]
      if (!expectedOrigins.some((o) => timingSafeStringEqual(o, origin))) {
        res.statusCode = 403
        res.end('forbidden: unexpected Origin header')
        return
      }
    }

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname
    } catch {
      res.statusCode = 400
      res.end('bad request')
      return
    }

    if (pathname === tokenPrefix) {
      res.statusCode = 301
      res.setHeader('Location', `${tokenPrefix}/`)
      res.end()
      return
    }
    if (!timingSafeStringEqual(pathname.slice(0, tokenPrefix.length + 1), `${tokenPrefix}/`)) {
      res.statusCode = 403
      res.end('forbidden: missing or wrong run token')
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end('method not allowed')
      return
    }

    const subPath = pathname.slice(tokenPrefix.length + 1)
    const isHead = req.method === 'HEAD'

    if (subPath === '' || subPath === 'index.html') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(isHead ? undefined : indexHtml)
      return
    }

    if (subPath === 'world.json') {
      const body = JSON.stringify(publicWorld(opts.store.getWorld()))
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(isHead ? undefined : body)
      return
    }

    if (subPath === 'events') {
      if (isHead) {
        res.statusCode = 200
        res.end()
        return
      }
      sendSse(req, res, opts.store)
      return
    }

    if (subPath.startsWith('assets/')) {
      const filename = subPath.slice('assets/'.length)
      if (!assetFiles.has(filename)) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', contentTypeFor(filename))
      if (isHead) {
        res.end()
        return
      }
      res.end(await readFile(join(opts.clientDir, 'assets', filename)))
      return
    }

    res.statusCode = 404
    res.end('not found')
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500
      res.end('internal error')
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : opts.port
  boundPort = port

  return {
    url: `http://127.0.0.1:${port}${tokenPrefix}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // server.close() alone only stops accepting new connections; it waits for every
        // existing one to end on its own, and an open SSE stream never does that from the
        // server side. A real Ctrl+C should exit promptly even with a browser tab left open.
        server.closeAllConnections()
      }),
  }
}
