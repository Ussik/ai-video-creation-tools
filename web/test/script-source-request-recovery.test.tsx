import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const { default: ScriptSourceRequestRecovery } = await import('../src/features/script/ScriptSourceRequestRecovery')
const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const analysis: ScriptSourceAnalysis = { id: 'a1', source_version: 'v1', model_id: 'm1', status: 'failed', completed_chunks: 1, total_chunks: 1, sections: [], error: null, updated_at: 'now', resume: { available: true, blocked: true, action: 'reconcile_request', message: '先恢复上次请求' } }
const source: ScriptSourceDocument = { project_id: 'p1', filename: '剧本.txt', content: '原文', updated_at: 'source1', analysis }
const recovered: ScriptSourceAnalysis = { ...analysis, id: 'a2', status: 'queued' }
const facts = { version: 1, status: 'inconsistent', next: 'inspect_conflict', message: '历史请求的最终结果未知。', saved_response: false, checkpoint_unknown: true, ledger_unknown: 0, can_reconcile: true }
const details = { analysis_id: 'a1', source_updated_at: 'source1', model_id: 'm1', cas_token: 'cas1', local_active: false,
  budget: { can_resume: false, grants: 1, max_grants: 3 }, blockers: [], reconciliation: facts }
const risk = { scope_token: 'exact-risk-scope', scope: { kind: 'quality_repair_and_recheck', repair_count: 2, review_count: 1, max_format_corrections_per_step: 1, max_model_requests: 6 }, warning: '旧请求可能已经计费，再次请求可能重复计费。' }
const result = (outcome: string, value = analysis) => ({ action_id: 'audit', analysis: value, reconciliation: facts,
  recovery: { outcome, phase: outcome === 'risk_required' ? 'awaiting_risk' : outcome === 'running' ? 'queued' : outcome, message: outcome === 'risk_required' ? '需要确认重复计费风险后恢复。' : outcome === 'completed' ? '保存回答已恢复，分析完成。' : outcome === 'running' ? '剩余分析已进入执行队列。' : '保存回答未通过引用检查，已停止。', model_requests_started: false,
    ...(outcome === 'risk_required' ? { risk } : {}) } })
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function mount(onRecovered: (value: ScriptSourceAnalysis) => void = () => {}, onRefreshed?: (value: ScriptSourceAnalysis) => void, options: { inline?: boolean; confirmationOpen?: boolean } = {}) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  let current = source, selected = 'm1', opened = true, confirmationOpen = options.confirmationOpen ?? true
  const states: Array<{ state: string; message: string }> = []
  const render = () => act(() => root.render(<MantineProvider env="test"><ScriptSourceRequestRecovery source={current} selectedModelId={selected} opened={opened} inlinePreparation={options.inline} confirmationOpen={confirmationOpen}
    onClose={() => { opened = false; void render() }} onRecovered={onRecovered} onRefreshed={onRefreshed} onStateChange={value => states.push(value)} /></MantineProvider>))
  await render(); await settle()
  return { states, confirm: async () => { confirmationOpen = true; await render(); await settle() }, render: async (next: ScriptSourceDocument, modelId = selected) => { current = next; selected = modelId; await render(); await settle() },
    close: async () => { opened = false; await render(); await settle() }, open: async () => { opened = true; await render(); await settle() },
    destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('one recovery action chains local work through one POST without a dialog or model authorization', async t => {
  dom.window.sessionStorage.clear()
  const posts: Record<string, unknown>[] = [], refreshed: ScriptSourceAnalysis[] = [], paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    paths.push(String(url))
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return Response.json(result('completed', { ...analysis, status: 'ready' })) }
    return Response.json(details)
  })
  const view = await mount(() => assert.fail('local completion cannot announce queued work'), value => refreshed.push(value))
  try {
    assert.equal(posts.length, 1)
    assert.deepEqual(Object.keys(posts[0]).sort(), ['analysis_id', 'cas_token', 'client_action_id', 'decision'])
    assert.equal(posts[0].decision, 'reconcile_local'); assert.equal(posts[0].risk_confirmation, undefined)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(paths, ['/api/projects/p1/script/source/analysis/request-recovery', '/api/projects/p1/script/source/analysis/request-recovery/reconcile'])
    assert.equal(refreshed.length, 1); assert.equal(refreshed[0].status, 'ready'); assert.equal(view.states.at(-1)?.state, 'completed')
  } finally { await view.destroy() }
})

