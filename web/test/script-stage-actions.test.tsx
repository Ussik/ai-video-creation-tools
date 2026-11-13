import { MantineProvider } from '@mantine/core'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import ScriptStageActions from '../src/features/script/ScriptStageActions'
import { outlineGenerationIssue, outlineGenerationPrerequisite } from '../src/features/script/script-workflow'
import type { StageTarget, WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'
import type { ScriptTaskContract } from '@video-studio/shared/script/script-task-contract'

type ActionTarget = StageTarget & Pick<ScriptTaskContract, 'intent' | 'artifact_types'>

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'Element', 'Node', 'HTMLElement', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const menuButton = (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find(node => node.textContent === label)
  assert.ok(button, `expected menu action ${label}`)
  return button
}

test('empty-project outline action cannot submit; entering a creative brief enables only the current stage', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), actions: StageTarget[] = []
  const render = async (input = '', disabled = false) => {
    await act(() => root.render(<MantineProvider env="test"><ScriptStageActions script={{}} disabled={disabled}
      outlineIssue={outlineGenerationIssue({}, { input })} onAction={target => actions.push(target)} /></MantineProvider>))
  }
  try {
    await render()
    const outline = container.querySelector<HTMLButtonElement>('button')!
    assert.equal(outline.disabled, true)
    assert.equal(outline.title, outlineGenerationPrerequisite)
    await act(() => outline.click())
    assert.equal(actions.length, 0)
    await render('退休侦探追查姐姐失踪的真相。')
    assert.equal(outline.disabled, false)
    assert.ok(Array.from(container.querySelectorAll<HTMLButtonElement>('button')).slice(1).every(button => button.disabled))
    await act(() => outline.click())
    assert.deepEqual(actions, [{ stage: 'outline', episode_number: 0, operation: 'generate', intent: 'stage_design' }])
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 0, 'the story outline runs directly without a scope menu')
    await render('退休侦探追查姐姐失踪的真相。', true)
    assert.equal(outline.disabled, true, 'model/task/draft restrictions still apply')
  } finally { await act(() => root.unmount()); container.remove() }
})

test('the story outline directly requests the complete design with or without an uploaded source', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), actions: ActionTarget[] = []
  try {
    for (const hasSource of [false, true]) {
      await act(() => root.render(<MantineProvider env="test"><ScriptStageActions script={{}} hasSource={hasSource} disabled={false} onAction={target => actions.push(target)} /></MantineProvider>))
      await act(() => container.querySelector<HTMLButtonElement>('button')!.click())
      assert.deepEqual(actions.at(-1), { stage: 'outline', episode_number: 0, operation: 'generate', intent: 'stage_design' })
      assert.equal(document.querySelectorAll('[role="menuitem"]').length, 0)
      assert.equal(document.body.textContent?.includes('选择本次'), false)
    }
    assert.equal(actions.length, 2)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('saved story outline offers stage-wide editing and redesign without a remaining-document action', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), actions: ActionTarget[] = []
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptStageActions script={{ outline: '已确认的故事概要。' }} hasSource disabled={false}
      outlineIssue={outlineGenerationPrerequisite} onAction={target => actions.push(target)} /></MantineProvider>))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(() => trigger.click())
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 2)
    assert.equal(document.body.textContent?.includes('补齐栏目'), false)
    assert.equal(document.body.textContent?.includes('概要设计'), false)
    await act(() => menuButton('局部修改').click())
    assert.deepEqual(actions.at(-1), { stage: 'outline', episode_number: 0, operation: 'revise' })
    await act(() => trigger.click())
    await act(() => menuButton('重新设计').click())
    assert.deepEqual(actions.at(-1), { stage: 'outline', episode_number: 0, operation: 'regenerate', intent: 'stage_design' })
  } finally { await act(() => root.unmount()); container.remove() }
})

test('non-outline stages retain their existing missing-document supplement action', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), actions: ActionTarget[] = []
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptStageActions script={{ outline: '已保存大纲。', characters: '已保存人物。', artifacts: [
      { artifact_type: 'locations', content: '老街、学校与山林。', status: 'saved' },
    ] }} disabled={false} onAction={target => actions.push(target)} /></MantineProvider>))
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="处理已保存的场景设计"]')!
    await act(() => trigger.click())
    assert.ok(menuButton('局部修改'))
    assert.ok(menuButton('重新设计'))
    await act(() => menuButton('补齐栏目 · 缺 3 项').click())
    assert.deepEqual(actions, [{ stage: 'locations', episode_number: 0, operation: 'supplement' }])
  } finally { await act(() => root.unmount()); container.remove() }
})

test('source analysis blocks the complete outline action until the source is ready', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), actions: ActionTarget[] = []
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptStageActions script={{}} hasSource disabled={false}
      analysisWait="原稿分析中，请稍候" onAction={target => actions.push(target)} /></MantineProvider>))
    const button = container.querySelector<HTMLButtonElement>('button')!
    assert.equal(button.disabled, true)
    assert.equal(button.title, '原稿分析中，请稍候')
    await act(() => button.click())
    assert.equal(actions.length, 0)
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 0)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('saved outline remains accessible and later-stage generation keeps its existing order', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), actions: StageTarget[] = []
  const script: WorkflowProgressInput = { outline: '主角追查姐姐失踪的真相。' }
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptStageActions script={script} disabled={false}
      outlineIssue={outlineGenerationPrerequisite} onAction={target => actions.push(target)} /></MantineProvider>))
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    assert.equal(buttons[0].disabled, false, 'saved outline editing is not blocked by initial readiness')
    assert.equal(buttons[1].disabled, false)
    assert.ok(buttons.slice(2).every(button => button.disabled))
    await act(() => buttons[1].click())
    assert.deepEqual(actions, [{ stage: 'characters', episode_number: 0, operation: 'generate' }])
  } finally { await act(() => root.unmount()); container.remove() }
})
