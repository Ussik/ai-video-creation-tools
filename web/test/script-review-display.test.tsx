import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ScriptDraftResolution, ScriptDraftResolutionInput } from '@video-studio/shared/script/script-draft-resolution'
import type { ScriptActivity, ScriptExecution } from '@video-studio/shared/script/script-activity-types'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import type { DocumentReview } from '@video-studio/shared/script/script-review-types'

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
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: DirectorDraftResolution } = await import('../src/features/script/DirectorDraftResolution')
const { default: DirectorMessageFailure } = await import('../src/features/script/DirectorMessageFailure')
const { default: DirectorActivity } = await import('../src/features/script/DirectorActivity')
const { ScriptSourceAnalysisStatus, ScriptSourcePreview } = await import('../src/features/script/ScriptSourceAnalysisView')
const { default: DirectorReviewReport } = await import('../src/features/script/DirectorReviewReport')
after(() => dom.window.close())

async function mount(node: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (next: React.ReactNode) => { await act(() => root.render(<MantineProvider env="test">{next}</MantineProvider>)) }
  await update(node)
  return { container, update, async destroy() { await act(() => root.unmount()); container.remove() } }
}

function button(scope: ParentNode, label: string) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(node, label)
  return node
}

const quote = '他说：“world 不是 constraints。”'
const relatedQuote = 'synopsis 是原文里的文件名。'
function savedResolution(): ScriptDraftResolution {
  return { id: 'saved-world-candidate', version: 'exact-version-7', stage: 'outline', episode_number: 0, document_count: 9,
    findings: [{ source_key: 'world', topic: 'world 的规则身份', issue_id: 'unchanged-issue-id', kind: 'contradiction', quote,
      explanation: `episode_outline 与 world 不一致。原文：${quote}`,
      suggestion: `同步 constraints 和 foreshadowing，保留原文：${quote}`,
      previous_answer: '我决定保留 world 和 constraints 这两个原文词。',
      related_findings: [{ source_key: 'synopsis', quote: relatedQuote,
        explanation: `synopsis 与 episode_outline 冲突。原文：${relatedQuote}`, suggestion: '核对 synopsis。' }] }] }
}
const failureReason = '修订稿分析未完成，尚未开始阶段设定核对：模型结果不符合 script_source_story_characters 契约（已修正一次）：人物任务「characters:2」中「杜铮」的别名没有原文证据。'
const rawIdentifiers = /script_source_story_characters|characters:2/

test('saved findings display Chinese document names while exact quotes, identity and manual answers remain unchanged', async () => {
  const resolution = savedResolution(), before = structuredClone(resolution), submitted: ScriptDraftResolutionInput[] = []
  const view = await mount(<DirectorDraftResolution resolution={resolution} opened busy={false} onClose={() => {}} onOpen={() => {}}
    onResolve={input => submitted.push(input)} onDiscard={() => assert.fail('must preserve candidate')} />)
  try {
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.equal(dialog.querySelector('.sd-draft-resolution-quote')!.textContent, quote)
    assert.match(dialog.textContent!, /分集大纲/)
    assert.match(dialog.textContent!, /背景设定/)
    assert.match(dialog.textContent!, /伏笔与回收/)
    assert.ok(dialog.textContent!.includes(relatedQuote), 'quoted English in related evidence is preserved')
    const field = dialog.querySelector('textarea')!
    assert.equal(field.value, resolution.findings[0]!.previous_answer)
    const answer = '按我的 world 方案处理，保留 constraints 原文。'
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, answer)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(() => button(dialog, '按填写内容补齐').click())
    assert.deepEqual(submitted, [{ id: resolution.id, version: resolution.version, strategy: 'manual', answers: [answer] }])
    assert.deepEqual(resolution, before, 'display formatting never mutates saved finding keys, topics, evidence or answers')
  } finally { await view.destroy() }
})

test('continuing a saved plan translates its status without changing its authorization or previous answer', async () => {
  const resolution = { ...savedResolution(), completed_rounds: 12, run: { strategy: 'manual' as const, status: 'interrupted' as const,
    completed_rounds: 12, completed: 5, total: 5, message: failureReason } }
  const before = structuredClone(resolution), submitted: ScriptDraftResolutionInput[] = []
  const view = await mount(<DirectorDraftResolution resolution={resolution} opened busy={false} onClose={() => {}} onOpen={() => {}}
    onResolve={input => submitted.push(input)} onDiscard={() => assert.fail('must preserve candidate')} />)
  try {
    assert.doesNotMatch(view.container.querySelector('[role="status"]')!.textContent!, rawIdentifiers)
    assert.ok(document.querySelector('[role="dialog"]')!.textContent!.includes(resolution.findings[0]!.previous_answer!))
    const resume = button(document.querySelector('[role="dialog"]')!, '沿用方案继续')
    assert.equal(resume.disabled, false, 'historical rounds must never disable continuing the authorized plan')
    await act(() => resume.click())
    assert.deepEqual(submitted, [{ id: resolution.id, version: resolution.version, strategy: 'continue' }])
    assert.deepEqual(resolution, before)
  } finally { await view.destroy() }
})