test('the only risk dialog needs one explicit confirmation, preserves action identity and uses fresh CAS', async t => {
  dom.window.sessionStorage.clear()
  const posts: Record<string, unknown>[] = [], adopted: ScriptSourceAnalysis[] = []; let reads = 0
  const queued = deferred<Response>()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return posts.length === 1 ? Response.json(result('risk_required')) : queued.promise }
    reads++; return Response.json({ ...details, cas_token: reads === 1 ? 'cas1' : 'fresh-cas' })
  })
  const view = await mount(value => adopted.push(value))
  try {
    assert.equal(posts.length, 1); assert.ok(document.querySelector('[role="dialog"]'))
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /旧请求.*未知.*不会取消旧请求/s)
    assert.equal(document.querySelector('input[type="checkbox"]'), null)
    assert.equal(button('本次恢复详情').getAttribute('aria-expanded'), 'false')
    await act(() => { button('确认可能重复计费并恢复').click(); button('确认可能重复计费并恢复').click() }); await settle()
    assert.equal(posts.length, 2); assert.equal(reads, 2); assert.equal(posts[1].client_action_id, posts[0].client_action_id)
    assert.equal(posts[1].cas_token, 'fresh-cas')
    assert.deepEqual(posts[1].risk_confirmation, { scope_token: risk.scope_token, acknowledged_duplicate_risk: true })
    await act(async () => queued.resolve(Response.json(result('running', recovered)))); await settle()
    assert.deepEqual(adopted, [recovered]); assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally { await view.destroy() }
})

test('cancelling the risk choice sends no authorization', async t => {
  dom.window.sessionStorage.clear(); let posts = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return Response.json(result('risk_required')) }
    return Response.json(details)
  })
  const view = await mount(() => assert.fail('cancel cannot queue execution'))
  try { await act(() => button('取消').click()); await settle(); assert.equal(posts, 1); assert.equal(document.querySelector('[role="dialog"]'), null) }
  finally { await view.destroy() }
})

test('unknown transport retains the original action across explicit retry and component remount', async t => {
  dom.window.sessionStorage.clear(); const posts: Record<string, unknown>[] = []; let reads = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); throw new TypeError('连接中断') }
    reads++; return Response.json({ ...details, cas_token: `cas${reads}` })
  })
  for (let index = 0; index < 2; index++) {
    const view = await mount()
    try { assert.match(view.states.at(-1)!.message, /提交结果尚未确认.*同一操作编号/); assert.equal(document.querySelector('[role="dialog"]'), null) }
    finally { await view.destroy() }
  }
  assert.equal(posts.length, 2); assert.deepEqual(posts[1], posts[0])
})

test('CAS conflict refreshes once read-only and stops without another POST or continuing notice', async t => {
  dom.window.sessionStorage.clear(); let reads = 0, posts = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return Response.json({ detail: '分析状态已变化' }, { status: 409 }) }
    reads++; return Response.json(details)
  })
  const view = await mount(() => assert.fail('conflict cannot queue execution'))
  try {
    assert.equal(reads, 2); assert.equal(posts, 1); assert.match(view.states.at(-1)!.message, /已重新读取.*本次恢复已停止/)
    assert.equal(view.states.at(-1)!.state, 'stopped'); assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally { await view.destroy() }
})

test('stale source, analysis, model and active execution stop before POST', async t => {
  dom.window.sessionStorage.clear(); let response = details, posts = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; throw new Error('must not dispatch') }
    return Response.json(response)
  })
  for (const changed of [{ ...details, local_active: true }, { ...details, source_updated_at: 'other' }, { ...details, analysis_id: 'other' }, { ...details, model_id: 'other' }]) {
    response = changed
    const view = await mount()
    try { assert.equal(view.states.at(-1)!.state, 'stopped') } finally { await view.destroy() }
  }
  assert.equal(posts, 0)
})

