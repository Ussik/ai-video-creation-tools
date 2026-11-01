import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset, Job, Model, ProjectDetail, Provider } from '../src/shared/api/api'
import { chooseCombobox } from './component-controls'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: TaskRecords } = await import('../src/features/jobs/TaskRecords')
after(() => dom.window.close())

const timestamp = '2026-10-11T10:00:00Z'
const models = [{ id: 'image', name: '图片模型', modality: 'image', provider_id: 'provider' },
  { id: 'video', name: '视频模型', modality: 'video', provider_id: 'provider' }] as Model[]
const providers = [{ id: 'provider', name: '测试服务商' }] as Provider[]
const result = { id: 'result', project_id: 'project', kind: 'image', filename: '雨夜.png', source: 'generated', url: '/image.png', created_at: timestamp } as Asset
function job(id: string, status: Job['status'], extras: Partial<Job> = {}): Job {
  return { id, project_id: 'project', shot_id: 'shot', model_id: 'image', job_type: 'generation', request: '{}', status,
    external_id: null, result_asset_id: null, recovery_available: false, error: null, created_at: timestamp, ...extras }
}
const detail = { id: 'project', name: '夜班列车', jobs: [
  job('queued', 'queued'), job('ready', 'succeeded', { result_asset_id: 'result' }),
  job('recover', 'failed', { recovery_available: true, error: '下载失败' }),
  job('resume', 'failed', { task_resume_available: true, external_id: 'remote-existing' }),
  job('unsafe', 'failed', { error: '生成服务连接中断' }),
  job('speech', 'failed', { model_id: null, request: JSON.stringify({ tts: { speaker: 'voice' }, voice_name: '林晚' }) }),
  job('video-failed', 'failed', { model_id: 'video' }),
  job('archived', 'succeeded', { model_id: 'removed-model', request: 'broken json', result_asset_id: 'result' }),
], shots: [{ id: 'shot', title: '雨夜站台' }], assets: [result] } as ProjectDetail

async function mount(data = detail, onRefresh: () => Promise<unknown> = async () => {}) {
  const events: Array<{ type: string; id?: string }> = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><TaskRecords detail={data} models={models} providers={providers} busy={false}
    onRefresh={onRefresh} onPreview={asset => events.push({ type: 'preview', id: asset.id })}
    onOpenCanvas={id => events.push({ type: 'canvas', id })} onOpenSpeech={() => events.push({ type: 'speech' })}
    onRetry={task => events.push({ type: 'retry', id: task.id })}
    onPromptOptimized={task => { events.push({ type: 'optimized', id: task.id }) }} /></MantineProvider>))
  return { container, events, async close() { await act(() => root.unmount()); container.remove() } }
}
function button(container: Element, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(found, `button ${label}`); return found
}
async function tab(container: Element, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent?.startsWith(label))
  assert.ok(found); await act(() => found.click())
}
async function search(container: Element, value: string) {
  const field = container.querySelector<HTMLInputElement>('input[aria-label="搜索任务"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('status, task type and search compose; clearing filters restores tasks including archived-model results', async () => {
  const view = await mount()
  try {
    assert.equal(view.container.querySelectorAll('tbody tr').length, 8)
    await tab(view.container, '进行中')
    assert.equal(view.container.querySelectorAll('tbody tr').length, 1)
    assert.match(view.container.querySelector('tbody')!.textContent!, /排队中/)
    await tab(view.container, '失败')
    assert.equal(view.container.querySelectorAll('tbody tr').length, 5)
    await chooseCombobox(view.container.querySelector<HTMLInputElement>('input[aria-label="任务类型"]')!, '配音生成')
    assert.equal(view.container.querySelectorAll('tbody tr').length, 1)
    await search(view.container, ' 林晚 ')
    assert.match(view.container.querySelector('tbody')!.textContent!, /林晚/)
    await search(view.container, '不存在')
    assert.equal(view.container.querySelector('table'), null)
    assert.match(view.container.textContent!, /没有符合条件的任务/)
    await act(() => button(view.container, '清除筛选').click())
    assert.equal(view.container.querySelectorAll('tbody tr').length, 8)
    await search(view.container, 'archived')
    assert.match(view.container.querySelector('tbody')!.textContent!, /图片生成/)
    assert.deepEqual(view.events, [])
  } finally { await view.close() }
})

test('failed tasks keep download recovery and query continuation separate from paid regeneration', async () => {
  const view = await mount()
  try {
    for (const label of ['恢复下载', '继续查询', '回到画布', '返回配音']) await act(() => button(view.container, label).click())
    assert.deepEqual(view.events, [
      { type: 'retry', id: 'recover' }, { type: 'retry', id: 'resume' }, { type: 'canvas', id: 'shot' },
      { type: 'speech' },
    ])
    assert.match(view.container.textContent!, /核对提供商任务记录与账单/)
    assert.equal([...view.container.querySelectorAll('button')].some(node => node.textContent === '重试'), false)
  } finally { await view.close() }
})

