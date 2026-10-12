import { MantineProvider } from '@mantine/core'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import ScriptStageActions from '../src/features/script/ScriptStageActions'
import { outlineGenerationIssue, outlineGenerationPrerequisite } from '../src/features/script/script-workflow'
import type { StageTarget, WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'

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
    assert.deepEqual(actions, [{ stage: 'outline', episode_number: 0, operation: 'generate' }])
    await render('退休侦探追查姐姐失踪的真相。', true)
    assert.equal(outline.disabled, true, 'model/task/draft restrictions still apply')
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
