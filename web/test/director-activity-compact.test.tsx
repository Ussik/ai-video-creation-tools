import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ScriptActivity, ScriptExecution } from '../src/features/script/director-activity'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const { default: DirectorActivity } = await import('../src/features/script/DirectorActivity')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const task: ScriptActivity = { id: 'outline-task', kind: 'context', scope: 'task', status: 'succeeded', label: '编写概要设计', summary: '已保留概要草稿，等待创作者确认', started_at: Date.now() - 1000, duration_ms: 1000 }
const execution: ScriptExecution = { title: '整理故事大纲', request: '只做概要设计', started_at: task.started_at, outcome: { kind: 'draft', summary: task.summary, draft_id: 'outline-draft' } }

async function mount(props: React.ComponentProps<typeof DirectorActivity>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (next = props) => act(() => root.render(<MantineProvider env="test"><DirectorActivity {...next} /></MantineProvider>))
  await render()
  return { container, render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('completed compact activity folds process details and lets the creator reopen them', async () => {
  const props = { activity: [task], execution, compact: true, onOpenDraft() {} }
  const view = await mount(props)
  try {
    const summary = view.container.querySelector<HTMLButtonElement>('.sd-activity-compact-summary')!
    assert.ok(summary)
    assert.match(summary.textContent!, /草稿待确认.*整理故事大纲.*查看过程/)
    assert.equal(summary.getAttribute('aria-expanded'), 'false')
    const details = document.getElementById(summary.getAttribute('aria-controls')!)!
    assert.equal(details.hidden, true)
    await act(() => summary.click())
    assert.equal(summary.getAttribute('aria-expanded'), 'true')
    assert.equal(details.hidden, false)
    assert.match(details.textContent!, /编写概要设计.*查看并编辑草稿/s)
    await act(() => summary.click())
    assert.equal(details.hidden, true)
    await view.render({ ...props, compact: false })
    assert.equal(view.container.querySelector('.sd-activity-compact-summary'), null)
    assert.equal(view.container.querySelector<HTMLElement>('.sd-activity-details')!.hidden, false)
  } finally { await view.destroy() }
})

test('running, partial and interrupted activities retain visible progress and recovery actions', async () => {
  let recovered = 0
  const props = { activity: [task], execution, compact: true, suppressDraftAction: true, onRecover() { recovered++ } }
  const view = await mount({ ...props, pending: true, activity: [{ ...task, status: 'running' }], onStop() {} })
  try {
    assert.equal(view.container.querySelector('.sd-activity-compact-summary'), null)
    assert.ok(view.container.querySelector('.sd-activity-current'))
    assert.match(view.container.textContent!, /停止任务/)
    for (const kind of ['partial', 'failed', 'cancelled'] as const) {
      await view.render({ ...props, execution: { ...execution, outcome: { kind, summary: '已有成果需要检查' } } })
      assert.equal(view.container.querySelector('.sd-activity-compact-summary'), null, kind)
      const recovery = [...view.container.querySelectorAll<HTMLButtonElement>('.sd-activity-actions button')].find(button => button.textContent === '检查草稿与保存结果')
      assert.ok(recovery, `${kind} keeps recovery available`)
      await act(() => recovery.click())
    }
    assert.equal(recovered, 3)
  } finally { await view.destroy() }
})

test('a unified result entry can suppress duplicate draft actions without suppressing partial recovery', async () => {
  const props = { activity: [task], execution, compact: true, suppressDraftAction: true, onOpenDraft() {}, onRecover() {} }
  const view = await mount(props)
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('.sd-activity-compact-summary')!.click())
    assert.equal(view.container.querySelector('.sd-activity-action-primary'), null)
    assert.equal(view.container.querySelector('.sd-activity-actions button'), null)
    await view.render({ ...props, execution: { ...execution, outcome: { kind: 'partial', summary: '尚有部分内容未完成' } } })
    assert.ok(view.container.querySelector('.sd-activity-action-primary'), 'partial results retain the draft recovery entry')
  } finally { await view.destroy() }
})

