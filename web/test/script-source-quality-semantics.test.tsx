import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { sourceQualityAccessBlockReason } from '@video-studio/shared/script/script-source-quality-access'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
const { default: ScriptStageActions } = await import('../src/features/script/ScriptStageActions')
after(() => dom.window.close())

function fixture(): ScriptSourceAnalysis {
  return { id: 'saved-analysis', source_version: 'saved-source', model_id: 'model', status: 'paused', phase: 'synthesis', completed_chunks: 2, total_chunks: 2,
    error: '原核对意见仍保留。', updated_at: '2026-11-15T00:00:00Z', sections: [1, 2, 3].map((episode_number, id) => ({
      offset: id * 10, length: 10, title: `第${episode_number}集`, episode_number, summary: `第${episode_number}集已保存。`, characters: [], events: [] })),
    story: { summary: '当前分析保留原文的差异与未知条件。', characters: [], timeline: [], threads: [], ending: { summary: '原文未完。', section_ids: [2] },
      uncertainties: [{ description: '两处原文的关系尚待作者确认，不推测为自洽，也不强制删除。', section_ids: [1] }] },
    quality: { input_hash: 'saved-review', status: 'issues', findings: [{ kind: 'causality', explanation: '待独立核实的原意见。', unit_ids: [1] }] },
    resume: { available: true, action: 'continue', message: '已保存处理记录。', next: { phase: 'quality_review', response: 'not_started', model_required: true } },
    quality_summary: { handled: 4, total: 4, modified: 0, retained: 4, uncertain: 0, review: 'pending', access: 'blocked', blocking: 1, advisory: 0, section_ids: [1], stop_reason: 'no_progress' } }
}
const sourceFor = (analysis: ScriptSourceAnalysis): ScriptSourceDocument => ({ project_id: 'offline', filename: '已保存剧本.txt', content: '已保存原文，不触发真实对话。', updated_at: 'saved', analysis })
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
async function mount(node: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = async (next: React.ReactNode) => { await act(() => root.render(<MantineProvider env="test">{next}</MantineProvider>)) }
  await render(node)
  return { container, render, async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('handled and retained opinions remain visibly distinct from real changes and passing; no-progress cannot start a paid retry', async t => {
  const analysis = fixture(), source = sourceFor(analysis), before = structuredClone(source)
  let starts = 0, requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('offline status must not make requests') })
  const view = await mount(<ScriptSourceAnalysisStatus source={source} starting={false} unavailable pollError={false} onStart={() => { starts++ }} />)
  try {
    const summary = view.container.querySelector('[aria-label="分析意见处理结果"]')!
    assert.match(summary.textContent!, /已处理意见4\/4 项.*实际修改0 项.*保留待复核4 项.*无法确定0 项.*独立核对待核对/s)
    assert.match(summary.textContent!, /不代表已修改或已经通过.*不会自动删除/s)
    assert.match(summary.textContent!, /没有产生实质修改.*停止重复调用模型/s)
    assert.equal(button(view.container, '继续生成未完成项'), undefined)
    assert.equal(button(view.container, '继续未完成步骤'), undefined)
    const inspect = button(view.container, '查看待复核事项')!
    assert.ok(inspect); assert.equal(inspect.disabled, false)
    await act(() => inspect.click())
    assert.equal(button(view.container, '技术详情')!.getAttribute('aria-expanded'), 'true')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(starts, 0); assert.equal(requests, 0)
    assert.equal(view.container.querySelector('.sd-analysis-ready'), null)
    assert.deepEqual(source, before)
  } finally { await view.destroy() }
})

test('an uncertain decision stays unresolved while an explicitly saved answer may still be checked locally', async t => {
  const analysis = fixture(); analysis.quality_summary = { ...analysis.quality_summary!, retained: 3, uncertain: 1, stop_reason: 'uncertain' }
  analysis.resume = { available: true, action: 'revalidate', message: '可本地校验。', next: { phase: 'quality_review', response: 'saved_response', model_required: false } }
  let starts = 0, checks = 0
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('local status callback must not request a model') })
  const view = await mount(<ScriptSourceAnalysisStatus source={sourceFor(analysis)} starting={false} unavailable pollError={false}
    onStart={() => { starts++ }} onRevalidate={() => { checks++ }} />)
  try {
    assert.match(view.container.textContent!, /无法确定1 项/)
    assert.match(view.container.textContent!, /部分意见目前无法确定/)
    assert.equal(button(view.container, '重新校验保存回答')!.disabled, false)
    await act(() => button(view.container, '重新校验保存回答')!.click())
    assert.equal(checks, 1); assert.equal(starts, 0)
    assert.equal(analysis.quality!.status, 'issues'); assert.equal(analysis.story!.uncertainties.length, 1)
  } finally { await view.destroy() }
})

