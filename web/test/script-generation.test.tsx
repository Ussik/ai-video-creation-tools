import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Editor } from '@tiptap/core'
import type { Model, ProjectDetail, Provider } from '../src/shared/api/api'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptEditor } = await import('../src/features/script/ScriptEditor')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const project = { id: 'generation-test', name: '山海经', brief: '', ratio: '9:16', script: {
  outline: '保留已确认的大纲', characters: '已确认人物', scenes: [], generation_options: {},
}, shots: [], assets: [], jobs: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'text', provider_id: 'provider', name: '文本模型', modality: 'text', enabled: true } as Model
const provider = { id: 'provider', name: '提供商', adapter: 'http', enabled: true } as Provider

function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  assert.ok(result, label)
  return result
}
async function settle() { await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
async function mount(t: TestContext, detail = project) {
  let openedCanvas = 0
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body || '{}'))
    requests.push({ path, body, method: init?.method || 'GET' })
    if (path.endsWith('/script/commit')) return Response.json(body)
    throw new Error(`Unexpected request: ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><ScriptEditor detail={detail} models={[model]} providers={[provider]}
    onRefresh={async () => detail} onOpenModels={() => {}} onOpenCanvas={() => { openedCanvas++ }} onNotice={() => {}} /></MantineProvider>))
  await settle()
  return { container, requests, openedCanvas: () => openedCanvas, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('editor keeps saved documents and canvas navigation without a complete-script generation entry', async t => {
  const view = await mount(t)
  try {
    assert.ok(![...view.container.querySelectorAll('button')].some(node => ['生成剧本', '查看生成结果'].includes(node.textContent || '')))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.match(view.container.querySelector('[data-script-section="outline"]')!.textContent!, /保留已确认的大纲/)
    assert.equal(button('保存').disabled, true)
    assert.ok(button('全文搜索'))
    assert.ok(button('加入画布'))
    await act(() => button('返回画布').click())
    assert.equal(view.openedCanvas(), 1)
    assert.deepEqual(view.requests, [], 'opening the editor never requests generation prompts or drafts')
  } finally { await view.destroy() }
})

test('manual document edits still support undo, redo and saving through the original contract', async t => {
  const view = await mount(t)
  try {
    const element = view.container.querySelector('[data-script-section="outline"] [contenteditable]') as HTMLElement & { editor: Editor }
    assert.ok(element.editor)
    await act(() => { element.editor.commands.setContent('<p>手动细化的全剧大纲</p>') })
    assert.equal(button('保存').disabled, false)
    await act(() => button('撤销').click())
    assert.match(view.container.querySelector('[data-script-section="outline"]')!.textContent!, /保留已确认的大纲/)
    await act(() => button('重做').click())
    assert.match(view.container.querySelector('[data-script-section="outline"]')!.textContent!, /手动细化的全剧大纲/)
    await act(async () => button('保存').click()); await settle()
    assert.equal(view.requests.length, 1)
    assert.ok(view.requests[0].path.endsWith('/script/commit'))
    assert.equal(view.requests[0].method, 'PUT')
    assert.equal(view.requests[0].body.outline, '手动细化的全剧大纲')
    assert.equal(view.requests[0].body.characters, project.script.characters)
    assert.deepEqual(view.requests[0].body.scenes, project.script.scenes)
    assert.equal(button('保存').disabled, true)
  } finally { await view.destroy() }
})

test('design groups expose four editable sections and preserve historical model titles and bodies when saving', async t => {
  const legacy = [
    { id: 'saved-location', artifact_type: 'locations', title: '场景设计', content: '# 原有场景标题\n旧车站原文', position: 0, status: 'ready' },
    { id: 'saved-prop', artifact_type: 'props', title: '道具设计', content: '# 原有道具标题\n怀表原文', position: 1, status: 'ready' },
    { id: 'custom-atmosphere', artifact_type: 'location_atmosphere', title: '车站 · 冷暖光线', content: '夕阳透过候车厅', position: 2, status: 'ready' },
  ]
  const detail = { ...project, script: { ...project.script, artifacts: legacy } } as unknown as ProjectDetail
  const view = await mount(t, detail)
  try {
    for (const stage of ['locations', 'props'] as const) {
      const group = view.container.querySelector(`[data-script-stage="${stage}"]`)!
      assert.deepEqual([...group.querySelectorAll('.script-document-nav-item')].map(item => item.textContent), scriptStageArtifacts[stage].map(type => scriptArtifactLabels[type]))
      await act(() => button(stage === 'locations' ? '场景设计' : '道具设计', group).click()); await settle()
      assert.equal(view.container.querySelector('.script-long-document-cover h1')!.textContent, stage === 'locations' ? '场景设计' : '道具设计')
      assert.equal(view.container.querySelectorAll('[data-script-section]').length, 4)
      assert.equal(view.container.querySelector(`[data-script-section="${stage}"] h2`)!.textContent, scriptArtifactLabels[stage])
      assert.match(view.container.querySelector(`[data-script-section="${stage}"] [contenteditable]`)!.textContent!, /原有.*标题/)
      for (const type of scriptStageArtifacts[stage]) assert.ok(view.container.querySelector(`[data-script-section="${type}"] [contenteditable]`))
      if (stage === 'locations') assert.equal(view.container.querySelector('[data-script-section="location_atmosphere"] h2')!.textContent, '车站 · 冷暖光线')
    }
    const element = view.container.querySelector('[data-script-section="prop_visuals"] [contenteditable]') as HTMLElement & { editor: Editor }
    await act(() => element.editor.commands.setContent('<p>银制怀表，表盖有缺口。</p>'))
    await act(async () => button('保存').click()); await settle()
    const saved = view.requests[0].body.artifacts as Array<{ artifact_type: string; title: string; content: string }>
    for (const original of legacy) {
      const result = saved.find(doc => doc.artifact_type === original.artifact_type)!
      assert.equal(result.title, original.title)
      assert.equal(result.content, original.content)
    }
    assert.equal(saved.find(doc => doc.artifact_type === 'prop_visuals')!.content, '银制怀表，表盖有缺口。')
    assert.equal(view.requests.length, 1)
  } finally { await view.destroy() }
})
