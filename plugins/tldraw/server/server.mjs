// 로컬 tldraw 브리지 서버 (의존성 없음, Node 18+)
// tldraw는 화면에 보이지 않는 headless Edge/Chrome 안에서 실행되고,
// Claude Code mod가 이 서버를 통해 그리기(exec)와 화면(view) 렌더링을 요청한다.
//
// 모든 요청은 <data>/token 의 토큰이 있어야 하며(헤더 x-tldraw-token 또는 ?t=),
// Host 가 localhost/127.0.0.1 이 아니면 거절한다 (다른 웹사이트가 명령을 보낼 수 없게).
//
// - GET  /?t=…        : tldraw 페이지 (headless 브라우저 전용)
// - GET  /static/*    : 페이지 번들 (dist/app.js, dist/tldraw.css), 토큰 없이 허용
// - GET  /events?t=…  : 페이지가 받는 SSE (exec, view 요청)
// - POST /exec        : 코드를 페이지에서 실행하고 결과를 돌려줌
// - POST /view        : 현재 카메라로 화면을 렌더링해 돌려줌 (ops 로 이동/확대)
// - POST /reply       : 페이지가 exec/view 결과를 보고
// - POST /shutdown    : 서버와 headless 브라우저 종료 (mod의 pane이 닫힐 때)
// - GET/POST /doc     : 캔버스 문서 저장/복원
// - GET  /health
//
// 사용법: node server.mjs <port> <data dir>
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] ?? 7717)
const dataDir = process.argv[3] ?? join(homedir(), '.claude', 'plugins', 'data', 'tldraw')
const docPath = join(dataDir, 'document.json')
const token = randomBytes(24).toString('hex')

const clients = new Set()
const pending = new Map()
let nextId = 1
let browser = null
// 안전장치: 30분 동안 아무 요청이 없으면 스스로 종료 (mod가 비정상 종료된 경우 대비)
const IDLE_MS = 30 * 60 * 1000
let lastUsed = Date.now()

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(line)
}

// 페이지에 요청을 보내고 /reply 로 돌아오는 답을 기다린다
function ask(event, payload, timeoutMs) {
  if (clients.size === 0) return Promise.resolve({ ok: false, error: 'canvas-not-ready' })
  const id = String(nextId++)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    pending.set(id, value => {
      clearTimeout(timer)
      resolve(value)
    })
    broadcast(event, { id, ...payload })
  })
}

const routes = {
  'GET /': async (req, res) => {
    send(res, 200, await readFile(join(here, 'index.html'), 'utf8'), 'text/html; charset=utf-8')
  },
  'GET /health': (req, res) => {
    send(res, 200, { ok: true, clients: clients.size, browser: browser !== null })
  },
  'GET /events': (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(': hello\n\n')
    clients.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => {
      clearInterval(ping)
      clients.delete(res)
    })
  },
  'POST /exec': async (req, res) => {
    const { code } = await readBody(req)
    send(res, 200, await ask('exec', { code }, 20000))
  },
  'POST /view': async (req, res) => {
    send(res, 200, await ask('view', await readBody(req), 8000))
  },
  'POST /reply': async (req, res) => {
    const { id, ...result } = await readBody(req)
    pending.get(id)?.(result)
    pending.delete(id)
    send(res, 200, { ok: true })
  },
  'POST /shutdown': (req, res) => {
    send(res, 200, { ok: true })
    setTimeout(shutdown, 50)
  },
  'GET /doc': async (req, res) => {
    try {
      send(res, 200, await readFile(docPath, 'utf8'))
    } catch {
      send(res, 200, 'null')
    }
  },
  'POST /doc': async (req, res) => {
    const body = await readBody(req)
    await writeFile(docPath, JSON.stringify(body))
    send(res, 200, { ok: true })
  },
}

const STATIC = { 'app.js': 'text/javascript', 'tldraw.css': 'text/css' }

function isLocalHost(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  return host === 'localhost' || host === '127.0.0.1'
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (!isLocalHost(req)) return send(res, 403, { ok: false, error: 'bad host' })
  const staticName = url.pathname.startsWith('/static/') ? url.pathname.slice(8) : null
  if (staticName && STATIC[staticName]) {
    res.writeHead(200, { 'content-type': STATIC[staticName], 'cache-control': 'no-cache' })
    return res.end(await readFile(join(here, 'dist', staticName)))
  }
  const given = req.headers['x-tldraw-token'] ?? url.searchParams.get('t')
  if (given !== token) return send(res, 403, { ok: false, error: 'bad token' })
  lastUsed = Date.now()
  const route = routes[`${req.method} ${url.pathname}`]
  if (!route) return send(res, 404, { ok: false, error: 'not found' })
  try {
    await route(req, res)
  } catch (error) {
    send(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
})

// ── headless 브라우저 ─────────────────────────────────────────────
function browserCandidates() {
  const list = []
  if (process.env.TLDRAW_BROWSER) list.push(process.env.TLDRAW_BROWSER)
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
    for (const root of roots.filter(Boolean)) {
      list.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      list.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
        list.push(join(dir, name))
      }
    }
  }
  return list.filter(path => existsSync(path))
}

function launchBrowser() {
  const [executable] = browserCandidates()
  if (!executable) {
    console.error('no Chrome/Edge found; set TLDRAW_BROWSER to a Chromium-based browser')
    return
  }
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    // stdio 3/4 파이프: 이 서버가 죽으면 파이프가 닫혀 브라우저도 스스로 종료된다
    '--remote-debugging-pipe',
    `--user-data-dir=${join(dataDir, 'browser-profile')}`,
    '--window-size=1280,800',
    `http://127.0.0.1:${port}/?t=${token}`,
  ]
  browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  console.log(`headless browser: ${executable}`)
  browser.on('exit', code => {
    console.log(`headless browser exited (${code}); restarting`)
    browser = null
    setTimeout(launchBrowser, 1000)
  })
}

function shutdown() {
  browser?.removeAllListeners('exit')
  browser?.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
setInterval(() => {
  if (Date.now() - lastUsed > IDLE_MS) {
    console.log('idle for 30 minutes; shutting down')
    shutdown()
  }
}, 60 * 1000).unref()

await mkdir(dataDir, { recursive: true })
server.listen(port, '127.0.0.1', async () => {
  await writeFile(join(dataDir, 'token'), token)
  console.log(`tldraw bridge listening on http://127.0.0.1:${port}`)
  launchBrowser()
})
