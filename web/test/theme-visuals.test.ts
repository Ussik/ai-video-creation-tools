import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useThemeVisuals } from '../src/features/script/useThemeVisuals.ts'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key as keyof Window] })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

test('custom artwork matching debounces, ignores late responses, caches reopening and keeps canonical selections immediate', async t => {
  type Request = { body: { genre: string }; signal: AbortSignal; resolve: (value: Response) => void }
  const requests: Request[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/projects/theme-test/script/themes/visuals')
    return new Promise(resolve => requests.push({ body: JSON.parse(String(init?.body)), signal: init!.signal as AbortSignal, resolve }))
  }
  t.after(() => { globalThis.fetch = originalFetch; dom.window.close() })
  const timers = new Map<number, () => void>()
  let id = 0
  dom.window.setTimeout = callback => { timers.set(++id, callback as () => void); return id }
  dom.window.clearTimeout = timer => { timers.delete(timer) }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let current: ReturnType<typeof useThemeVisuals>
  let props = { genre: '悬疑恐怖', fusion: '民俗恐怖', open: true }
  function View() { current = useThemeVisuals('theme-test', 'model', props.genre, props.fusion, props.open); return null }
  const render = (patch = {}) => act(() => { props = { ...props, ...patch }; root.render(createElement(View)) })
  const fire = () => act(() => { for (const callback of timers.values()) callback(); timers.clear() })
  const respond = async (request: Request, primary: string | null, fusion: string | null) => act(async () => {
    request.resolve(new Response(JSON.stringify({ primary, fusion }), { headers: { 'Content-Type': 'application/json' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  try {
    render()
    assert.equal(requests.length, 0)
    fire()
    assert.equal(requests.length, 1)
    render({ genre: '未知世界' })
    assert.equal(requests[0].signal.aborted, true)
    await respond(requests[0], '悬疑推理', '惊悚怪谈')
    assert.equal(current!.primary, null, 'old response cannot change newer custom selection')
    fire()
    await respond(requests[1], null, '惊悚怪谈')
    assert.equal(current!.status, 'ready')
    assert.equal(current!.primary, null)
    assert.equal(current!.fusion, '惊悚怪谈')
    render({ open: false })
    render({ open: true })
    fire()
    assert.equal(requests.length, 2, 'modal reopening uses the cached match')
    render({ genre: '都市现实', fusion: '喜剧' })
    assert.equal(current!.primary, '都市现实')
    assert.equal(current!.fusion, '喜剧')
    fire()
    assert.equal(requests.length, 2)
  } finally { act(() => root.unmount()); container.remove() }
})
