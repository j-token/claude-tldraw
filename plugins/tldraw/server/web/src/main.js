import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import * as tl from 'tldraw'

const { Tldraw, Box, toRichText, createShapeId, getSnapshot, loadSnapshot } = tl
const token = new URLSearchParams(location.search).get('t')
let editor = null

const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tldraw-token': token },
    body: JSON.stringify(body),
  })

// ── 카메라: 페이지 좌표의 중심(cx, cy)과 배율 z (가상 화면 px / 페이지 단위)
// 터미널 한 칸은 가상 8×16 px 로 본다.
const CELL_W = 8
const CELL_H = 16
const view = { cx: 0, cy: 0, z: 1, isFitted: false, dark: false }

function contentBounds() {
  const ids = [...editor.getCurrentPageShapeIds()]
  if (ids.length === 0) return null
  return Box.Common(ids.map(id => editor.getShapePageBounds(id)).filter(Boolean))
}

function fitView(columns, rows) {
  const b = contentBounds()
  if (!b) {
    view.cx = 0; view.cy = 0; view.z = 1
    return
  }
  const pad = 40
  view.z = Math.min((columns * CELL_W) / (b.w + pad * 2), (rows * CELL_H) / (b.h + pad * 2))
  view.z = Math.min(Math.max(view.z, 0.05), 8)
  view.cx = b.x + b.w / 2
  view.cy = b.y + b.h / 2
  view.isFitted = true
}

function applyOps(ops, columns, rows) {
  for (const op of ops ?? []) {
    if (op.type === 'fit') fitView(columns, rows)
    if (op.type === 'pan') {
      view.cx -= (op.dx * CELL_W) / view.z
      view.cy -= (op.dy * CELL_H) / view.z
      view.isFitted = false
    }
    if (op.type === 'zoom') {
      const col = op.col ?? columns / 2 - 0.5
      const row = op.row ?? rows / 2 - 0.5
      const ox = (col + 0.5 - columns / 2) * CELL_W
      const oy = (row + 0.5 - rows / 2) * CELL_H
      const px = view.cx + ox / view.z
      const py = view.cy + oy / view.z
      view.z = Math.min(Math.max(view.z * op.factor, 0.05), 8)
      view.cx = px - ox / view.z
      view.cy = py - oy / view.z
      view.isFitted = false
    }
    if (op.type === 'dark') view.dark = !view.dark
  }
}

function viewBounds(columns, rows) {
  const w = (columns * CELL_W) / view.z
  const h = (rows * CELL_H) / view.z
  return new Box(view.cx - w / 2, view.cy - h / 2, w, h)
}

// ── 렌더링 ────────────────────────────────────────────────────
function toBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// 2×2 quadrant 비트마스크 (TL=8, TR=4, BL=2, BR=1) → 문자
const QUAD = [
  0x20, 0x2597, 0x2596, 0x2584, 0x259d, 0x2590, 0x259e, 0x259f,
  0x2598, 0x259a, 0x258c, 0x2599, 0x2580, 0x259c, 0x259b, 0x2588,
]

// 보이는 영역을 칸당 8×16 px 로 그린 뒤, 서브픽셀(4×8 px 블록)마다
// 배경에서 가장 먼 픽셀(잉크)을 골라 얇은 선과 글자가 흐려지지 않게 한다.
async function renderImage(bounds, columns, rows) {
  const ids = [...editor.getCurrentPageShapeIds()]
  const bgRgb = view.dark ? [0x1d, 0x1d, 0x1d] : [0xff, 0xff, 0xff]
  const SW = columns * 8
  const SH = rows * 16
  const canvas = new OffscreenCanvas(SW, SH)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = `rgb(${bgRgb.join(',')})`
  ctx.fillRect(0, 0, SW, SH)
  if (ids.length > 0) {
    const result = await editor.getSvgElement(ids, {
      bounds,
      scale: SW / bounds.w,
      padding: 0,
      background: true,
      darkMode: view.dark,
    })
    if (result) {
      // 글자는 터미널 문자로 따로 그리므로 그림에서 뺀다
      result.svg.querySelectorAll('foreignObject, text').forEach(node => node.remove())
      const markup = new XMLSerializer().serializeToString(result.svg)
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
      try {
        const img = new Image()
        img.src = url
        await img.decode()
        ctx.drawImage(img, 0, 0, SW, SH)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  }
  const src = ctx.getImageData(0, 0, SW, SH).data
  // 실제 배경색은 왼쪽 위 픽셀로 (tldraw 배경이 순백이 아닐 수 있음)
  const bg = [src[0], src[1], src[2]]
  const W = columns * 2
  const H = rows * 2
  const out = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = -1, bi = 0
      for (let yy = 0; yy < 8; yy++) {
        let i = ((y * 8 + yy) * SW + x * 4) * 4
        for (let xx = 0; xx < 4; xx++, i += 4) {
          const d = Math.abs(src[i] - bg[0]) + Math.abs(src[i + 1] - bg[1]) + Math.abs(src[i + 2] - bg[2])
          if (d > best) { best = d; bi = i }
        }
      }
      const o = (y * W + x) * 4
      out[o] = src[bi]; out[o + 1] = src[bi + 1]; out[o + 2] = src[bi + 2]; out[o + 3] = 255
    }
  }
  return out
}

