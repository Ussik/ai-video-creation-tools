import { sourceProductionDirectory, type SourceProductionState } from '@video-studio/shared/script/script-source-production'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail } from '../src/shared/api/api'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { skillStageOptions } from '../src/shared/api/skills-api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
after(() => dom.window.close())

const model = { id: 'text-model', provider_id: 'provider', name: '文本模型', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', enabled: true, settings: {} } as Model
const provider = { id: 'provider', name: '提供商', enabled: true, adapter: 'http' } as Provider
const detail = { id: 'recovery-project', name: '恢复父路径验收', brief: '', ratio: '9:16',
  script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
  shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const analysis: ScriptSourceAnalysis = { id: 'analysis-1', source_version: 'source-v1', model_id: model.id, status: 'failed', completed_chunks: 1,
  total_chunks: 1, sections: [], updated_at: 'now', error: null,
  resume: { available: true, blocked: true, action: 'reconcile_request', message: '上次请求的最终结果待确认。' } }
const source: ScriptSourceDocument = { project_id: detail.id, filename: '夜巡剧本.txt', content: '第1集 开放结局\n1-1 夜 外 街口\n林舟：再会。\n钟声仍然未解释。', updated_at: 'source-1', analysis }
const conflictFacts = { version: 1, status: 'inconsistent', next: 'inspect_conflict', message: '检查点仍有未知请求，尚未获得完整回答。',
  saved_response: false, checkpoint_unknown: true, ledger_unknown: 0, can_reconcile: true }
const details = { analysis_id: analysis.id, source_updated_at: source.updated_at, model_id: model.id, cas_token: 'cas-1', local_active: false,
  budget: { can_resume: false, grants: 0, max_grants: 3 }, blockers: [], reconciliation: conflictFacts }
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }

async function mount(t: TestContext, recovery: (path: string, init?: RequestInit) => Response | Promise<Response>, sourceValue: ScriptSourceDocument | (() => ScriptSourceDocument) = source) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear()
  dom.window.localStorage.setItem(`script-director-model:${detail.id}`, model.id)
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [], notices: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) })
    if (path.endsWith('/script/source')) return Response.json(typeof sourceValue === 'function' ? sourceValue() : sourceValue)
    if (path.endsWith('/request-recovery') || path.endsWith('/request-recovery/reconcile')) return recovery(path, init)
    if (path.endsWith('/production') || path.endsWith('/production/prepare')) return recovery(path, init)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json(method === 'GET' ? { conversations: [] } : {})
    throw new Error(`Unexpected ${method} ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={detail} models={[model]} providers={[provider]}
    onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={value => notices.push(value)} /></MantineProvider>))
  await settle()
  return { container, requests, notices, async destroy() { await act(() => root.unmount()); container.remove() } }
}


test('restored parent uses the original manuscript analysis and creation flow, without default episode-production UI', async t => {
  const view = await mount(t, () => { throw new Error('unexpected production or recovery request') })
  try {
    assert.equal(button('选择本次制作范围'), undefined)
    assert.equal(view.container.querySelector('.sd-source-production'), null)
    assert.ok(view.container.querySelector('[aria-label="阶段处理"]'))
    assert.ok(button('故事大纲'))
    assert.equal(button('故事大纲')!.disabled, false, 'old failed audit does not gate creation')
    assert.ok(view.container.querySelector('[aria-label="剧本分析状态"]'))
    assert.equal(view.requests.filter(r => /production|analysis|request-recovery/.test(r.path)).length, 0)
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 0)
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="查看原剧本：夜巡剧本.txt"]')!.click()); await settle()
    const labels = [...document.querySelectorAll('[role=tab]')].map(x => x.textContent)
    assert.ok(labels.includes('剧本地图')); assert.ok(labels.includes('全剧信息'))
    assert.equal(button('提交并重新核对'), undefined)
  } finally { await view.destroy() }
})
