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
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
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
    onRetry={task => events.push({ type: 'retry', id: task.id })} /></MantineProvider>))
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
    for (const label of ['恢复下载', '继续查询', '回到画布', '返回配音', '重试']) await act(() => button(view.container, label).click())
    assert.deepEqual(view.events, [
      { type: 'retry', id: 'recover' }, { type: 'retry', id: 'resume' }, { type: 'canvas', id: 'shot' },
      { type: 'speech' }, { type: 'retry', id: 'video-failed' },
    ])
    assert.match(view.container.textContent!, /核对提供商账单/)
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