test('an external stop control suppresses only the duplicate button while progress and long waits stay visible', async () => {
  let stopped = 0
  const running: ScriptActivity = { ...task, kind: 'model', status: 'running', label: '正在编写故事大纲', summary: '正在整理故事主线', started_at: Date.now() - 60_000 }
  const props = { activity: [running], execution, pending: true, compact: true, onStop() { stopped++ } }
  const view = await mount({ ...props, suppressStopAction: true })
  try {
    const progress = view.container.querySelector<HTMLElement>('.sd-activity-current')!
    assert.ok(progress)
    assert.match(progress.textContent!, /正在编写故事大纲.*正在整理故事主线/)
    assert.ok(progress.querySelector('time'), 'elapsed progress remains available')
    assert.match(view.container.querySelector('.sd-activity-wait')!.textContent!, /当前步骤仍在处理中，已等待/)
    assert.equal(view.container.querySelector('.sd-activity-stop'), null)
    assert.doesNotMatch(view.container.textContent!, /停止任务/)

    await view.render({ ...props, suppressStopAction: true, activity: [{ ...running, started_at: Date.now() }] })
    assert.ok(view.container.querySelector('.sd-activity-current'))
    assert.equal(view.container.querySelector('.sd-activity-wait'), null, 'a short task does not leave an empty action row')

    await view.render(props)
    const stop = view.container.querySelector<HTMLButtonElement>('.sd-activity-stop')!
    assert.ok(stop, 'standalone activity retains its stop control by default')
    assert.match(view.container.querySelector('.sd-activity-wait')!.textContent!, /已等待/)
    await act(() => stop.click())
    assert.equal(stopped, 1)
  } finally { await view.destroy() }
})

test('completed tasks distinguish real work from restored results with original or missing durations', async () => {
  const activity: ScriptActivity[] = [
    { ...task, id: 'fresh', duration_ms: 12_345 },
    { ...task, id: 'restored', reused: true, duration_ms: 82_400 },
    { ...task, id: 'imported', reused: true, duration_ms: undefined, ended_at: task.started_at + 1 },
    { ...task, id: 'legacy', reused: true, duration_ms: 0 },
  ]
  const view = await mount({ activity, execution })
  try {
    const fresh = view.container.querySelector('[data-activity-id="fresh"]')!
    assert.match(fresh.textContent!, /已完成12.3 秒/)
    const restored = view.container.querySelector('[data-activity-id="restored"]')!
    assert.match(restored.textContent!, /已复用1 分 22 秒/)
    assert.equal(restored.querySelector('time')!.title, '此前生成用时')
    for (const id of ['imported', 'legacy']) {
      const row = view.container.querySelector(`[data-activity-id="${id}"]`)!
      assert.match(row.textContent!, /已复用/)
      assert.equal(row.querySelector('time'), null)
    }
    assert.doesNotMatch(view.container.textContent!, /0\.0 秒/)
  } finally { await view.destroy() }
})

test('recovered truncations use a neutral status while keeping raw diagnostics and token usage in call details', async () => {
  const step: ScriptActivity = { ...task, id: 'draft-step', scope: 'step', parent_id: task.id, label: '编写外观与辨识' }
  const truncated: ScriptActivity = { id: 'truncated-call', kind: 'model', parent_id: step.id, name: 'model_request', status: 'failed', label: '模型编写完整阶段草稿', summary: '模型输出达到上限，原始记录保留', started_at: task.started_at, duration_ms: 800,
    output_limit_reason: 'max_output_tokens', reserved_output_tokens: 128000, response_chars: 9901, output_tokens: 8188 }
  const continuation: ScriptActivity = { ...truncated, id: 'continued-call', status: 'succeeded', summary: '已返回接续内容', output_limit_reason: undefined, started_at: task.started_at + 800, duration_ms: 200 }
  const activity = [task, step, truncated, continuation]
  const original = structuredClone(activity)
  const view = await mount({ activity, execution })
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('.sd-activity-toggle')!.click())
    const call = view.container.querySelector('[data-activity-id="truncated-call"]')!
    assert.match(call.textContent!, /已截断，已继续处理/)
    assert.ok(call.querySelector('.sd-activity-icon.is-continued'))
    assert.equal(call.querySelector('.sd-activity-icon.is-failed'), null)
    assert.match(call.textContent!, /模型输出达到上限，原始记录保留/)
    assert.match(call.textContent!, /max_output_tokens/)
    assert.match(call.textContent!, /未显式设置，由上游决定/)
    assert.match(call.textContent!, /128,000 tokens（仅用于估算）/)
    assert.match(call.textContent!, /8,188 tokens/)
    assert.match(view.container.querySelector('.sd-activity-stats')!.textContent!, /1 条截断记录已继续处理/)
    assert.doesNotMatch(view.container.querySelector('.sd-activity-stats')!.textContent!, /失败记录/)
    assert.deepEqual(activity, original)

    await view.render({ activity, execution: { ...execution, outcome: { kind: 'failed', summary: '最终任务未完成' } } })
    const failed = view.container.querySelector('[data-activity-id="truncated-call"]')!
    assert.match(failed.querySelector('.sd-activity-status')!.textContent!, /未完成/)
    assert.ok(failed.querySelector('.sd-activity-icon.is-failed'))
  } finally { await view.destroy() }
})