test('ordinary hints permit continued creation without saying retained issues have passed', async () => {
  const analysis = fixture(); analysis.status = 'ready'
  analysis.quality_summary = { ...analysis.quality_summary!, review: 'issues', access: 'usable', blocking: 0, advisory: 1, stop_reason: undefined }
  const view = await mount(<ScriptSourceAnalysisStatus source={sourceFor(analysis)} starting={false} unavailable={false} pollError={false} onStart={() => assert.fail('no automatic analysis')} />)
  try {
    assert.match(view.container.textContent!, /可继续创作.*普通提示仍保留/s)
    assert.match(view.container.textContent!, /独立核对仍有核对事项/)
    assert.doesNotMatch(view.container.querySelector('[aria-label="执行信息"]')!.textContent!, /确认后调用模型并产生用量|质量核对 · 已完成/)
    assert.equal(sourceQualityAccessBlockReason(analysis), undefined)
    assert.equal(analysis.quality!.status, 'issues'); assert.equal(analysis.story!.uncertainties.length, 1)
  } finally { await view.destroy() }
})

test('creation access uses the verified current review and complete episode mapping rather than retained counts or analysis status alone', async t => {
  const analysis = fixture(); analysis.status = 'ready'
  analysis.quality_summary = { ...analysis.quality_summary!, review: 'issues', access: 'scoped', blocking: 0, stop_reason: undefined }
  assert.equal(sourceQualityAccessBlockReason(analysis, { stage: 'episode', episode_number: 1 }), undefined)
  assert.match(sourceQualityAccessBlockReason(analysis, { stage: 'episode', episode_number: 2 })!, /第 2 集存在影响本步骤的待核对信息/)
  assert.match(sourceQualityAccessBlockReason(analysis, { stage: 'outline' })!, /涉及全剧或依赖范围尚不明确/)
  assert.match(sourceQualityAccessBlockReason(analysis)!, /依赖范围尚不明确/)
  const cases: Array<{ label: string; change: (value: ScriptSourceAnalysis) => void; scope?: { stage: 'episode'; episode_number: number } }> = [
    { label: 'running cannot claim usable', change: value => { value.status = 'running'; value.quality_summary!.access = 'usable'; value.quality_summary!.blocking = 0 } },
    { label: 'pending independent review', change: value => { value.quality_summary!.review = 'pending'; value.quality_summary!.access = 'usable'; value.quality_summary!.blocking = 0 } },
    { label: 'legacy issues lack classification', change: value => { delete value.quality_summary } },
    { label: 'invalid section', change: value => { value.quality_summary!.section_ids = [999] } },
    { label: 'duplicate sections', change: value => { value.quality_summary!.section_ids = [1, 1] } },
    { label: 'unknown affected episode', change: value => { value.sections[1]!.episode_number = null } },
    { label: 'empty affected scope', change: value => { value.quality_summary!.section_ids = [] } },
    { label: 'unmapped target episode', change: () => {}, scope: { stage: 'episode', episode_number: 8 } },
    { label: 'usable still has a blocker', change: value => { value.quality_summary!.access = 'usable'; value.quality_summary!.blocking = 1 } },
  ]
  for (const entry of cases) await t.test(entry.label, () => {
    const value = structuredClone(analysis); entry.change(value)
    assert.ok(sourceQualityAccessBlockReason(value, entry.scope || { stage: 'episode', episode_number: 1 }))
  })
  const legacy = structuredClone(analysis); delete legacy.quality_summary; legacy.quality!.status = 'passed'
  assert.equal(sourceQualityAccessBlockReason(legacy), undefined, 'legacy genuinely passed reviews retain compatibility')
})

test('episode menus block only affected episodes and keep global stages blocked with an explanation', async () => {
  const analysis = fixture(); analysis.status = 'ready'
  analysis.quality_summary = { ...analysis.quality_summary!, review: 'issues', access: 'scoped', blocking: 0, stop_reason: undefined }
  const actions: unknown[] = []
  const view = await mount(<ScriptStageActions script={{ outline: '概要', characters: '人物', artifacts: [
    { artifact_type: 'locations', content: '地点', status: 'saved' }, { artifact_type: 'props', content: '道具', status: 'saved' },
  ], scenes: [{ episode_number: 1 }, { episode_number: 2 }] }} disabled={false}
    analysisWait={scope => sourceQualityAccessBlockReason(analysis, scope) || ''} onAction={value => actions.push(value)} />)
  try {
    const global = view.container.querySelector<HTMLButtonElement>('[aria-label="处理已保存的故事大纲"]')!
    assert.equal(global.disabled, true); assert.match(global.title, /涉及全剧/)
    const episodes = view.container.querySelector<HTMLButtonElement>('[aria-label="处理已保存的分集剧本"]')!
    assert.equal(episodes.disabled, false)
    await act(() => episodes.click())
    const blocked = button(document, '修改第 2 集正文')!, allowed = button(document, '修改第 1 集正文')!
    assert.equal(blocked.disabled, true); assert.match(blocked.title, /第 2 集存在影响本步骤/)
    assert.equal(allowed.disabled, false)
    await act(() => blocked.click()); assert.equal(actions.length, 0)
    await act(() => allowed.click()); assert.deepEqual(actions, [{ stage: 'episode', episode_number: 1, operation: 'revise' }])
  } finally { await view.destroy() }
})