test('late recovery cannot overwrite another source, model, closed or unmounted controller', async t => {
  for (const change of ['source', 'model', 'close', 'unmount'] as const) {
    dom.window.sessionStorage.clear()
    const pending = deferred<Response>(), adopted: ScriptSourceAnalysis[] = [], refreshed: ScriptSourceAnalysis[] = []
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => init?.method === 'POST' ? pending.promise : Response.json(details))
    const view = await mount(value => adopted.push(value), value => refreshed.push(value))
    try {
      if (change === 'source') await view.render({ ...source, updated_at: 'other', analysis: { ...analysis, id: 'other' } })
      else if (change === 'model') await view.render(source, 'other-model')
      else if (change === 'close') await view.close()
      else await view.destroy()
      await act(async () => pending.resolve(Response.json(result('running', recovered)))); await settle()
      assert.deepEqual(adopted, [], change); assert.deepEqual(refreshed, [], change)
    } finally { if (change !== 'unmount') await view.destroy(); mock.mock.restore() }
  }
})

test('stopped validation cannot be mistaken for resumed or successful analysis', async t => {
  dom.window.sessionStorage.clear(); const refreshed: ScriptSourceAnalysis[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST' ? result('stopped') : details))
  const view = await mount(() => assert.fail('a stopped result cannot resume'), value => refreshed.push(value))
  try { assert.equal(view.states.at(-1)!.state, 'stopped'); assert.match(view.states.at(-1)!.message, /未通过引用检查/); assert.deepEqual(refreshed, [analysis]) }
  finally { await view.destroy() }
})

test('a restored active local workflow only polls GET until its terminal result without claiming model execution', async t => {
  dom.window.sessionStorage.clear(); let reads = 0, posts = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; throw new Error('the existing local worker is still active') }
    reads++
    return Response.json({ ...details, local_active: reads === 1,
      recovery_workflow: { action_id: 'persisted-workflow', client_action_id: 'persisted-action', analysis_id: analysis.id,
        recovery: reads === 1 ? { outcome: 'running', phase: 'local_recovery', message: '正在复用保存回答。', model_requests_started: false } : result('completed').recovery } })
  })
  const view = await mount(() => assert.fail('local polling cannot announce model execution'))
  try {
    assert.equal(posts, 0); assert.equal(view.states.at(-1)!.state, 'working')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) }); await settle()
    assert.equal(reads, 2); assert.equal(posts, 0); assert.equal(view.states.at(-1)!.state, 'completed')
  } finally { await view.destroy() }
})

test('new quality work requires a separate paid confirmation with the exact current scope', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const scope = { analysis_id: 'a1', review_hash: 'a'.repeat(64), findings_hash: 'b'.repeat(64) }, starts: unknown[] = []
  const pending = { ...analysis, quality_summary: { handled: 2, total: 2, modified: 1, retained: 1, uncertain: 0,
    review: 'issues' as const, access: 'blocked' as const, blocking: 2, advisory: 0, section_ids: [], confirmation_required: true as const, confirmation_scope: scope },
    resume: { available: true, action: 'continue' as const, message: '需确认新一轮用量', next: { phase: 'quality_repair' as const, response: 'not_started' as const, model_required: true } } }
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: pending }} starting={false} unavailable={false} pollError={false} onStart={value => starts.push(value)} /></MantineProvider>))
    assert.deepEqual(starts, [])
    await act(() => button('确认新一轮质量处理').click())
    assert.deepEqual(starts, []); assert.match(document.body.textContent!, /产生新的模型用量/)
    await act(() => button('本轮确认范围').click())
    assert.match(document.body.textContent!, new RegExp(scope.review_hash))
    await act(() => { const submit = button('确认并开始新一轮'); submit.click(); submit.click() })
    assert.deepEqual(starts, [{ quality_scope: scope, confirm_new_quality_round: true }])
    await act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: { ...pending,
      resume: { available: false, action: 'reconcile_request', blocked: true, message: '未知请求仍未确认' } } }} starting={false} unavailable={false} pollError={false} onStart={value => starts.push(value)} onResolveRequest={() => {}} /></MantineProvider>))
    assert.equal(button('确认新一轮质量处理'), undefined, 'a round confirmation never takes priority over unknown delivery')
    assert.ok(button('检查并恢复'))
    assert.equal(starts.length, 1)
  } finally { await act(() => root.unmount()); container.remove() }
})



