import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import DirectorQuestionPanel, { type ChoiceAnswer } from '../src/DirectorQuestionPanel'
import { parseMessageChoices } from '../src/director-choices'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
dom.window.requestAnimationFrame = callback => { callback(0); return 1 }
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const choice = parseMessageChoices(JSON.stringify({ kind: 'choices', question: '选哪个故事？', options: [{ id: 'a', title: '御剑考执照', text: '御剑考执照：天才剑修被规则限制，进入凡人补考班。' }, { id: 'b', text: '师兄入魔了：师弟希望带师兄回家。' }, { id: 'other', text: '我有别的想法' }] }))!

async function mount(onContinue: (answer: string) => Promise<void>, initial: ChoiceAnswer = { custom: false, text: '' }, unavailable = false) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  function Harness() {
    const [answer, setAnswer] = useState(initial)
    return <DirectorQuestionPanel choice={choice} answer={answer} busy={false} unavailable={unavailable} onChange={setAnswer} onSkip={() => {}} onContinue={onContinue} />
  }
  await act(() => root.render(<Harness />))
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(container: HTMLElement, text: string) {
  const found = Array.from(container.querySelectorAll('button')).find(item => item.textContent === text || item.textContent?.endsWith(text))
  assert.ok(found, text); return found
}

test('choice buttons use short labels and submit complete text once while pending', async () => {
  const submitted: string[] = []
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const view = await mount(async answer => { submitted.push(answer); await pending })
  try {
    assert.equal(view.container.querySelectorAll('[role="radio"]').length, 3)
    assert.equal(button(view.container, '继续').disabled, true)
    await act(() => button(view.container, '御剑考执照').click())
    assert.equal(button(view.container, '继续').disabled, false)
    await act(() => { button(view.container, '继续').click(); button(view.container, '继续').click() })
    assert.deepEqual(submitted, [choice.options[0].text])
    assert.equal(button(view.container, '正在提交…').disabled, true)
    await act(async () => finish())
    assert.equal(button(view.container, '继续').disabled, false)
  } finally { await view.destroy() }
})

test('custom answers survive an unsuccessful request and can retry; IME and Shift+Enter do not submit', async () => {
  const submitted: string[] = []
  // Parent handles network errors and returns without dismissing this question.
  const view = await mount(async answer => { submitted.push(answer) }, { custom: true, text: '改成师兄带师弟回家' })
  try {
    const textarea = view.container.querySelector('textarea')!
    await act(() => textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
    await act(() => textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    await act(() => textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })))
    assert.equal(submitted.length, 0)
    await act(async () => { textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    assert.equal(textarea.value, '改成师兄带师弟回家')
    await act(async () => button(view.container, '继续').click())
    assert.deepEqual(submitted, ['改成师兄带师弟回家', '改成师兄带师弟回家'])
  } finally { await view.destroy() }
})

test('empty custom answers and unavailable models cannot submit but can still change or skip', async () => {
  const view = await mount(async () => assert.fail('must not submit'), { custom: true, text: '' }, true)
  try {
    assert.equal(button(view.container, '继续').disabled, true)
    assert.equal(button(view.container, '跳过').disabled, false)
    assert.equal(button(view.container, '御剑考执照').disabled, false)
    assert.ok(button(view.container, '请先配置可用文本模型'))
  } finally { await view.destroy() }
})
