import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

test('캔버스가 준비되기 전에는 안내 문구와 조작 버튼을 그린다', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tldraw',
      surface,
      component: 'Pane',
      requestId: 'tldraw',
      viewport: { columns: 100, rows: 40 },
      props: {},
    } as never)
    expect((await ui.find({ text: '캔버스를 준비하는 중' } as never)) !== undefined).toBe(true)
    expect(await ui.findAll({ type: 'Button' } as never)).toHaveLength(4)
  }
})

test('code 없이 exec를 부르면 거절한다', async $ => {
  const ran = await $.tool.call({ tool: 'mcp__tldraw__exec', code: '' } as never)
  expect('deny' in ran || (ran as { isError?: boolean }).isError === true).toBe(true)
})
