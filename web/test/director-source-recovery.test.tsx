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
const source: ScriptSourceDocument = { project_id: detail.id, filename: '夜巡剧本.txt', content: '用于父路径恢复验收的已保存剧本。', updated_at: 'source-1', analysis }
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
    if (path.endsWith('/script/source/analysis') && method === 'POST') return recovery(path, init)
    if (path.endsWith('/script/source/analysis') && method === 'GET') return Response.json((typeof sourceValue === 'function' ? sourceValue() : sourceValue).analysis)
    if (path.endsWith('/request-recovery') || path.endsWith('/request-recovery/reconcile') || path.endsWith('/request-recovery/prepare')) return recovery(path, init)
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

// Extraction progress is restored; quality loops and implicit recovery remain retired.
test('saved manuscript states show analysis progress without automatic dispatch or production gates', async t => {
  for (const status of ['failed', 'paused', 'queued', 'running', 'ready'] as const) await t.test(status, async t => {
    const archived = { ...source, analysis: { ...analysis, status, ...(status === 'ready' ? { resume: undefined } : {}) } }
    const view = await mount(t, () => { throw new Error('unexpected recovery request') }, archived)
    try {
      assert.equal(button('选择本次制作范围'), undefined)
      assert.ok(button('故事大纲'))
      if (status === 'queued' || status === 'running') {
        assert.ok(button('暂停分析'))
        assert.ok(view.container.querySelector('[aria-label="剧本分析状态"]'))
      } else if (status !== 'ready') {
        assert.match(view.container.textContent!, /请求的最终结果尚未确认/)
        assert.equal(button('继续原稿分析'), undefined)
        assert.ok(button('处理未完成请求'))
      } else {
        assert.match(view.container.textContent!, /地图已就绪/)
      }
      assert.equal(button('确认可能重复计费并恢复'), undefined)
      assert.equal(view.requests.filter(r => /request-recovery|production/.test(r.path)).length, 0)
      assert.equal(view.requests.filter(r => r.method === 'POST').length, 0)
      assert.equal(document.querySelector('[role="dialog"]'), null)
      assert.deepEqual(view.notices, [])
    } finally { await view.destroy() }
  })
})


test('unknown request details are actionable read-only and never restart a historical request', async t => {
  const blocker = { id: 'unknown-1', scope: '原文读取', request_key: 'key', run_id: analysis.id,
    updated_at: '2026-11-15T09:00:00Z', state: 'dispatched', delivery: 'unknown', local_request_id: 'local-id', upstream_request_id: 'provider-id', identity_binding: 'native' }
  const view = await mount(t, () => Response.json({ ...details, blockers: [blocker] }))
  try {
    assert.equal(view.requests.filter(r => r.path.includes('request-recovery')).length, 0)
    await act(() => button('请求详情')!.click()); await settle()
    assert.match(document.querySelector('[aria-label="原稿分析请求详情"]')!.textContent!, /provider-id/)
    assert.match(document.querySelector('[aria-label="原稿分析请求详情"]')!.textContent!, /不会重新发送/)
    await act(() => button('刷新请求详情')!.click()); await settle()
    assert.equal(view.requests.filter(r => r.path.endsWith('/request-recovery')).length, 2)
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 0)
    assert.ok(button('故事大纲'))
    assert.equal(view.container.querySelector('.sd-source-context-toggle')!.getAttribute('aria-expanded'), 'true')
    assert.doesNotMatch(view.container.querySelector('.script-director-messages')!.textContent!, /审核|修补|复核|门槛/)
  } finally { await view.destroy() }
})


