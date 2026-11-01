import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ScriptDraftResolution, ScriptDraftResolutionInput } from '@video-studio/shared/script/script-draft-resolution'

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
after(() => dom.window.close())

function candidate(rounds: number, runRounds = rounds): ScriptDraftResolution {
  return { id: 'candidate', version: 'candidate-v3', stage: 'outline', episode_number: 0, document_count: 2, completed_rounds: rounds,
    findings: [{ source_key: 'outline', kind: 'contradiction', quote: '人物身份前后不一致。', explanation: '同一人物被写成两种互斥身份。',
      suggestion: '沿用已确认的人物身份。', previous_answer: '保留原稿中的师兄身份。' }],
    run: { strategy: 'manual', status: 'interrupted', completed: 1, total: 1, completed_rounds: runRounds } }
}

function button(scope: ParentNode, label: string) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(node, label)
  return node
}

async function mount(resolution: ScriptDraftResolution) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), submitted: ScriptDraftResolutionInput[] = []
  let openings = 0
  function Harness() {
    const [opened, setOpened] = useState(false)
    return <DirectorDraftResolution resolution={resolution} opened={opened} busy={false} onClose={() => setOpened(false)}
      onOpen={() => { openings++; setOpened(true) }} onResolve={input => submitted.push(input)} onDiscard={() => assert.fail('must preserve the candidate')} />
  }
  await act(() => root.render(<MantineProvider env="test"><Harness /></MantineProvider>))
  return { container, submitted, openings: () => openings,
    async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('three completed review rounds can continue and completed repair patches do not imply analysis completion', async () => {
  const resolution = candidate(3), view = await mount(resolution)
  try {
    const status = view.container.querySelector('[role="status"]')!
    assert.match(status.textContent!, /1\/1 项修订补丁已完成/)
    assert.match(status.textContent!, /后续文稿分析与独立复核进度见执行记录/)
    assert.equal(button(view.container, '继续处理').disabled, false)
    assert.deepEqual(view.submitted, [], 'rendering saved progress never starts a model request')
    await act(() => button(view.container, '继续处理').click())
    assert.deepEqual(view.submitted, [{ id: resolution.id, version: resolution.version, strategy: 'continue' }])
    assert.equal(view.openings(), 0)
  } finally { await view.destroy() }
})

test('completed review round counters never prevent an explicit continuation or editing the retained plan', async () => {
  const resolution = candidate(40, 39), view = await mount(resolution)
  try {
    assert.equal(button(view.container, '继续处理').disabled, false)
    assert.deepEqual(view.submitted, [], 'saved counters never trigger work without a user action')
    await act(() => button(view.container, '继续处理').click())
    assert.deepEqual(view.submitted, [{ id: resolution.id, version: resolution.version, strategy: 'continue' }])
    await act(() => button(view.container, '查看问题').click())
    assert.equal(view.openings(), 1)
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.equal(button(dialog, '沿用方案继续').disabled, false)
    await act(() => button(dialog, '调整方案').click())
    assert.equal(dialog.querySelector('textarea')!.value, '保留原稿中的师兄身份。', 'existing answers remain editable')
    assert.equal([...dialog.querySelectorAll('button')].some(node => node.textContent === '沿用方案继续'), false)
    assert.equal(button(dialog, '全部交给 AI 决定').disabled, false)
    await act(() => button(dialog, '全部交给 AI 决定').click())
    assert.deepEqual(view.submitted.at(-1), { id: resolution.id, version: resolution.version, strategy: 'ai' })
  } finally { await view.destroy() }
})

test('interrupted work displays the actual unresolved conflict and preserves explicit continue or adjustment actions', async () => {
  const resolution = candidate(12)
  resolution.run!.message = '人物身份仍有冲突：人物介绍写为师兄，分集大纲写为亲生兄长，需要明确统一。'
  resolution.findings[0]!.repair_attempts = 3
  const view = await mount(resolution)
  try {
    assert.match(view.container.querySelector('[role="status"]')!.textContent!, /人物介绍写为师兄，分集大纲写为亲生兄长/)
    assert.deepEqual(view.submitted, [], 'a concrete interruption is shown without silently restarting work')
    await act(() => button(view.container, '查看问题').click())
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.match(dialog.textContent!, /同一人物被写成两种互斥身份/)
    assert.match(dialog.textContent!, /已修订 3 次，当前仍有未落实的内容/)
    assert.equal(button(dialog, '沿用方案继续').disabled, false)
    await act(() => button(dialog, '沿用方案继续').click())
    assert.deepEqual(view.submitted, [{ id: resolution.id, version: resolution.version, strategy: 'continue' }])
    assert.equal(dialog.querySelector('textarea'), null, 'viewing saved issues does not change the existing plan')
    await act(() => button(dialog, '调整方案').click())
    assert.equal(dialog.querySelector('textarea')!.value, '保留原稿中的师兄身份。')
    assert.equal(button(dialog, '全部交给 AI 决定').disabled, false)
    await act(() => button(dialog, '全部交给 AI 决定').click())
    assert.deepEqual(view.submitted.at(-1), { id: resolution.id, version: resolution.version, strategy: 'ai' })
  } finally { await view.destroy() }
})