async function renderRaster(columns, rows) {
  const px = await renderImage(viewBounds(columns, rows), columns, rows)
  const W = columns * 2
  const words = new Uint32Array(columns * rows * 3)
  const p = new Array(4)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i0 = ((r * 2) * W + c * 2) * 4
      const i2 = ((r * 2 + 1) * W + c * 2) * 4
      p[0] = i0; p[1] = i0 + 4; p[2] = i2; p[3] = i2 + 4
      // 가장 멀리 떨어진 두 픽셀을 두 대표색으로
      let a = 0, b = 0, best = -1
      for (let m = 0; m < 4; m++) for (let n = m + 1; n < 4; n++) {
        const d = (px[p[m]] - px[p[n]]) ** 2 + (px[p[m] + 1] - px[p[n] + 1]) ** 2 + (px[p[m] + 2] - px[p[n] + 2]) ** 2
        if (d > best) { best = d; a = m; b = n }
      }
      let mask = 0
      const fg = [0, 0, 0, 0], bgc = [0, 0, 0, 0]
      for (let m = 0; m < 4; m++) {
        const q = p[m]
        const da = (px[q] - px[p[a]]) ** 2 + (px[q + 1] - px[p[a] + 1]) ** 2 + (px[q + 2] - px[p[a] + 2]) ** 2
        const db = (px[q] - px[p[b]]) ** 2 + (px[q + 1] - px[p[b] + 1]) ** 2 + (px[q + 2] - px[p[b] + 2]) ** 2
        const acc = da <= db ? fg : bgc
        if (da <= db) mask |= 8 >> m
        acc[0] += px[q]; acc[1] += px[q + 1]; acc[2] += px[q + 2]; acc[3]++
      }
      const avg = s => (s[3] ? ((Math.round(s[0] / s[3]) << 16) | (Math.round(s[1] / s[3]) << 8) | Math.round(s[2] / s[3])) : 0)
      const cell = (r * columns + c) * 3
      const f = avg(fg)
      const k = bgc[3] ? avg(bgc) : f
      if (best < 300) {
        // 거의 한 색인 칸: 공백 + 평균색 배경
        words[cell] = 0x20
        words[cell + 1] = 0
        words[cell + 2] = avgAll(px, p)
      } else {
        words[cell] = QUAD[mask]
        words[cell + 1] = f
        words[cell + 2] = k
      }
    }
  }
  return {
    columns,
    rows,
    cells: toBase64(new Uint8Array(words.buffer)),
    labels: labelsFor(columns, rows, px),
  }
}

// ── 라벨: 도형의 글자를 실제 터미널 문자로 겹쳐 그리기 위한 위치/색 ──
const isWide = cp =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300
const widthOf = text => [...text].reduce((n, ch) => n + (isWide(ch.codePointAt(0)) ? 2 : 1), 0)

// 앞쪽 skip 칸을 버리고 최대 max 칸까지 자른다
function clip(text, skip, max) {
  let out = '', used = 0, pos = 0, offset = 0
  for (const ch of text) {
    const w = isWide(ch.codePointAt(0)) ? 2 : 1
    if (pos < skip) {
      pos += w
      if (pos > skip) offset = pos - skip // 넓은 글자가 걸치면 그만큼 밀림
      continue
    }
    if (used + w > max) break
    out += ch
    used += w
  }
  return { text: out, offset, width: used }
}

const hex = n => '#' + n.toString(16).padStart(6, '0')

function colorOf(shape) {
  const name = shape.props.labelColor ?? (shape.type === 'text' || shape.type === 'note' ? shape.props.color : 'black')
  try {
    const theme = tl.getDefaultColorTheme({ isDarkMode: view.dark })
    if (shape.type === 'note') return view.dark ? '#f2f2f2' : '#1d1d1d'
    return theme[name]?.solid ?? theme.text
  } catch {
    return view.dark ? '#f2f2f2' : '#1d1d1d'
  }
}

