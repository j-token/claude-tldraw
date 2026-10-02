import type { EngineInterface, Register } from 'claude-code'

const PORT = 7717
const BASE = `http://127.0.0.1:${PORT}`
const PANE = 'tldraw'
const TOOL = 'mcp__tldraw__exec'
// pane 본문에서 그림 위에 있는 줄 수 (헤더 한 줄)
const HEADER_ROWS = 1

type Label = { col: number; row: number; text: string; fg: string; bg: string }
type Frame = {
  columns: number
  rows: number
  cells?: string
  labels?: Label[]
  svg?: string | null
  shapeCount: number
  zoom: number
  dark: boolean
}
type ViewOp =
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; factor: number; col?: number; row?: number }
  | { type: 'fit' }
  | { type: 'dark' }
type InputMessage =
  | { type: 'drag'; id: number; dx: number; dy: number }
  | { type: 'key'; key: string }

const TOOL_DESCRIPTION = `Run JavaScript on the user's tldraw canvas (tldraw v5). The canvas runs headless and is shown to the user inside a Claude Code pane (they can drag to pan and scroll to zoom), so whatever you draw is what they see. The drawing is saved on this machine and is still there next session.

The code is the body of an async function; \`return\` a value to read it back (JSON, truncated at 20k chars). In scope:
- editor: the tldraw Editor (editor.createShape, updateShape, deleteShapes, getCurrentPageShapes, ...). Text props are richText: use toRichText('...').
- tl: the whole \`tldraw\` module (tl.createShapeId, tl.toRichText, ...)
- box(id, x, y, w, h, text?, props?) / ellipse(...) / diamond(...): geo shape; calling again with the same id updates it. props e.g. { color: 'blue', fill: 'semi', size: 's' }
- note(id, x, y, text, props?) sticky note; text(id, x, y, text, props?) free text
- arrow(fromId, toId, label?, props?): arrow bound to both shapes
- shapes(): compact list of shapes on the page; clear(): delete all shapes; fit(): fit the pane's view to the drawing
- sid(id): the full shape id ('shape:<id>') for a short id

Colors: black, grey, light-violet, violet, blue, light-blue, yellow, orange, green, light-green, light-red, red, white. Fill: none, semi, solid, pattern.
The pane is small (a terminal), so prefer few words per shape and clear gaps (e.g. 220x110 boxes 160px apart); call fit() at the end. Send large drawings in several calls rather than one huge script. Read shapes() before editing a canvas you did not just draw.`

let token: string | null = null
let dataDir: string | null = null
let isServerStarting = false
let frame: Frame | null = null
let size = { columns: 0, rows: 0 }
let format: 'raster' | 'svg' = 'raster'
let queue: ViewOp[] = []
let isPumping = false
let lastDrag = { id: 0, dx: 0, dy: 0 }

// 캔버스와 서버 토큰을 둘 곳: 플러그인 폴더는 업데이트 때 바뀌므로 그 밖에 둔다
async function resolveDataDir($: EngineInterface): Promise<string> {
  if (dataDir) return dataDir
  const pluginData = await $.env.get('CLAUDE_PLUGIN_DATA')
  if (pluginData) {
    dataDir = pluginData
    return dataDir
  }
  const configDir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'}/.claude`
  dataDir = `${configDir}/plugins/data/tldraw`
  return dataDir
}

async function readToken($: EngineInterface) {
  try {
    token = (await $.fs.read(`${await resolveDataDir($)}/token`)).trim()
  } catch {
    token = null
  }
}

async function call<T>($: EngineInterface, path: string, body?: unknown): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token) await readToken($)
    if (!token) return null
    try {
      const response = await $.http.fetch(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-tldraw-token': token },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.status === 403) {
        // 서버가 새로 떠서 토큰이 바뀜: 한 번 다시 읽는다
        token = null
        continue
      }
      return JSON.parse(response.text) as T
    } catch {
      return null
    }
  }
  return null
}

function health($: EngineInterface) {
  return call<{ ok: boolean; clients: number }>($, '/health')
}

