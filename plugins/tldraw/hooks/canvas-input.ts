import type { ClientModule, ClientSurface, JsonValue } from 'claude-code'

// pane의 그림 위에 겹쳐 놓이는 투명한 입력 영역.
// 드래그는 시작점부터의 누적 이동량으로 보낸다: 한 프레임에 post가 여러 번이면
// 마지막 것만 전달되므로, 누적값이어야 중간 값이 사라져도 이동량이 맞는다.
type Drag = { id: number; x0: number; y0: number; dx: number; dy: number }

const drags = new WeakMap<ClientSurface, Drag | null>()
let seq = 0

const CanvasInput: ClientModule<JsonValue> = (props, surface) => {
  surface.onPointer(event => {
    const x = event.fine?.x ?? event.x
    const y = event.fine?.y ?? event.y
    const drag = drags.get(surface)

    if (event.type === 'down' && event.button === 'left') {
      seq += 1
      drags.set(surface, { id: seq, x0: x, y0: y, dx: 0, dy: 0 })
    } else if (event.type === 'move' && drag && event.button) {
      drag.dx = x - drag.x0
      drag.dy = y - drag.y0
      surface.post({ type: 'drag', id: drag.id, dx: drag.dx, dy: drag.dy })
    } else if (event.type === 'up' && drag) {
      surface.post({ type: 'drag', id: drag.id, dx: drag.dx, dy: drag.dy })
      drags.set(surface, null)
    }
  })

  surface.onKey(event => surface.post({ type: 'key', key: event.key }))

  return surface.elements.Box({
    width: surface.columns || undefined,
    height: surface.rows || undefined,
  })
}

export default CanvasInput