test('result action opens existing image, video, audio and text assets without navigation or a new task', async () => {
  for (const kind of ['image', 'video', 'audio', 'text'] as const) {
    const asset = { ...result, kind }
    const view = await mount({ ...detail, jobs: [job('done', 'succeeded', { result_asset_id: asset.id })], assets: [asset] })
    try {
      const preview = button(view.container, '查看结果')
      assert.equal(preview.tagName, 'BUTTON')
      await act(() => preview.click())
      assert.deepEqual(view.events, [{ type: 'preview', id: 'result' }])
    } finally { await view.close() }
  }
})

test('empty history hides table and filters and offers direct canvas navigation', async () => {
  const view = await mount({ ...detail, jobs: [] })
  try {
    assert.equal(view.container.querySelector('table'), null)
    assert.equal(view.container.querySelector('[aria-label="搜索任务"]'), null)
    assert.match(view.container.textContent!, /还没有任务记录/)
    await act(() => button(view.container, '进入画布').click())
    assert.deepEqual(view.events, [{ type: 'canvas', id: undefined }])
  } finally { await view.close() }
})

test('manual refresh guards duplicate clicks, reports failure inline and allows another attempt', async () => {
  let reject!: (error: Error) => void, calls = 0
  const view = await mount(detail, async () => { calls++; if (calls === 1) return new Promise((_, fail) => { reject = fail }) })
  try {
    const refresh = button(view.container, '刷新')
    await act(() => { refresh.click(); refresh.click() })
    assert.equal(calls, 1)
    assert.equal(refresh.disabled, true)
    await act(async () => reject(new Error('服务暂不可用')))
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /服务暂不可用/)
    assert.equal(refresh.disabled, false)
    await act(async () => refresh.click())
    assert.equal(calls, 2)
    assert.equal(view.container.querySelector('[role="alert"]'), null)
  } finally { await view.close() }
})

test('only content-policy image failures offer optimization and never show continuation for a terminal refusal', async () => {
  const policy = job('policy', 'failed', { request: '{"prompt":"原始画面描述"}', error: 'content_policy_violation', task_resume_available: true })
  const view = await mount({ ...detail, jobs: [policy, ...detail.jobs] })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('No automatic requests allowed') }
  try {
    assert.equal([...view.container.querySelectorAll('button')].filter(node => node.textContent === '优化提示词').length, 1)
    const row = [...view.container.querySelectorAll('tbody tr')].find(row => row.textContent?.includes('content_policy_violation'))!
    assert.doesNotMatch(row.textContent!, /继续查询/)
    await act(() => button(view.container, '优化提示词').click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /优化提示词/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="优化前的提示词"]')!.value, '原始画面描述')
    assert.equal(calls, 0); assert.deepEqual(view.events, [])
  } finally { globalThis.fetch = originalFetch; await view.close() }
})

test('uncertain restarted video tasks show verification and read-only original request details without retrying', async t => {
  const task = job('video-unknown', 'failed', { model_id: 'video', recovery_action: 'verify', recovery_modality: 'video',
    request: '{"prompt":"不可覆盖的原提示词","duration":8}', error: '服务重启，生成提交状态待核对' })
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (path: unknown, init?: RequestInit) => {
    requests.push({ path: String(path), method: init?.method || 'GET' })
    return Response.json({ concurrency: 3, max_concurrency: 10, running: 0, queued: 0 })
  })
  const view = await mount({ ...detail, jobs: [task] })
  try {
    const row = view.container.querySelector('tbody tr')!
    assert.match(row.textContent!, /视频生成/); assert.match(row.querySelector('.job-status')!.textContent!, /待核对/)
    assert.match(row.textContent!, /可能已被接收或计费/)
    assert.doesNotMatch(row.textContent!, /重试|继续查询|恢复下载|优化提示词/)
    await act(() => row.querySelector<HTMLButtonElement>('[aria-label="查看任务信息"]')!.click())
    const dialog = document.querySelector('[role="dialog"][aria-label="任务详情"]')!
    assert.match(dialog.textContent!, /待核对/); assert.match(dialog.textContent!, /不可覆盖的原提示词/)
    assert.equal(dialog.querySelector('textarea, input[contenteditable], [contenteditable="true"]'), null)
    assert.ok(requests.every(request => request.method === 'GET'))
    assert.deepEqual(view.events, [])
  } finally { await view.close() }
})