function labelsFor(columns, rows, px) {
  const W = columns * 2
  // 라벨이 덮는 칸들의 서브픽셀 중 가장 흔한 색 (테두리 선보다 채움색이 이긴다)
  const sample = (col, width, row) => {
    const counts = new Map()
    for (let x = col * 2; x < (col + width) * 2; x++) {
      for (let y = row * 2; y < row * 2 + 2; y++) {
        if (x < 0 || x >= W || y < 0 || y >= rows * 2) continue
        const o = (y * W + x) * 4
        const key = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2]
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    let best = 0, color = view.dark ? 0x1d1d1d : 0xffffff
    for (const [key, n] of counts) if (n > best) { best = n; color = key }
    return hex(color)
  }
  const labels = []
  for (const shape of editor.getCurrentPageShapesSorted()) {
    const util = editor.getShapeUtil(shape)
    const text = util.getText?.(shape)
    if (!text || !text.trim()) continue
    const geom = editor.getShapeGeometry(shape)
    const labelGeom = geom.children?.find(c => c.isLabel)
    const local = (labelGeom ?? geom).bounds
    const center = editor.getShapePageTransform(shape).applyToPoint(local.center)
    const col = (center.x - view.cx) * view.z / CELL_W + columns / 2
    const row = (center.y - view.cy) * view.z / CELL_H + rows / 2
    // 글자가 들어갈 수 있는 폭/높이 (칸)
    const room = shape.type === 'arrow' ? local : geom.bounds
    const maxW = Math.floor((room.w * view.z) / CELL_W) - (shape.type === 'arrow' ? -4 : 1)
    const maxH = Math.max(1, Math.floor((room.h * view.z) / CELL_H))
    if (maxW < 2) continue
    let lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length > maxH) lines = lines.slice(0, maxH)
    const top0 = Math.round(row - lines.length / 2)
    lines.forEach((line, i) => {
      let shown = line
      if (widthOf(shown) > maxW) shown = clip(shown, 0, maxW - 1).text + '…'
      const width = widthOf(shown)
      const r = top0 + i
      if (r < 0 || r >= rows) return
      let left = Math.round(col - width / 2)
      let skip = 0
      if (left < 0) { skip = -left; left = 0 }
      const piece = clip(shown, skip, columns - left)
      if (!piece.text) return
      labels.push({
        col: left + piece.offset,
        row: r,
        text: piece.text,
        fg: colorOf(shape),
        bg: sample(left + piece.offset, piece.width, r),
      })
    })
  }
  return labels
}

function avgAll(px, p) {
  let r = 0, g = 0, b = 0
  for (const q of p) { r += px[q]; g += px[q + 1]; b += px[q + 2] }
  return (Math.round(r / 4) << 16) | (Math.round(g / 4) << 8) | Math.round(b / 4)
}

