import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, Provider } from '../src/shared/api/api'
import { skillStageOptions } from '../src/shared/api/skills-api'
import { directorStageContext } from '../src/features/script/script-workflow'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const detail = { id: 'discard-json', name: '检查点草稿放弃', brief: '', ratio: '9:16',
  script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} }, shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'discard-text', provider_id: 'provider', name: '文本模型', remote_id: 'test', modality: 'text', protocol: 'chat_completions', enabled: true, settings: {} } as Model
const provider = { id: 'provider', name: '提供商', enabled: true, adapter: 'http' } as Provider
const checkpoint = { checkpoint_key: 'exact-json-generation', updated_at: '2026-11-10T05:12:13.000Z' }
const draft = { stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: ['outline'],
  artifacts: [{ artifact_type: 'outline', title: '概要设计', content: '待确认的旧版巡夜草稿。' }], scenes: [] }

function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  assert.ok(node, label)
  return node
}

async function mount(t: TestContext, staleCheckpoint = false) {
  let refreshed = 0, closed = 0, retainedDocuments = ['待确认的旧版巡夜草稿。']
  const discards: Array<{ method: string; body: unknown }> = []
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    calls.push(`${method} ${path}`)
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) })
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/conversations')) return Response.json({ conversations: [], task_persistence: false })
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [], creation: {
      version: 'creation-version', status: 'direction', next_step: null, stage_context: directorStageContext(detail.script), saved_episodes: [],
    } })
    if (path.endsWith('/chat/stream')) return Response.json({ detail: '仅支持 JSON 接口' }, { status: 404 })
    if (path.endsWith('/chat')) return Response.json({ reply: '大纲草稿已准备。', draft, generation_checkpoint: checkpoint })
    if (path.endsWith('/generation-progress/discard')) {
      discards.push({ method, body: JSON.parse(String(init?.body)) })
      if (staleCheckpoint) {
        retainedDocuments = ['刚完成的新版本巡夜草稿。']
        return Response.json({ detail: '已保留草稿已更新，请刷新后查看当前版本' }, { status: 409 })
      }
      retainedDocuments = []
      return Response.json({ discarded: true })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem(`script-director-model:${detail.id}`, model.id)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={detail} models={[model]} providers={[provider]}
    onRefresh={async () => { refreshed++ }} onClose={() => { closed++ }} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>))
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '生成一份概要设计。')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => button('发送消息').click())
  return { container, discards, calls, refreshed: () => refreshed, closed: () => closed, retainedDocuments: () => retainedDocuments,
    async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('discarding a JSON generation sends its exact checkpoint and refreshes persisted draft visibility', async t => {
  const view = await mount(t)
  try {
    assert.match(document.querySelector('[aria-label="剧本草稿预览"]')!.textContent!, /待确认的旧版巡夜草稿。/)
    const refreshedBefore = view.refreshed()
    await act(async () => button('放弃草稿').click())
    assert.deepEqual(view.discards, [{ method: 'POST', body: checkpoint }])
    assert.ok(view.refreshed() > refreshedBefore)
    assert.deepEqual(view.retainedDocuments(), [])
    assert.equal(document.querySelector('[aria-label="剧本草稿预览"]'), null)
    assert.equal(dom.window.localStorage.getItem(`script-director-draft:${detail.id}`), null)
    assert.equal(view.calls.some(path => /\/commit$|\/discard-draft$/.test(path)), false)
  } finally { await view.destroy() }
})

test('a stale JSON checkpoint discard refreshes newer work and still allows leaving the director', async t => {
  const view = await mount(t, true)
  try {
    const refreshedBefore = view.refreshed()
    await act(async () => button('放弃草稿').click())
    assert.deepEqual(view.discards, [{ method: 'POST', body: checkpoint }])
    assert.ok(view.refreshed() > refreshedBefore, 'the canvas/editor must reread the new generation after a stale discard')
    assert.deepEqual(view.retainedDocuments(), ['刚完成的新版本巡夜草稿。'], 'the rejected old token cannot hide the new server candidate')
    assert.equal(document.querySelector('[aria-label="剧本草稿预览"]'), null, 'only the old local preview closes')
    await act(async () => button('关闭剧本导演').click())
    assert.equal(view.closed(), 1, 'a stale discard does not leave the UI stuck in a saving state')
    assert.equal(view.calls.filter(path => path.endsWith('/generation-progress/discard')).length, 1)
  } finally { await view.destroy() }
})
