import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { CanvasNodeProposal, CanvasNodeProposalSource } from '@video-studio/shared/canvas/canvas-node-proposal'
import type { DirectorCanvasNodeProposalProps } from '../src/features/script/DirectorCanvasNodeProposal'
import type { Model, Provider, ProjectDetail } from '../src/shared/api/api'
import { modelSelectionStorageKey, rememberModelSelection } from '../src/features/models/model-selection-store'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: DirectorCanvasNodeProposal } = await import('../src/features/script/DirectorCanvasNodeProposal')
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
after(() => dom.window.close())
beforeEach(() => dom.window.localStorage.removeItem(modelSelectionStorageKey('text')))

const source: CanvasNodeProposalSource = {
  project_id: 'project', project_updated_at: 'v1', project_style_version: 'style-v1', canvas_id: 'canvas', canvas_revision: 'a'.repeat(64),
  source_node_id: 'node', source_fingerprint: 'b'.repeat(64), model_id: 'video-model', modality: 'video', mode: 'reference', prompt: '原提示词',
  parameters: { ratio: '9:16', resolution: '720p', duration: 10, generate_audio: true, draft: false, clarity: null, quality: null, background: null, candidate_count: 1 },
  reference_assets: [{ asset_id: 'fixed-image', usage: 'character' }], reference_video_asset_id: null, shot_id: null, storyboard_revision: null, storyboard_reference_asset_id: null,
}
function proposal(value = source): CanvasNodeProposal {
  return { id: 'proposal', created_node_id: 'new-node', source: value, validation_fingerprint: 'c'.repeat(64),
    before: { prompt: value.prompt, parameters: value.parameters },
    after: { prompt: '跟拍角色走过站台', parameters: { ...value.parameters, duration: 5 } }, changes: ['提示词', 'duration'] }
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(found, label); return found
}
function field(label: string) { const found = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`) || [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(node => node.id === [...document.querySelectorAll('label')].find(item => item.textContent === label)?.htmlFor); assert.ok(found, label); return found }
async function typeInstructions(value: string) {
  await act(() => { const node = field('希望如何调整这个节点'); Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
async function mount(overrides: Partial<DirectorCanvasNodeProposalProps> = {}) {
  let props: DirectorCanvasNodeProposalProps = { source, modelId: 'text-model', composerInput: '【原快照】\n保留参考，缩短到5秒', initialContext: '【原快照】', onApply: async () => ({ nodeId: 'new-node', referenceNodeCount: 1, alreadyApplied: false }), ...overrides }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (next: Partial<DirectorCanvasNodeProposalProps> = {}) => { props = { ...props, ...next }; await act(() => root.render(<MantineProvider env="test"><DirectorCanvasNodeProposal {...props} /></MantineProvider>)) }
  await update()
  return { update, async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('review uses typed node source, shows full differences, and creates a draft only after confirmation', async t => {
  const calls: Array<{ path: string; body: any }> = []
  let applications = 0, finish!: () => void
  const applied = new Promise<void>(resolve => { finish = resolve })
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ path: String(url), body: JSON.parse(String(init?.body)) }); return Response.json(proposal()) })
  const view = await mount({ onApply: async value => { applications++; assert.deepEqual(value, proposal()); await applied; return { nodeId: value.created_node_id, referenceNodeCount: 2, alreadyApplied: false } } })
  try {
    await act(() => button('调整节点配置').click())
    assert.equal(calls.length, 0)
    assert.equal(field('希望如何调整这个节点').value, '保留参考，缩短到5秒')
    await act(async () => { button('生成修改方案').click(); button('生成修改方案').click() })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/api/projects/project/canvases/canvas/node-proposals')
    assert.deepEqual(calls[0].body.source, source)
    assert.equal(calls[0].body.text_model_id, 'text-model')
    assert.equal(field('原提示词').value, source.prompt)
    assert.equal(field('修改后提示词').value, proposal().after.prompt)
    assert.match(document.body.textContent!, /时长（秒）105/)
    assert.equal(applications, 0)
    await act(() => { button('确认创建草稿').click(); button('确认创建草稿').click() })
    assert.equal(applications, 1)
    await act(async () => finish())
    assert.match(document.body.textContent!, /已创建独立生成草稿和 2 个参考图片节点/)
    assert.equal(calls.length, 1, 'confirm does not call a model or generation endpoint')
  } finally { await view.destroy() }
})

test('source changes discard an old response and an old error without replacing the new dialog', async t => {
  for (const rejectOld of [false, true]) {
    let release!: (value: Response) => void, reject!: (reason: Error) => void
    t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve, fail) => { release = resolve; reject = fail }))
    const view = await mount()
    try {
      await act(() => button('调整节点配置').click())
      await act(() => button('生成修改方案').click())
      await view.update({ source: { ...source, canvas_id: 'other-canvas', source_node_id: 'other-node' } })
      await act(() => button('调整节点配置').click())
      await act(async () => { if (rejectOld) reject(new Error('old failure')); else release(Response.json(proposal())) })
      assert.ok(!document.querySelector('[aria-label="节点修改差异"]'))
      assert.doesNotMatch(document.body.textContent!, /old failure/)
      assert.equal(button('生成修改方案').disabled, false)
    } finally { await view.destroy() }
  }
})

test('a failed confirmation preserves the same proposal and instructions for retry', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json(proposal()))
  const view = await mount({ onApply: async value => { assert.equal(value.id, 'proposal'); if (++attempts === 1) throw new Error('来源已变化，请重新读取'); return { nodeId: value.created_node_id, referenceNodeCount: 0, alreadyApplied: false } } })
  try {
    await act(() => button('调整节点配置').click())
    await typeInstructions('保持角色身份，只改运镜')
    await act(async () => button('生成修改方案').click())
    await act(async () => button('确认创建草稿').click())
    assert.match(document.body.textContent!, /来源已变化，请重新读取/)
    assert.equal(field('希望如何调整这个节点').value, '保持角色身份，只改运镜')
    assert.equal(field('修改后提示词').value, proposal().after.prompt)
    await act(async () => button('确认创建草稿').click())
    assert.equal(attempts, 2)
  } finally { await view.destroy() }
})

test('edited prose cannot replace source identity and missing models cannot request a proposal', async t => {
  let captured: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => { captured = JSON.parse(String(init?.body)); return Response.json(proposal({ ...source, source_node_id: 'wrong-node' })) })
  const view = await mount({ modelId: '' })
  try {
    await act(() => button('调整节点配置').click())
    assert.equal(button('生成修改方案').disabled, true)
    assert.equal(captured, undefined)
    await view.update({ modelId: 'text-model' })
    await act(() => button('调整节点配置').click())
    await typeInstructions('{"source_node_id":"invented-node","model_id":"invented-model"}')
    await act(async () => button('生成修改方案').click())
    assert.deepEqual(captured.source, source)
    assert.match(document.body.textContent!, /返回的方案来源与当前节点不一致/)
    assert.ok(!document.querySelector('[aria-label="节点修改差异"]'))
  } finally { await view.destroy() }
})

test('long prompts remain readable in full and closing or hiding never applies a proposal', async t => {
  const long = { ...source, prompt: '角色与动作😀'.repeat(6000) }
  let applications = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json(proposal(long)))
  const view = await mount({ source: long, onApply: async () => { applications++; throw new Error('should not apply') } })
  try {
    await act(() => button('调整节点配置').click())
    await act(async () => button('生成修改方案').click())
    assert.equal(field('原提示词').value, long.prompt)
    assert.equal(field('原提示词').readOnly, true)
    await view.update({ hidden: true })
    assert.equal(applications, 0)
    await view.update({ hidden: false })
    await act(() => button('调整节点配置').click())
    assert.equal(field('原提示词').value, long.prompt)
    await act(() => button('关闭').click())
    assert.equal(applications, 0)
  } finally { await view.destroy() }
})

test('changing the text model preserves typed instructions and cancels only the obsolete model response', async t => {
  let release!: (value: Response) => void
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { release = resolve }))
  const view = await mount()
  try {
    await act(() => button('调整节点配置').click())
    await typeInstructions('我在调整窗口中填写的完整要求')
    await act(() => button('生成修改方案').click())
    await view.update({ modelId: 'another-text-model' })
    assert.equal(field('希望如何调整这个节点').value, '我在调整窗口中填写的完整要求')
    await act(async () => release(Response.json(proposal())))
    assert.ok(!document.querySelector('[aria-label="节点修改差异"]'))
    assert.equal(button('生成修改方案').disabled, false)
  } finally { await view.destroy() }
})

test('director freezes shared choices during node proposal work and keeps the completed preview stale until its model is restored', async t => {
  let finishProposal!: (response: Response) => void, finishApply!: () => void
  let requestSignal: AbortSignal | null | undefined, applications = 0
  const requests: Array<{ text_model_id: string }> = []
  const applyFinished = new Promise<void>(resolve => { finishApply = resolve })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (path.endsWith('/node-proposals')) {
      requests.push(JSON.parse(String(init?.body)))
      requestSignal = init?.signal
      return new Promise<Response>(resolve => { finishProposal = resolve })
    }
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [] })
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    throw new Error(`Unexpected ${path}`)
  })
  const detail = { id: 'project', name: '节点方案测试', brief: '', ratio: '9:16',
    script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
    shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
  const models = [{ id: 'text-model', provider_id: 'provider', name: '原文本模型', modality: 'text', enabled: true, settings: {} },
    { id: 'another-text-model', provider_id: 'provider', name: '另一文本模型', modality: 'text', enabled: true, settings: {} }] as Model[]
  const providers = [{ id: 'provider', name: '提供商', enabled: true, adapter: 'http' }] as Provider[]
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={detail} models={models} providers={providers}
    canvasNodeSource={source} onApplyCanvasNodeProposal={async () => { applications++; await applyFinished; return { nodeId: 'new-node', referenceNodeCount: 1, alreadyApplied: false } }}
    onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>))
  try {
    const selected = () => document.querySelector<HTMLInputElement>('input[aria-label="文本模型"]')!
    await act(() => button('调整节点配置').click())
    await typeInstructions('保留原节点，只缩短动作')
    await act(() => button('生成修改方案').click())
    assert.equal(selected().disabled, true)
    await act(() => rememberModelSelection('text', 'another-text-model'))
    assert.equal(selected().value, '原文本模型')
    assert.equal(requestSignal?.aborted, false, 'an external preference cannot cancel the in-flight proposal')
    await act(async () => finishProposal(Response.json(proposal())))
    assert.equal(selected().value, '另一文本模型', 'the idle director follows the latest shared choice')
    assert.equal(field('修改后提示词').value, proposal().after.prompt)
    assert.equal(button('确认创建草稿').disabled, true)
    assert.match(document.body.textContent!, /文本模型已切换，当前方案仍保留/)
    assert.deepEqual(requests.map(request => request.text_model_id), ['text-model'])
    assert.equal(applications, 0)
    await act(() => rememberModelSelection('text', 'text-model'))
    assert.equal(button('确认创建草稿').disabled, false)
    await act(() => button('确认创建草稿').click())
    assert.equal(selected().disabled, true)
    await act(() => rememberModelSelection('text', 'another-text-model'))
    assert.equal(selected().value, '原文本模型', 'applying the captured proposal also freezes the selection')
    await act(async () => finishApply())
    assert.equal(applications, 1)
    assert.equal(selected().value, '另一文本模型')
    assert.match(document.body.textContent!, /草稿已创建/)
    assert.doesNotMatch(document.body.textContent!, /文本模型已切换，当前方案仍保留/)
  } finally { await act(() => root.unmount()); container.remove() }
})