async function ensureServer($: EngineInterface): Promise<boolean> {
  if (await health($)) return true
  if (!isServerStarting) {
    isServerStarting = true
    token = null
    const root = $.plugin.root
    const data = await resolveDataDir($)
    void (async () => {
      try {
        const child = $.process.spawn({
          argv: ['node', `${root}/server/server.mjs`, String(PORT), data],
        })
        for await (const { text } of child) $.ui.log(`tldraw: ${text.trim()}`, { to: 'debug' })
      } catch (error) {
        $.ui.log(`tldraw: 서버를 시작하지 못했습니다 (node가 PATH에 있는지 확인하세요): ${String(error)}`)
      }
      isServerStarting = false
    })()
  }
  for (let i = 0; i < 40; i++) {
    await $.clock.sleep(250)
    if (await health($)) return true
  }
  return false
}

// headless 캔버스가 서버에 붙을 때까지 기다린다
async function ensureCanvas($: EngineInterface): Promise<boolean> {
  if (!(await ensureServer($))) return false
  for (let i = 0; i < 120; i++) {
    if ((await health($))?.clients) return true
    await $.clock.sleep(250)
  }
  return false
}

function enqueue($: EngineInterface, ops: ViewOp[]) {
  queue.push(...ops)
  void pump($)
}