async function renderSvg(columns, rows) {
  const ids = [...editor.getCurrentPageShapeIds()]
  if (ids.length === 0) return null
  const bounds = viewBounds(columns, rows)
  const result = await editor.getSvgString(ids, { bounds, padding: 0, background: true, darkMode: view.dark })
  if (result && result.svg.length <= 120000) return result.svg
  let scale = (columns * 8) / bounds.w
  while (scale > 0.05) {
    const { blob, width, height } = await editor.toImage(ids, {
      format: 'png', bounds, padding: 0, background: true, darkMode: view.dark, scale,
    })
    const url = await new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.readAsDataURL(blob)
    })
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="${url}" width="${width}" height="${height}"/></svg>`
    if (svg.length <= 120000) return svg
    scale /= 1.6
  }
  return null
}

let lastSize = { columns: 80, rows: 24 }
async function runView({ id, columns, rows, ops, format }) {
  // 편집기가 없는 페이지(다시 불러오는 중)는 답하지 않는다: 편집기가 있는 페이지가 답한다
  if (!editor) return
  try {
    lastSize = { columns, rows }
    if (!view.isFitted && view.z === 1 && view.cx === 0 && view.cy === 0) fitView(columns, rows)
    applyOps(ops, columns, rows)
    const frame = format === 'svg'
      ? { svg: await renderSvg(columns, rows), columns, rows }
      : await renderRaster(columns, rows)
    await post('/reply', {
      id,
      ok: true,
      ...frame,
      shapeCount: editor.getCurrentPageShapeIds().size,
      zoom: view.z,
      dark: view.dark,
    })
  } catch (error) {
    await post('/reply', { id, ok: false, error: String(error?.stack ?? error) })
  }
}

// ── Claude가 exec 코드에서 쓰는 도우미 ───────────────────────────
const sid = name => (String(name).startsWith('shape:') ? name : createShapeId(String(name)))

function geo(kind, name, x, y, w, h, text = '', opts = {}) {
  const id = sid(name)
  const props = { geo: kind, w, h, richText: toRichText(String(text)), ...opts }
  if (editor.getShape(id)) editor.updateShape({ id, type: 'geo', x, y, props })
  else editor.createShape({ id, type: 'geo', x, y, props })
  return id
}

const helpers = {
  toRichText,
  createShapeId,
  sid,
  box: (name, x, y, w, h, text, opts) => geo('rectangle', name, x, y, w, h, text, opts),
  ellipse: (name, x, y, w, h, text, opts) => geo('ellipse', name, x, y, w, h, text, opts),
  diamond: (name, x, y, w, h, text, opts) => geo('diamond', name, x, y, w, h, text, opts),
  note(name, x, y, text, opts = {}) {
    const id = sid(name)
    editor.createShape({ id, type: 'note', x, y, props: { richText: toRichText(String(text)), ...opts } })
    return id
  },
  text(name, x, y, text, opts = {}) {
    const id = sid(name)
    editor.createShape({ id, type: 'text', x, y, props: { richText: toRichText(String(text)), ...opts } })
    return id
  },
  arrow(from, to, label = '', opts = {}) {
    const fromId = sid(from)
    const toId = sid(to)
    const a = editor.getShapePageBounds(fromId)
    const b = editor.getShapePageBounds(toId)
    if (!a || !b) throw new Error(`arrow: shape not found (${from} → ${to})`)
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'arrow',
      x: a.center.x,
      y: a.center.y,
      props: {
        start: { x: 0, y: 0 },
        end: { x: b.center.x - a.center.x, y: b.center.y - a.center.y },
        richText: toRichText(String(label)),
        ...opts,
      },
    })
    const bind = (toShape, terminal) => ({
      type: 'arrow',
      fromId: id,
      toId: toShape,
      props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
    })
    editor.createBindings([bind(fromId, 'start'), bind(toId, 'end')])
    return id
  },
  clear() {
    editor.deleteShapes([...editor.getCurrentPageShapeIds()])
  },
  fit() {
    fitView(lastSize.columns, lastSize.rows)
  },
  shapes() {
    return editor.getCurrentPageShapes().map(s => ({
      id: s.id,
      type: s.type,
      x: Math.round(s.x),
      y: Math.round(s.y),
      ...(s.props.geo ? { geo: s.props.geo } : {}),
      ...(s.props.w ? { w: s.props.w, h: s.props.h } : {}),
      ...(s.props.color ? { color: s.props.color } : {}),
      ...(editor.getShapeUtil(s).getText?.(s) ? { text: editor.getShapeUtil(s).getText(s) } : {}),
    }))
  },
}

function serialize(value) {
  const seen = new WeakSet()
  const text = JSON.stringify(value ?? null, (key, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]'
      seen.add(v)
    }
    if (typeof v === 'function') return '[function]'
    return v
  })
  return text.length > 20000 ? text.slice(0, 20000) + '…(truncated)' : text
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function runExec({ id, code }) {
  // 편집기가 없는 페이지(다시 불러오는 중)는 답하지 않는다: 편집기가 있는 페이지가 답한다
  if (!editor) return
  try {
    const fn = new AsyncFunction('editor', 'tl', ...Object.keys(helpers), code)
    const value = await fn(editor, tl, ...Object.values(helpers))
    await post('/reply', {
      id,
      ok: true,
      value: serialize(value),
      shapeCount: editor.getCurrentPageShapeIds().size,
    })
  } catch (error) {
    await post('/reply', { id, ok: false, error: String(error?.stack ?? error) })
  }
}

// ── 시작: 로컬 캔버스 (data/document.json 에 저장) ─────────────────
let saveTimer = null
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => post('/doc', getSnapshot(editor.store).document), 800)
}

function connect() {
  const events = new EventSource(`/events?t=${token}`)
  events.addEventListener('exec', e => runExec(JSON.parse(e.data)))
  events.addEventListener('view', e => runView(JSON.parse(e.data)))
}

async function init(e) {
  editor = e
  window.editor = e
  try {
    const response = await fetch('/doc', { headers: { 'x-tldraw-token': token } })
    const doc = await response.json()
    if (doc) loadSnapshot(editor.store, { document: doc })
  } catch (error) {
    console.warn('restore failed', error)
  }
  editor.store.listen(scheduleSave, { scope: 'document', source: 'all' })
  connect()
}

createRoot(document.getElementById('root')).render(createElement(Tldraw, { onMount: e => void init(e) }))
