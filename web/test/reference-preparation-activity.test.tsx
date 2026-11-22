import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { CanvasPreparationRecovery, CanvasPreparationSnapshot } from '@video-studio/shared/api/contracts'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'CustomEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { default: Activity } = await import('../src/features/storyboard/ReferencePreparationActivity')
const { default: Recovery } = await import('../src/features/storyboard/ReferencePreparationRecovery')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const running = (runId: string, startedAt?: string): CanvasPreparationRecovery => ({
  run_id: runId, state: 'running', full_scope: true, can_retry_failed: false, retry_reason: '', retryable_unit_keys: [],
  can_continue: false, continue_reason: '', pending_unit_keys: [], can_restart_all: false, restart_reason: '', requires_confirmation: false,
  inspection: { executor: 'active', started_at: startedAt, heartbeat_at: new Date(0).toISOString(), cancel_requested: false,
    can_cancel: true, can_abandon: false, unresolved_responses: 0, pending_requests: 1, message: '',
    progress: { label: '整理人物与道具', completed_units: 3, total_units: 5 } },
  budget: { task_requests: 4, task_max_requests: 512, run_requests: 4, run_max_requests: 256, runs: 1, max_runs: 3 },
})

test('blocked coverage shows its actionable reason without asking for another refresh', async () => {
  const reason = '「旧站口 · 基础」对应多个同场档案。请核对本场的同名档案。'
  const capabilities: CanvasPreparationRecovery = { ...running('partial'), state: 'partial', continue_reason: reason, inspection: undefined }
  const snapshot: CanvasPreparationSnapshot = { signature: 'fixture', scene_ids: ['scene'], preparation: capabilities,
    plan: { signature: 'fixture', scene_ids: ['scene'], profiles: [], status: 'partial', failed_units: [{ stage: 'coverage', unit_key: '@visual-coverage',
      code: 'visual_coverage_identity_ambiguous', message: reason, retryable: false, recovery_type: 'blocked', checkpoint_source: 'original_raw', is_new_model_call: false, attempt: 1 }] } }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><Recovery simple capabilities={capabilities} snapshot={snapshot} sceneCount={1} busy={false}
      onReload={() => assert.fail('settled coverage conflict cannot be cleared by refresh')} onRestart={() => assert.fail('restart is unavailable')} /></MantineProvider>))
    assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes(reason))
    assert.equal(container.querySelector('button'), null)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('activity uses the durable start, respects local save phases and cleans up its clock', async t => {
  let now = Date.parse('2026-11-19T01:00:00Z'), tick!: () => void, cleared = 0
  t.mock.method(Date, 'now', () => now)
  t.mock.method(dom.window, 'setInterval', (callback: () => void, delay: number) => { assert.equal(delay, 1000); tick = callback; return 42 })
  t.mock.method(dom.window, 'clearInterval', (id: number) => { assert.equal(id, 42); cleared++ })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const caps = running('first', new Date(now - 12500).toISOString())
  const render = async (preparing: boolean, activity: string) => act(() => root.render(<MantineProvider env="test"><Activity capabilities={caps} activity={activity} preparing={preparing} /></MantineProvider>))
  try {
    await render(true, '正在整理参考')
    const status = document.querySelector('[aria-label="画布准备进度"]')!
    assert.equal(status.getAttribute('role'), 'status')
    assert.equal(status.textContent, '正在整理人物与道具 · 12 秒')
    assert.ok(status.querySelector('.mantine-Loader-root'))
    assert.equal(status.querySelector('button'), null)
    assert.doesNotMatch(status.textContent!, /已完成|3\/5|请求|模型|详情/)
    now += 1000
    await act(() => tick())
    caps.inspection!.heartbeat_at = new Date(now).toISOString()
    await render(false, '正在保存参考设定')
    assert.equal(status.textContent, '正在保存参考设定 · 13 秒')
  } finally { await act(() => root.unmount()); container.remove() }
  assert.equal(cleared, 1)
})

test('missing starts use a stable local clock and a new run resets it without using heartbeats', async t => {
  let now = Date.parse('2026-11-19T02:00:00Z'), tick!: () => void
  t.mock.method(Date, 'now', () => now)
  t.mock.method(dom.window, 'setInterval', (callback: () => void) => { tick = callback; return 43 })
  t.mock.method(dom.window, 'clearInterval', () => {})
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const render = async (caps: CanvasPreparationRecovery) => act(() => root.render(<MantineProvider env="test"><Activity capabilities={caps} /></MantineProvider>))
  try {
    await render(running('first', 'invalid'))
    const status = document.querySelector('[aria-label="画布准备进度"]')!
    assert.equal(status.textContent, '正在整理人物与道具 · 0 秒')
    now += 5000
    await act(() => tick())
    const updated = running('first')
    updated.inspection!.heartbeat_at = new Date(now).toISOString()
    await render(updated)
    assert.equal(status.textContent, '正在整理人物与道具 · 5 秒')
    const next = running('second')
    next.inspection!.progress = undefined
    await render(next)
    assert.equal(status.textContent, '正在准备画布 · 0 秒')
  } finally { await act(() => root.unmount()); container.remove() }
})