test('historical failures, activity summaries and source status are readable while raw call records remain intact', async () => {
  const activity: ScriptActivity[] = [
    { id: 'task', kind: 'context', scope: 'task', label: '补齐候选草稿', summary: failureReason, status: 'failed', started_at: 1 },
    { id: 'step', parent_id: 'task', kind: 'context', scope: 'step', label: '分析修订稿', summary: failureReason, status: 'failed', started_at: 2 },
    { id: 'call', parent_id: 'step', kind: 'model', scope: 'step', name: 'script_source_story_characters', step_id: 'characters:2',
      label: '整理人物与身份', summary: failureReason, status: 'failed', started_at: 3, input: '{"task":"characters:2"}', output: failureReason },
    { id: 'notice', kind: 'context', scope: 'notice', label: '处理提示', summary: failureReason, status: 'succeeded', started_at: 4 },
  ]
  const execution: ScriptExecution = { title: '补齐候选草稿', request: '沿用 world 方案', started_at: 1, outcome: { kind: 'failed', summary: failureReason } }
  const source: ScriptSourceDocument = { project_id: 'display-source', filename: 'all.txt', content: 'world constraints 是剧本原文。', updated_at: '2026-10-21',
    analysis: { id: 'analysis', model_id: 'model', source_version: 'version', status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
      sections: [], error: failureReason, updated_at: '2026-10-21', progress: { stage: 'synthesis', message: failureReason },
      resume: { available: true, message: '已保留 characters:2 分析结果，可继续。' } } }
  const before = structuredClone({ activity, execution, source })
  const view = await mount(<><DirectorMessageFailure detail={failureReason} processing_duration_ms={61000} />
    <DirectorActivity activity={activity} execution={execution} failed />
    <ScriptSourceAnalysisStatus source={source} starting={false} unavailable={false} pollError={false} onStart={() => {}} />
    <ScriptSourcePreview source={source} /></>)
  try {
    assert.doesNotMatch(view.container.querySelector('.sd-message-failure')!.textContent!, rawIdentifiers)
    assert.match(view.container.querySelector('.sd-message-failure')!.textContent!, /杜铮/)
    assert.match(view.container.querySelector('.sd-message-failure')!.textContent!, /用时 1 分 1 秒/)
    assert.doesNotMatch(view.container.querySelector('.sd-activity-result')!.textContent!, rawIdentifiers)
    assert.doesNotMatch(view.container.querySelector('.sd-activity-task')!.getAttribute('title')!, rawIdentifiers)
    assert.doesNotMatch(view.container.querySelector('.sd-source-analysis')!.textContent!, rawIdentifiers)
    assert.match(view.container.querySelector('.sd-source-analysis')!.textContent!, /剧情目录已完成；全剧整合与质量核对仍以各步骤状态为准/)
    assert.equal(view.container.querySelector('.sd-source-preview-body')!.textContent, source.content)
    await act(() => button(view.container, '查看执行步骤').click())
    const summaries = [...view.container.querySelectorAll('.sd-activity-summary, .sd-activity-notice-list p')]
    assert.ok(summaries.length >= 3)
    for (const node of summaries) assert.doesNotMatch(node.textContent!, rawIdentifiers)
    assert.ok([...view.container.querySelectorAll('code')].some(node => node.textContent === 'characters:2'), 'technical step IDs remain available in call details')
    assert.ok([...view.container.querySelectorAll('.sd-activity-payload pre')].some(node => node.textContent === failureReason), 'raw returned diagnostic is retained verbatim')
    assert.ok([...view.container.querySelectorAll('.sd-activity-payload pre')].some(node => node.textContent === '{"task":"characters:2"}'))
    assert.deepEqual({ activity, execution, source }, before)
  } finally { await view.destroy() }
})

test('professional review explanations translate document references and preserve quoted original text', async () => {
  const review: DocumentReview = { id: 'review', summary: 'world 和 episode_outline 存在冲突。', documents: [{ id: 'doc', version: 'v2' }],
    findings: [{ document_id: 'doc', document_version: 'v2', category: 'consistency', severity: 'warning', quote,
      explanation: `world 与 synopsis 不一致。原文：${quote}`, suggestion: `同步 constraints，保留：${quote}`, related: [] }], created_at: '2026-10-21' }
  const before = structuredClone(review)
  const view = await mount(<DirectorReviewReport review={review} />)
  try {
    assert.equal(view.container.querySelector('blockquote')!.textContent, quote)
    assert.match(view.container.textContent!, /背景设定/)
    assert.match(view.container.textContent!, /分集大纲/)
    assert.deepEqual(review, before)
  } finally { await view.destroy() }
})