const conciseSummary = { saved_count: 4, pending_items: [{ label: '事件与因果', scope_label: '批次 2', status: 'unknown_response' }], reason: '部分请求未收到完整结果，继续前需确认可能产生的重复费用。' }
const conciseLegacy = { analysis_id: 'a1', cas_token: 'cas1', client_action_id: 'exact-legacy', workflow_id: 'workflow-1', max_model_requests: 2, saved_count: 4,
  pending_items: conciseSummary.pending_items, warning: '可能重复费用' }
const prepared = { ...result('risk_required'), recovery: { outcome: 'risk_required', phase: 'awaiting_risk', message: 'private checkpoint details', model_requests_started: false,
  legacy_resume: conciseLegacy, summary: conciseSummary } }

test('inline preparation defers the concise fee dialog, binds backend count and locks double confirmation', async t => {
  dom.window.sessionStorage.clear()
  const posts: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json(details)
    const path = String(url), body = JSON.parse(String(init.body)); posts.push({ path, body })
    if (path.endsWith('/prepare')) return Response.json(prepared)
    assert.equal(body.workflow_id, conciseLegacy.workflow_id)
    assert.equal(body.acknowledged_duplicate_risk, true)
    return Response.json({ analysis: recovered })
  })
  const view = await mount(undefined, undefined, { inline: true, confirmationOpen: false })
  try {
    assert.equal(posts.length, 1); assert.ok(posts[0]!.path.endsWith('/prepare'))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await view.confirm()
    assert.match(document.querySelector('[aria-label="确认恢复未完成项"]')!.textContent!, /已完成的4项会保留。部分请求未收到完整结果，重新请求可能产生重复费用。/)
    assert.doesNotMatch(document.querySelector('[aria-label="确认恢复未完成项"]')!.textContent!, /checkpoint|cas1|workflow-1/)
    await act(() => { button('继续未完成项').click(); button('继续未完成项').click() }); await settle()
    assert.equal(posts.length, 2, 'only one confirmed resend follows one local preparation')
  } finally { await view.destroy() }
})

test('refresh restores the same prepared choice via GET and never prepares or confirms twice', async t => {
  dom.window.sessionStorage.clear()
  let posts = 0, current: any = details
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json(current)
    posts++; const body = JSON.parse(String(init.body))
    current = { ...details, recovery_workflow: { action_id: 'workflow-1', client_action_id: body.client_action_id, analysis_id: 'a1', recovery: prepared.recovery } }
    return Response.json(prepared)
  })
  const first = await mount(undefined, undefined, { inline: true, confirmationOpen: false }); await first.destroy()
  const second = await mount(undefined, undefined, { inline: true, confirmationOpen: false })
  try {
    assert.equal(posts, 1)
    assert.equal(second.states.at(-1)!.state, 'risk_required')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await second.confirm(); assert.ok(button('暂不继续'))
    await act(() => button('暂不继续').click()); await settle()
    assert.equal(posts, 1)
  } finally { await second.destroy() }
})

test('concurrent completion changes CAS and stops a prepared confirmation without a resend', async t => {
  dom.window.sessionStorage.clear()
  let posts = 0, drifted = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ ...details, ...(drifted ? { cas_token: 'new-cas', local_active: true } : {}) })
    posts++; assert.equal(posts, 1, 'confirmation must stop before a second POST')
    return Response.json(prepared)
  })
  const view = await mount(undefined, undefined, { inline: true, confirmationOpen: false })
  try {
    drifted = true; await view.confirm()
    await act(() => button('继续未完成项').click()); await settle()
    assert.equal(posts, 1)
    assert.equal(view.states.at(-1)!.state, 'stopped')
    assert.match(view.states.at(-1)!.message, /状态已变化/)
  } finally { await view.destroy() }
})