test('unknown extraction opens local reconciliation and an exact duplicate-usage choice, without resending', async t => {
  const archived = { ...source, analysis: { ...analysis, analysis_mode: 'extract' as const, status: 'paused' as const,
    story_progress: { completed: 4, total: 13, pending: [
      { key: 'timeline:1', label: '事件与因果', scope_label: '批次 2', status: 'unknown_response' as const },
      { key: 'timeline:2', label: '事件与因果', scope_label: '批次 3', status: 'unknown_response' as const },
      { key: 'threads:0', label: '伏笔与回收', status: 'pending' as const },
    ] } } }
  const legacy = { analysis_id: analysis.id, cas_token: details.cas_token, client_action_id: 'exact-confirmation', workflow_id: 'local-workflow', max_model_requests: 2, saved_count: 4,
    warning: '旧请求可能已计费，再次生成可能重复计费。' }
  const view = await mount(t, (path, init) => {
    if (path.endsWith('/prepare')) {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.decision, 'reconcile_local'); assert.equal(body.risk_confirmation, undefined)
      return Response.json({ action_id: 'local-workflow', analysis: archived.analysis, reconciliation: conflictFacts,
        recovery: { outcome: 'risk_required', phase: 'awaiting_risk', message: '本地没有完整回答；最终结果仍未知。', model_requests_started: false, legacy_resume: legacy, summary: { saved_count: 4, pending_items: [{label: '事件与因果', scope_label: '批次 2', status: 'unknown_response'}], reason: '部分请求未收到完整结果，继续前需确认可能产生的重复费用。' } } })
    }
    assert.equal(init?.method || 'GET', 'GET', 'no unknown request resend is authorized by inspecting')
    return Response.json({ ...details, reconciliation: { ...conflictFacts, can_reconcile: true } })
  }, archived)
  try {
    const card = view.container.querySelector('[aria-label="剧本分析状态"]')!
    assert.equal(view.container.querySelectorAll('[aria-label="剧本分析状态"]').length, 1)
    const welcome = view.container.querySelector('[data-message-id="welcome"]')!
    assert.ok(welcome.compareDocumentPosition(card) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'source task follows welcome')
    assert.match(card.textContent!, /请求结果未知/)
    assert.match(card.textContent!, /已保存 4 项 \/ 当前计划 13 项/)
    assert.doesNotMatch([...card.querySelectorAll('.sd-source-analysis-status, .sd-analysis-summary, .sd-analysis-note')].map(n => n.textContent).join(''), /当前任务|timeline:1|已暂停/)
    await act(() => button('技术详情')!.click()); await settle()
    const detailDialog = card.querySelector('.sd-analysis-details')!
    assert.equal([...detailDialog.querySelectorAll('strong')].filter(n => n.textContent?.startsWith('事件与因果')).length, 1)
    assert.match(detailDialog.textContent!, /批次 2、批次 3/)
    assert.match(detailDialog.textContent!, /尚未执行/)
    assert.equal(document.querySelector('[role="dialog"]'), null, 'technical details remain inline')
    await act(() => button('技术详情')!.click())
    await settle()
    await act(() => { button('处理未完成请求')!.click(); button('处理未完成请求')!.click() }); await settle(); await settle()
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 1, 'double click prepares once')
    assert.ok(view.requests.find(r => r.path.endsWith('/prepare')))
    assert.equal(button('核对本地保存回答'), undefined)
    assert.equal(document.querySelector('[role="dialog"]'), null, 'preparation result stays in the card')
    assert.match(card.textContent!, /部分请求未收到完整结果/)
    await act(() => button('继续未完成项')!.click()); await settle()
    assert.match(document.querySelector('[aria-label="确认恢复未完成项"]')!.textContent!, /已完成的4项会保留。部分请求未收到完整结果，重新请求可能产生重复费用。/)
    assert.equal(document.querySelector('[role="dialog"] code'), null)
    await act(() => button('暂不继续')!.click()); await settle()
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 1, 'opening and cancelling a risk choice cannot resend')
  } finally { await view.destroy() }
})

test('safe user pause offers continuation while failure remains visibly distinct', async t => {
  for (const status of ['paused', 'failed'] as const) await t.test(status, async t => {
    const archived = { ...source, analysis: { ...analysis, analysis_mode: 'extract' as const, status, pause_reason: 'user' as const,
      ...(status === 'failed' ? { failure: { stage: 'format' as const, message: '完整回答格式尚未通过校验' } } : {}),
      resume: { available: true, action: 'continue' as const, message: '已保存结果会复用' } } }
    const view = await mount(t, () => assert.fail('no recovery request before user action'), archived)
    try {
      const card = view.container.querySelector('[aria-label="剧本分析状态"]')!
      assert.match(card.textContent!, status === 'paused' ? /已暂停/ : /分析失败/)
      assert.ok(button('继续分析'))
      assert.equal(button('处理未完成请求'), undefined)
      assert.equal(view.requests.filter(r => r.method === 'POST').length, 0)
    } finally { await view.destroy() }
  })
})


