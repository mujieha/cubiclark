// node:http on 127.0.0.1, no framework. The link cubiclark prints and opens carries a one-time
// bootstrap code (/<code>/): the first GET trades it for a session cookie (HttpOnly; SameSite=Strict;
// Path=/; no Secure, since this is plain http on 127.0.0.1) and a redirect to `/`, so the secret is in
// no URL, history entry or process list after that. Every route, the page, its assets, `events`,
// `world.json`, `page-options.json` and `custom-assets.json`, then requires the cookie. Order of checks:
// Host, Origin, the method, the bootstrap code, the cookie, then the route. Every comparison of a secret
// is timing-safe (S1-13).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { NO_ASSETS, type PublicAssets } from '../core/assets/status.js'
import type { World } from '../core/types.js'
import { publicWorld } from '../core/view.js'
import { DEFAULT_IDLE_DESKS } from '../core/visible.js'
import type { Store } from './store.js'

export interface HttpServerOptions {
  /** The session secret: the value of the cookie the bootstrap code is traded for. Never in a URL. */
  token: string
  /** The one-time code in the printed link. Default: random. A test seam. */
  bootstrapCode?: string
  port: number
  clientDir: string
  store: Store
  /** The home directory: written as `~` wherever a path leaves in the World (S1-15). */
  home?: string
  /** A test seam for the slow-client limit; default MAX_CLIENT_BYTES. */
  maxClientBytes?: number
  /** A valid custom-assets manifest's palettes and sprites, served at `custom-assets.json`. */
  customAssets?: PublicAssets
  /** What the page is told about how it was started: `--no-mascot` and `--idle-desks`, nothing else. */
  pageOptions?: PageOptions
}

/** Served at `page-options.json`. */
export interface PageOptions {
  /** Morty, the office corgi, may be drawn. False with `--no-mascot`. */
  mascot: boolean
  /** How many idle sessions keep a desk (`--idle-desks`, default 5). */
  idleDesks: number
}

export interface RunningHttpServer {
  /** The link to open: `/<bootstrap code>/`. It works once. */
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

/** Cookies are scoped by host, not by port: two cubiclark runs at once must not overwrite each other's. */
export function sessionCookieName(port: number): string {
  return `cubiclark-${port}`
}

/** Every value the Cookie header holds under `name` (it may hold the name twice). */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (header === undefined) return []
  const values: string[] = []
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim())
  }
  return values
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

/** A client whose unsent output passes this is dropped (S1-14): it stopped reading. */
export const MAX_CLIENT_BYTES = 8 * 1024 * 1024

/** The World as the page gets it, serialised once per World however many clients are listening. */
export class WorldText {
  private last: { world: World; text: string } | undefined
  constructor(private readonly home: string | undefined) {}
  of(world: World): string {
    if (this.last?.world !== world) this.last = { world, text: JSON.stringify(publicWorld(world, this.home)) }
    return this.last.text
  }
}

export function sendSse(
  req: Pick<IncomingMessage, 'on'>,
  res: ServerResponse,
  store: Store,
  text: WorldText,
  maxClientBytes = MAX_CLIENT_BYTES
): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (world: World): void => {
    if (res.writableLength > maxClientBytes) {
      // A reader that stalled (a suspended process, a paused tab): Node would buffer every
      // snapshot for it. It reconnects on its own if it comes back.
      res.destroy()
      return
    }
    res.write(`event: world\ndata: ${text.of(world)}\n\n`)
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
  const bootstrapCode = opts.bootstrapCode ?? randomBytes(32).toString('base64url')
  const bootstrapPath = `/${bootstrapCode}/`
  /** The code is spent by the first GET that carries it, before anything is awaited. */
  let spent = false
  const worldText = new WorldText(opts.home)

  // opts.port is 0 for an ephemeral port; every Host/Origin/URL check below must use the port
  // the OS actually bound, which is only known once listen() resolves.
  let boundPort = opts.port

  /** The request carries the session cookie of this run. */
  const hasSession = (req: IncomingMessage): boolean =>
    cookieValues(req.headers.cookie, sessionCookieName(boundPort)).some((value) => timingSafeStringEqual(value, opts.token))

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

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end('method not allowed')
      return
    }

    if (timingSafeStringEqual(pathname, bootstrapPath)) {
      if (req.method === 'GET' && !spent) {
        spent = true
        res.statusCode = 303
        res.setHeader('Set-Cookie', `${sessionCookieName(boundPort)}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`)
        res.setHeader('Location', '/')
        res.end()
        return
      }
      // Spent, or only asked about (HEAD does not spend it). The browser that holds the cookie is sent on to
      // the page, so the printed link still works there; anyone else is told it has been used.
      if (hasSession(req)) {
        res.statusCode = 303
        res.setHeader('Location', '/')
        res.end()
        return
      }
      res.statusCode = 403
      res.end(spent ? 'forbidden: this link was already used; open the page in the browser that used it, or restart cubiclark' : 'forbidden')
      return
    }

    if (!hasSession(req)) {
      res.statusCode = 403
      res.end('forbidden: no session; open the link cubiclark printed (it works once)')
      return
    }

    const subPath = pathname.slice(1)
    const isHead = req.method === 'HEAD'

    if (subPath === '' || subPath === 'index.html') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(isHead ? undefined : indexHtml)
      return
    }

    if (subPath === 'custom-assets.json') {
      // What a valid custom-assets manifest holds (docs/assets.md), or nothing: only ever data.
      const body = JSON.stringify(opts.customAssets ?? NO_ASSETS)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(isHead ? undefined : body)
      return
    }

    if (subPath === 'page-options.json') {
      const options: PageOptions = { mascot: opts.pageOptions?.mascot ?? true, idleDesks: opts.pageOptions?.idleDesks ?? DEFAULT_IDLE_DESKS }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(isHead ? undefined : JSON.stringify(options))
      return
    }

    if (subPath === 'world.json') {
      const body = worldText.of(opts.store.getWorld())
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
      sendSse(req, res, opts.store, worldText, opts.maxClientBytes)
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
    url: `http://127.0.0.1:${port}${bootstrapPath}`,
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