test('video query continuation uses the existing job and exposes no prompt editing', async () => {
  const task = job('video-query', 'failed', { model_id: 'video', external_id: 'vendor-task-existing',
    recovery_action: 'query', recovery_modality: 'video', task_resume_available: true,
    request: '{"prompt":"原提示词","reference_asset_ids":["fixed"]}' })
  const before = JSON.stringify(task), view = await mount({ ...detail, jobs: [task] })
  try {
    assert.match(view.container.querySelector('tbody')!.textContent!, /沿用原提示词和参数，不创建新的生成任务/)
    assert.doesNotMatch(view.container.querySelector('tbody')!.textContent!, /恢复下载|优化提示词|重试/)
    await act(() => button(view.container, '继续查询').click())
    assert.deepEqual(view.events, [{ type: 'retry', id: task.id }])
    assert.equal(JSON.stringify(task), before)
    assert.equal(view.container.querySelector('textarea'), null)
  } finally { await view.close() }
})

test('video download checkpoints retain their video identity when the model is removed or edited', async () => {
  for (const model_id of ['missing-model', 'image']) {
    const task = job('video-checkpoint', 'failed', { model_id, recovery_action: 'download', recovery_modality: 'video',
      recovery_available: true, task_resume_available: true, error: '下载失败' })
    const view = await mount({ ...detail, jobs: [task] })
    try {
      assert.match(view.container.querySelector('tbody')!.textContent!, /视频生成/)
      assert.doesNotMatch(view.container.querySelector('tbody')!.textContent!, /图片生成|继续查询|重试|优化提示词/)
      await chooseCombobox(view.container.querySelector<HTMLInputElement>('input[aria-label="任务类型"]')!, '视频生成')
      assert.equal(view.container.querySelectorAll('tbody tr').length, 1)
      await act(() => button(view.container, '恢复下载').click())
      assert.deepEqual(view.events, [{ type: 'retry', id: task.id }])
      await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="查看任务信息"]')!.click())
      const dialog = document.querySelector('[role="dialog"][aria-label="任务详情"]')!
      assert.match(dialog.textContent!, /视频生成/); assert.match(dialog.textContent!, /继续下载已有结果/)
    } finally { await view.close() }
  }
})

test('legacy video recovery flags do not classify the task as an image or expose generic retry', async () => {
  for (const flags of [{ recovery_available: true }, { task_resume_available: true, external_id: 'legacy-video-id' }]) {
    const task = job('legacy-video', 'failed', { model_id: 'video', ...flags })
    const view = await mount({ ...detail, jobs: [task] })
    try {
      assert.match(view.container.querySelector('tbody')!.textContent!, /视频生成/)
      assert.doesNotMatch(view.container.querySelector('tbody')!.textContent!, /图片生成|重试/)
      await act(() => button(view.container, flags.recovery_available ? '恢复下载' : '继续查询').click())
      assert.deepEqual(view.events, [{ type: 'retry', id: task.id }])
    } finally { await view.close() }
  }
})

test('explicit unavailable video recovery never falls back to paid retry despite stale legacy flags', async () => {
  const view = await mount({ ...detail, jobs: [job('blocked', 'failed', { model_id: 'video', recovery_action: null,
    recovery_available: true, task_resume_available: true })] })
  try {
    assert.doesNotMatch(view.container.querySelector('tbody')!.textContent!, /恢复下载|继续查询|重试/)
    assert.match(view.container.querySelector('tbody')!.textContent!, /核对提供商任务记录与账单/)
  } finally { await view.close() }
})

test('download-only image recovery suppresses optimization even when old flags are absent and error mentions policy', async () => {
  const view = await mount({ ...detail, jobs: [job('saved-image', 'failed', { recovery_action: 'download', recovery_modality: 'image',
    recovery_available: false, error: 'content_policy_violation', request: '{"prompt":"旧提示词"}' })] })
  try {
    assert.doesNotMatch(view.container.querySelector('tbody')!.textContent!, /优化提示词|回到画布|继续查询/)
    await act(() => button(view.container, '恢复下载').click())
    assert.deepEqual(view.events, [{ type: 'retry', id: 'saved-image' }])
  } finally { await view.close() }
})

test('unrelated export retries and active generation polling labels keep their existing behavior', async () => {
  const view = await mount({ ...detail, jobs: [job('export-retry', 'failed', { job_type: 'export', model_id: null }),
    job('running-video', 'running', { model_id: 'video', recovery_action: 'verify' })] })
  try {
    await act(() => button(view.container, '重试').click())
    assert.deepEqual(view.events, [{ type: 'retry', id: 'export-retry' }])
    assert.match(view.container.textContent!, /1 个任务进行中/)
    await tab(view.container, '进行中')
    assert.match(view.container.querySelector('tbody')!.textContent!, /生成中/)
    assert.doesNotMatch(view.container.querySelector('tbody')!.textContent!, /待核对|重试/)
  } finally { await view.close() }
})