test('safe paused extraction continues through the normal analysis API with source binding', async t => {
  const archived = { ...source, analysis: { ...analysis, analysis_mode: 'extract' as const, status: 'paused' as const,
    pause_reason: 'user' as const, resume: { available: true, action: 'continue' as const, message: '复用完成项' } } }
  const view = await mount(t, (path, init) => {
    assert.ok(path.endsWith('/script/source/analysis'))
    assert.deepEqual(JSON.parse(String(init?.body)), { model_id: model.id, source_updated_at: source.updated_at })
    return Response.json({ ...archived.analysis, status: 'queued' })
  }, archived)
  try {
    await act(() => button('继续分析')!.click()); await settle()
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 1)
    assert.ok(button('暂停分析'))
    assert.equal(view.requests.filter(r => r.path.includes('request-recovery')).length, 0)
  } finally { await view.destroy() }
})


test('automatic local preparation adopts a newly arrived result without a fee dialog or generation', async t => {
  const archived = { ...source, analysis: { ...analysis, analysis_mode: 'extract' as const } }
  const view = await mount(t, (path, init) => {
    if (path.endsWith('/prepare')) return Response.json({ action_id: 'local-only', analysis: { ...archived.analysis, status: 'ready', resume: undefined },
      reconciliation: conflictFacts, recovery: { outcome: 'completed', phase: 'completed', message: '已完成本地校验', model_requests_started: false,
        summary: { saved_count: 5, pending_items: [], reason: '已复用本地结果，原稿分析完成。' } } })
    assert.equal(init?.method || 'GET', 'GET')
    return Response.json(details)
  }, archived)
  try {
    await act(() => button('处理未完成请求')!.click()); await settle(); await settle()
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 1)
    assert.match(view.container.textContent!, /原稿分析完成/)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(button('继续未完成项'), undefined)
  } finally { await view.destroy() }
})

test('a preparation with no recoverable range explains why and cannot offer a resend confirmation', async t => {
  const archived = { ...source, analysis: { ...analysis, analysis_mode: 'extract' as const } }
  const view = await mount(t, path => path.endsWith('/prepare') ? Response.json({ action_id: 'stopped', analysis: archived.analysis,
    reconciliation: conflictFacts, recovery: { outcome: 'stopped', phase: 'stopped', message: 'private checkpoint diagnostic', model_requests_started: false,
      summary: { saved_count: 4, pending_items: [{ label: '事件与因果', status: 'unknown_response' }], reason: '当前有多条未知请求，暂不能一次重新生成。' } } }) : Response.json(details), archived)
  try {
    await act(() => button('处理未完成请求')!.click()); await settle(); await settle()
    const card = view.container.querySelector('[aria-label="剧本分析状态"]')!
    assert.match(card.textContent!, /当前有多条未知请求/)
    assert.doesNotMatch(card.querySelector('[aria-label="分析状态说明"]')!.textContent!, /checkpoint/)
    assert.equal(button('继续未完成项'), undefined)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.ok(button('重新检查未完成项'))
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 1)
  } finally { await view.destroy() }
})


test('local validation requiring a model offers one normal generation action without another replay', async t => {
  const archived = { ...source, analysis: { ...analysis, analysis_mode: 'extract' as const, status: 'paused' as const,
    pause_reason: 'local_validation' as const, local_validation: { checked_at: 'now', reused_tasks: 1, model_required: true, summary: '本地回答已复用，剩余需模型生成。' },
    story_progress: { completed: 10, total: 11, protected_keys: [], pending: [{ key: 'characters:1', label: '人物与身份', status: 'pending' as const }] },
    resume: { available: true, action: 'continue' as const, message: '继续只生成未派发内容。' } } }
  const view = await mount(t, (path, init) => {
    assert.ok(path.endsWith('/script/source/analysis'))
    assert.deepEqual(JSON.parse(String(init?.body)), { model_id: model.id, source_updated_at: source.updated_at })
    return Response.json({ ...archived.analysis, status: 'queued' })
  }, archived)
  try {
    assert.equal(button('重新校验保存回答'), undefined)
    assert.match(view.container.querySelector('[aria-label="分析状态说明"]')!.textContent!, /会产生用量/)
    await act(() => { button('继续生成未完成项')!.click(); button('继续生成未完成项')!.click() }); await settle()
    assert.equal(view.requests.filter(r => r.method === 'POST').length, 1)
    assert.equal(view.requests.some(r => /revalidate|request-recovery/.test(r.path)), false)
    assert.ok(button('暂停分析'))
  } finally { await view.destroy() }
})
