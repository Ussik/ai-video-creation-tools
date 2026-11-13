import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider, Modal } from '@mantine/core'
import { ReactFlow, ReactFlowProvider, useReactFlow, type Node, type ReactFlowInstance } from '@xyflow/react'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`, import.meta.url)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}

let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
const cancelFrame = (id: number) => frames.delete(id)
Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
function dimensions(element: Element) {
  const html = element as HTMLElement
  const flow = html.closest<HTMLElement>('.pc-flow')
  return {
    width: Number.parseFloat(html.style.width) || Number(flow?.dataset.width) || 1200,
    height: Number.parseFloat(html.style.height) || Number(flow?.dataset.height) || 800,
  }
}
for (const [name, axis] of [['offsetWidth', 'width'], ['clientWidth', 'width'], ['offsetHeight', 'height'], ['clientHeight', 'height']] as const) {
  Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, get() { return dimensions(this)[axis] } })
}
dom.window.Element.prototype.getBoundingClientRect = function () {
  const size = dimensions(this)
  return { ...size, x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, toJSON() { return this } }
}
class TestResizeObserver {
  static instances = new Set<TestResizeObserver>()
  targets = new Set<Element>()
  constructor(private callback: ResizeObserverCallback) { TestResizeObserver.instances.add(this) }
  observe(target: Element) {
    this.targets.add(target)
    requestFrame(() => this.notify(target))
  }
  notify(target: Element) {
    if (target.isConnected && this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear(); TestResizeObserver.instances.delete(this) }
}
Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
Object.assign(dom.window, { ResizeObserver: TestResizeObserver, DOMMatrixReadOnly: class { m22 = 1 } })
const { createRoot } = await import('react-dom/client')
const { default: CanvasComposerToolbar } = await import('../src/features/canvas/CanvasComposerToolbar')
after(() => dom.window.close())

const initialNode: Node = { id: 'image', position: { x: 400, y: 100 }, width: 400, height: 250, data: {}, selected: true }
async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 6; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(pass * 16))
    }
  })
}
async function mount(width = 1200, height = 800, bottomInset = 0, keyboardDialogs = false) {
  frames.clear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let instance: ReactFlowInstance
  function Harness() {
    instance = useReactFlow()
    const [expanded, setExpanded] = useState(false)
    const [nestedOpened, setNestedOpened] = useState(false), [menuOpened, setMenuOpened] = useState(false)
    return <div className="project-canvas"><div className="pc-flow" data-width={width} data-height={height}>
      <ReactFlow defaultNodes={[initialNode]} defaultViewport={{ x: 10, y: 20, zoom: 1 }} minZoom={0.1} maxZoom={8}>
        <CanvasComposerToolbar nodeId="image" expanded={expanded} bottomInset={bottomInset} onCollapse={() => setExpanded(false)}>
          <div className="pc-prompt-composer">
            <div className="pc-prompt-composer-head"><button aria-label={expanded ? '缩小创作区' : '放大创作区'} onClick={() => setExpanded(value => !value)}>展开</button></div>
            <div className="pc-prompt-composer-body"><textarea aria-label="创作提示词" defaultValue="保持提示词" />
              {keyboardDialogs && <>
                <button aria-label="查看固定设定" onClick={() => setNestedOpened(true)}>查看</button>
                <button aria-label="打开参数菜单" aria-haspopup="menu" aria-expanded={menuOpened} onClick={() => setMenuOpened(true)}>参数</button>
                {menuOpened && <div role="menu" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpened(false) } }}>
                  <input aria-label="菜单输入" />
                </div>}
                <Modal opened={nestedOpened} onClose={() => setNestedOpened(false)} title="固定设定验收" withCloseButton={false}
                  attributes={{ content: { 'aria-label': '固定设定验收' } }} zIndex={280} transitionProps={{ duration: 0 }}>
                  <input aria-label="弹窗首项" data-autofocus />
                  <button aria-label="弹窗末项" onClick={() => setNestedOpened(false)}>返回正文</button>
                </Modal>
              </>}
            </div>
            <div className="pc-prompt-composer-foot"><button>生成</button></div>
          </div>
        </CanvasComposerToolbar>
      </ReactFlow>
    </div></div>
  }
  await act(() => root.render(<MantineProvider env={keyboardDialogs ? undefined : "test"}><ReactFlowProvider><Harness /></ReactFlowProvider></MantineProvider>))
  await settle()
  return { container, instance: instance!, destroy: async () => { await act(() => root.unmount()); container.remove(); frames.clear() } }
}
function checkAttachment(container: HTMLElement, instance: ReactFlowInstance, bottomInset = 0) {
  const toolbar = container.querySelector<HTMLElement>('.pc-node-toolbar')!
  assert.ok(toolbar, 'actual React Flow NodeToolbar is mounted')
  const node = instance.getInternalNode('image')!
  const view = instance.getViewport()
  const position = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(toolbar.style.transform)!
  assert.ok(position)
  assert.equal(Number(position[1]), (node.internals.positionAbsolute.x + node.measured.width! / 2) * view.zoom + view.x)
  assert.equal(Number(position[2]), (node.internals.positionAbsolute.y + node.measured.height! + bottomInset) * view.zoom + view.y + 24)
  assert.match(toolbar.style.transform, /translate\(-50%, 0%\)/, 'panel stays horizontally centered below the node')
  const anchor = toolbar.querySelector<HTMLElement>('.pc-composer-anchor')!
  assert.equal(anchor.dataset.placement, 'bottom')
  assert.equal(anchor.style.transform, '', 'no second positioning system can move it away from its node')
  assert.notEqual(anchor.style.visibility, 'hidden')
  return anchor
}

test('the editor stays below and centered at every canvas edge without overriding pan or zoom', async () => {
  const view = await mount()
  try {
    checkAttachment(view.container, view.instance)
    for (const viewport of [
      { x: -800, y: -700, zoom: 0.5 },
      { x: 650, y: 500, zoom: 1 },
      { x: -3000, y: -1000, zoom: 4 },
      { x: 50, y: 450, zoom: 0.1 },
    ]) {
      await act(async () => { await view.instance.setViewport(viewport, { duration: 0 }) }); await settle()
      assert.deepEqual(view.instance.getViewport(), viewport, 'editor never pans or zooms the view back into a safe rectangle')
      checkAttachment(view.container, view.instance)
    }
  } finally { await view.destroy() }
})

test('moving and resizing a node preserves the below-node attachment', async () => {
  const view = await mount()
  try {
    const viewport = view.instance.getViewport()
    await act(() => view.instance.setNodes(nodes => nodes.map(node => ({ ...node, position: { x: 1200, y: 700 }, width: 850, height: 500 }))))
    await settle()
    const element = view.container.querySelector('.react-flow__node')!
    await act(() => TestResizeObserver.instances.forEach(observer => observer.notify(element))); await settle()
    assert.deepEqual(view.instance.getNode('image')!.position, { x: 1200, y: 700 })
    assert.deepEqual(view.instance.getInternalNode('image')!.measured, { width: 850, height: 500 })
    checkAttachment(view.container, view.instance)
    assert.deepEqual(view.instance.getViewport(), viewport)
  } finally { await view.destroy() }
})

test('a profile status below the card remains clear of the editor at every zoom', async () => {
  const view = await mount(1200, 800, 26)
  try {
    for (const zoom of [0.1, 1, 2, 8]) {
      const viewport = { x: -250, y: 100, zoom }
      await act(async () => { await view.instance.setViewport(viewport, { duration: 0 }) }); await settle()
      checkAttachment(view.container, view.instance, 26)
      assert.deepEqual(view.instance.getViewport(), viewport)
    }
  } finally { await view.destroy() }
})

test('normal editor size depends on canvas dimensions and stays stable while panning', async () => {
  const view = await mount(390, 600)
  try {
    const anchor = checkAttachment(view.container, view.instance)
    assert.equal(anchor.style.getPropertyValue('--pc-composer-max-width'), '342px')
    assert.equal(anchor.style.getPropertyValue('--pc-composer-max-height'), '420px')
    await act(async () => { await view.instance.setViewport({ x: 600, y: 500, zoom: 2 }, { duration: 0 }) }); await settle()
    assert.equal(anchor.style.getPropertyValue('--pc-composer-max-width'), '342px')
    assert.equal(anchor.style.getPropertyValue('--pc-composer-max-height'), '420px')
    const flow = view.container.querySelector<HTMLElement>('.pc-flow')!
    flow.dataset.width = '600'; flow.dataset.height = '360'
    await act(() => TestResizeObserver.instances.forEach(observer => observer.notify(flow))); await settle()
    assert.equal(anchor.style.getPropertyValue('--pc-composer-max-width'), '552px')
    assert.equal(anchor.style.getPropertyValue('--pc-composer-max-height'), '240px')
    checkAttachment(view.container, view.instance)
  } finally { await view.destroy() }
})

test('expanded editor collapses below its node and returns input focus without changing the viewport', async () => {
  const view = await mount()
  try {
    const viewport = view.instance.getViewport()
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="放大创作区"]')!.click()); await settle()
    assert.ok(view.container.querySelector('[role="dialog"][aria-label="创作区"]'))
    assert.equal(view.container.querySelector('.pc-node-toolbar'), null)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="缩小创作区"]')!.click()); await settle()
    checkAttachment(view.container, view.instance)
    assert.equal(document.activeElement, view.container.querySelector('textarea'))
    assert.equal((document.activeElement as HTMLTextAreaElement).value, '保持提示词')
    assert.deepEqual(view.instance.getViewport(), viewport)
  } finally { await view.destroy() }
})


test('portaled nested dialogs keep Escape ownership and their document Tab focus loop while the composer stays expanded', async () => {
  const view = await mount(1200, 800, 0, true)
  let documentTabs = 0
  const observeTab = (event: KeyboardEvent) => { if (event.key === 'Tab') documentTabs++ }
  document.addEventListener('keydown', observeTab)
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="放大创作区"]')!.click()); await settle()
    const composer = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="创作区"]')!
    assert.ok(composer)
    await act(() => composer.querySelector<HTMLButtonElement>('[aria-label="查看固定设定"]')!.click()); await settle()
    const nested = document.querySelector<HTMLElement>('[role="dialog"][aria-label="固定设定验收"]')!
    assert.ok(nested)
    assert.equal(composer.contains(nested), false, 'regression exercises a real portal outside the composer DOM')
    const first = nested.querySelector<HTMLInputElement>('[aria-label="弹窗首项"]')!
    const last = nested.querySelector<HTMLButtonElement>('[aria-label="弹窗末项"]')!
    await act(() => last.focus())
    const forward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(() => last.dispatchEvent(forward)); await settle()
    assert.equal(documentTabs, 1, 'the outer composer must let Tab reach Mantine’s document focus handler')
    assert.equal(forward.defaultPrevented, true)
    assert.equal(document.activeElement, first, 'Tab wraps inside the nested dialog')
    const backward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    await act(() => first.dispatchEvent(backward)); await settle()
    assert.equal(documentTabs, 2)
    assert.equal(document.activeElement, last, 'Shift+Tab wraps inside the nested dialog')
    await act(() => last.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
    assert.equal(document.querySelector('[role="dialog"][aria-label="固定设定验收"]'), null, 'Escape closes only the nested surface')
    assert.equal(view.container.querySelector('[role="dialog"][aria-label="创作区"]'), composer)
    assert.ok(composer.querySelector('[aria-label="缩小创作区"]'))
    await act(() => composer.querySelector('textarea')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
    assert.equal(view.container.querySelector('[role="dialog"][aria-label="创作区"]'), null, 'Escape on the composer itself still collapses it')
    checkAttachment(view.container, view.instance)
  } finally { document.removeEventListener('keydown', observeTab); await view.destroy() }
})

test('an expanded composer lets its open contained menu consume Escape before collapsing on the next Escape', async () => {
  const view = await mount(1200, 800, 0, true)
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="放大创作区"]')!.click()); await settle()
    const composer = view.container.querySelector<HTMLElement>('[role="dialog"][aria-label="创作区"]')!
    await act(() => composer.querySelector<HTMLButtonElement>('[aria-label="打开参数菜单"]')!.click()); await settle()
    const menuInput = composer.querySelector<HTMLInputElement>('[aria-label="菜单输入"]')!
    await act(() => menuInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
    assert.equal(composer.querySelector('[role="menu"]'), null)
    assert.equal(view.container.querySelector('[role="dialog"][aria-label="创作区"]'), composer)
    await act(() => composer.querySelector('textarea')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
    assert.equal(view.container.querySelector('[role="dialog"][aria-label="创作区"]'), null)
    checkAttachment(view.container, view.instance)
  } finally { await view.destroy() }
})
