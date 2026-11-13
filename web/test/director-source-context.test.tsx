import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
const { default: DirectorSourceContext } = await import('../src/features/script/DirectorSourceContext')
after(() => dom.window.close())
const source: ScriptSourceDocument = { project_id: 'project', filename: '原稿.md', content: '剧本正文', updated_at: '2026-11-09', analysis: { id: 'analysis', source_version: 'v1', model_id: 'text', status: 'ready', completed_chunks: 1, total_chunks: 1, sections: [], error: null, updated_at: '2026-11-09' } }
async function mount(initial = source) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (value: ScriptSourceDocument, pollError = false) => act(() => root.render(<MantineProvider env="test"><DirectorSourceContext source={value} pollError={pollError}><input aria-label="原稿备注" defaultValue="未提交备注" /><button type="button">恢复分析</button></DirectorSourceContext></MantineProvider>))
  await update(initial)
  return { container, update, toggle: () => container.querySelector<HTMLButtonElement>('.sd-source-context-toggle')!, async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('ready source stays compact while toggling preserves child state', async () => {
  const view = await mount()
  try {
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'false')
    assert.match(view.toggle().textContent!, /创作依据 · 原稿 1 份地图已就绪/)
    const input = view.container.querySelector<HTMLInputElement>('input')!
    input.value = '保留正在填写的备注'
    await act(() => view.toggle().click())
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'true')
    await act(() => view.toggle().click())
    assert.equal(view.container.querySelector('input'), input)
    assert.equal(input.value, '保留正在填写的备注')
  } finally { await view.destroy() }
})

test('failed and paused analyses expose recovery without treating running as a failure', async () => {
  const view = await mount()
  try {
    await view.update({ ...source, analysis: { ...source.analysis!, status: 'running' } })
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'false')
    assert.match(view.toggle().textContent!, /分析中/)
    await view.update({ ...source, analysis: { ...source.analysis!, status: 'failed' } })
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'true')
    assert.match(view.toggle().textContent!, /需重试/)
    await act(() => view.toggle().click())
    await view.update({ ...source, analysis: { ...source.analysis!, status: 'paused' } })
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'true')
    assert.match(view.toggle().textContent!, /已暂停/)
  } finally { await view.destroy() }
})

test('unanalysed sources and polling failures expand required actions and revisions identify the effective draft', async () => {
  const view = await mount({ ...source, analysis: null })
  try {
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'true')
    assert.match(view.toggle().textContent!, /待分析/)
    await view.update({ ...source, revision: 2 })
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'false')
    assert.match(view.toggle().textContent!, /有效稿 1 份地图已就绪/)
    await view.update({ ...source, revision: 2 }, true)
    assert.equal(view.toggle().getAttribute('aria-expanded'), 'true')
    assert.match(view.toggle().textContent!, /状态获取失败/)
  } finally { await view.destroy() }
})