// 화면 요청은 한 번에 하나: 그동안 쌓인 조작은 다음 요청에 몰아서 보낸다
async function pump($: EngineInterface) {
  if (isPumping) return
  isPumping = true
  try {
    do {
      const ops = queue
      queue = []
      if (size.columns === 0) break
      const next = await call<Frame & { ok: boolean; error?: string }>($, '/view', {
        columns: size.columns,
        rows: size.rows,
        ops,
        format,
      })
      if (next?.ok) {
        frame = next
        $.ui.invalidate('ui.render')
      }
    } while (queue.length > 0)
  } finally {
    isPumping = false
  }
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'tldraw' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tldraw',
      description: 'tldraw 캔버스를 Claude Code pane에 엽니다',
    })
    await $.tool.register({
      name: 'exec',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript body to run with `editor` and the helpers in scope' },
        },
        required: ['code'],
      },
    })

    return started
  })

  on('command.run', { command: 'tldraw' }, async $ => {
    if (!(await ensureCanvas($))) {
      return { text: 'tldraw 캔버스를 시작하지 못했습니다. node와 Edge/Chrome이 설치되어 있는지 확인하세요.' }
    }
    await openPane($)
    enqueue($, [])

    return { text: 'tldraw pane을 열었습니다. 드래그로 이동, 휠로 확대/축소할 수 있습니다.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const code = (e as unknown as { code?: unknown }).code
    if (typeof code !== 'string' || code.trim() === '') {
      return { deny: 'code (string) is required' }
    }
    if (!(await ensureCanvas($))) {
      return { deny: 'The tldraw canvas could not start (needs node and Edge or Chrome).' }
    }
    void openPane($)
    const ran = await call<{ ok: boolean; value?: string; error?: string; shapeCount?: number }>($, '/exec', { code })
    enqueue($, [])
    if (!ran) return { result: 'Error: the tldraw server did not answer.' }
    if (!ran.ok) return { result: `Error: ${ran.error}` }

    return { result: `shapes on page: ${ran.shapeCount}\nreturned: ${ran.value}` }
  })

  // pane을 닫으면 서버(와 headless 브라우저)도 끈다. 다음 그리기/열기 때 다시 뜬다.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await call($, '/shutdown', {})
      token = null
      frame = null
      size = { columns: 0, rows: 0 }
      queue = []
    }

    return next(e)
  })

  // 휠: 포인터가 있는 칸을 중심으로 확대/축소 (pane 자체는 스크롤하지 않음)
  on('ui.scroll', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const factor = 1.15 ** -e.by
    const pointer = e.pointer
    enqueue($, [
      pointer
        ? { type: 'zoom', factor, col: pointer.column, row: pointer.row - HEADER_ROWS }
        : { type: 'zoom', factor },
    ])

    return {}
  })

  // 그림 위 입력 영역(canvas-input.ts)에서 온 드래그와 키
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const message = e.data as InputMessage
    if (message.type === 'drag') {
      const base = message.id === lastDrag.id ? lastDrag : { id: message.id, dx: 0, dy: 0 }
      const dx = message.dx - base.dx
      const dy = message.dy - base.dy
      lastDrag = { id: message.id, dx: message.dx, dy: message.dy }
      if (dx !== 0 || dy !== 0) enqueue($, [{ type: 'pan', dx, dy }])
    } else if (message.type === 'key') {
      const step = 4
      const ops: Record<string, ViewOp> = {
        left: { type: 'pan', dx: step, dy: 0 },
        right: { type: 'pan', dx: -step, dy: 0 },
        up: { type: 'pan', dx: 0, dy: step / 2 },
        down: { type: 'pan', dx: 0, dy: -step / 2 },
        '+': { type: 'zoom', factor: 1.25 },
        '=': { type: 'zoom', factor: 1.25 },
        '-': { type: 'zoom', factor: 0.8 },
        f: { type: 'fit' },
        '0': { type: 'fit' },
        d: { type: 'dark' },
      }
      const op = ops[message.key]
      if (op) enqueue($, [op])
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const viewport = e.viewport ?? { columns: 80, rows: 24 }
    const isTerminal = e.surface === 'terminal'
    const wanted = isTerminal
      ? {
          columns: Math.max(20, Math.min(400, viewport.columns - 2)),
          rows: Math.max(8, Math.min(200, viewport.rows - 6)),
        }
      : { columns: 120, rows: 40 }
    format = isTerminal ? 'raster' : 'svg'
    if (wanted.columns !== size.columns || wanted.rows !== size.rows) {
      size = wanted
      enqueue($, [])
    }

    const header = (
      <Text dimColor wrap="truncate-end">
        도형 {frame?.shapeCount ?? 0}개 · {Math.round((frame?.zoom ?? 1) * 100)}% · 드래그: 이동 · 휠: 확대/축소 · 클릭 후 ←↑↓→ + - f d
      </Text>
    )
    const buttons = (
      <Box flexDirection="row" gap={1}>
        <Button key="zoom-in" label="확대" hotkey="i" onPress={() => enqueue($, [{ type: 'zoom', factor: 1.25 }])} />
        <Button key="zoom-out" label="축소" hotkey="o" onPress={() => enqueue($, [{ type: 'zoom', factor: 0.8 }])} />
        <Button key="fit" label="맞추기" hotkey="f" onPress={() => enqueue($, [{ type: 'fit' }])} />
        <Button key="dark" label="다크" hotkey="d" onPress={() => enqueue($, [{ type: 'dark' }])} />
      </Box>
    )

    let body
    if (!frame) {
      body = <Text dimColor>캔버스를 준비하는 중… (처음 한 번은 몇 초 걸립니다)</Text>
    } else if (e.surface === 'terminal' && frame.cells) {
      const { Raster, Client } = $.ui.resolve(e as typeof e & { surface: 'terminal' })
      body = (
        <Box position="relative" width={frame.columns} height={frame.rows}>
          <Raster key="canvas" columns={frame.columns} rows={frame.rows} cells={frame.cells} />
          {(frame.labels ?? []).map((label, i) => (
            <Box key={`label-${i}`} position="absolute" top={label.row} left={label.col}>
              <Text color={label.fg} backgroundColor={label.bg} wrap="truncate-end">
                {label.text}
              </Text>
            </Box>
          ))}
          <Box position="absolute" top={0} left={0}>
            <Client key="input" module="./canvas-input.ts" width={frame.columns} height={frame.rows} />
          </Box>
        </Box>
      )
    } else if (e.surface !== 'terminal' && e.surface !== 'mobile' && frame.svg) {
      const { Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })
      body = <Svg source={frame.svg} alt={`tldraw 캔버스 (도형 ${frame.shapeCount}개)`} />
    } else if (frame.shapeCount === 0) {
      body = <Text dimColor>캔버스가 비어 있습니다. Claude에게 "tldraw로 그려줘"라고 요청해 보세요.</Text>
    } else {
      body = <Text dimColor>화면을 그리는 중…</Text>
    }

    return (
      <Box flexDirection="column">
        {header}
        {body}
        {buttons}
      </Box>
    )
  })
}
