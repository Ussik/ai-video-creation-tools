import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import DirectorQuestionPanel, { choiceAnswerText, type ChoiceAnswer } from '../src/DirectorQuestionPanel'
import { parseMessageChoices, type ParsedMessageChoices } from '../src/director-choices'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
dom.window.requestAnimationFrame = callback => { callback(0); return 1 }
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const choice = parseMessageChoices(JSON.stringify({ kind: 'choices', question: '选哪个故事？', options: [{ id: 'a', title: '御剑考执照', text: '御剑考执照：天才剑修被规则限制，进入凡人补考班。' }, { id: 'b', text: '师兄入魔了：师弟希望带师兄回家。' }, { id: 'other', text: '我有别的想法', kind: 'custom' }] }))!

async function mount(onContinue: (answer: string) => Promise<void>, initial: ChoiceAnswer = { custom: false, text: '' }, unavailable = false, question: ParsedMessageChoices = choice, onSkip: () => Promise<void> = async () => {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  function Harness() {
    const [answer, setAnswer] = useState(initial)
    return <DirectorQuestionPanel choice={question} answer={answer} busy={false} unavailable={unavailable} onChange={setAnswer} onSkip={onSkip} onContinue={onContinue} />
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

test('unavailable models cannot submit or delegate into a dead end but can still change answers', async () => {
  const view = await mount(async () => assert.fail('must not submit'), { custom: true, text: '' }, true)
  try {
    assert.equal(button(view.container, '继续').disabled, true)
    assert.equal(button(view.container, '跳过').disabled, true)
    assert.equal(button(view.container, '御剑考执照').disabled, false)
    assert.ok(button(view.container, '请先配置可用文本模型'))
  } finally { await view.destroy() }
})

test('delegating incomplete fields sends once, locks answers while pending and preserves values for a failed-request retry', async () => {
  const form = parseMessageChoices(JSON.stringify({ kind: 'input_request', question: '确定亲属身份', fields: [
    { id: 'family', label: '直系亲属' }, { id: 'inlaw', label: '姻亲身份' },
  ] }))!
  let calls = 0
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const view = await mount(async () => assert.fail('delegation must not submit partial answers'), { custom: false, text: '', fields: { family: '暂未决定' } }, false, form,
    async () => { calls++; await pending })
  try {
    assert.equal(button(view.container, '继续').disabled, true)
    assert.equal(button(view.container, '跳过').disabled, false)
    await act(() => { button(view.container, '跳过').click(); button(view.container, '跳过').click() })
    assert.equal(calls, 1)
    assert.equal(button(view.container, '正在跳过…').disabled, true)
    assert.equal(view.container.querySelector('textarea')!.disabled, true)
    await act(async () => finish())
    assert.equal(view.container.querySelector('textarea')!.value, '暂未决定')
    await act(async () => button(view.container, '跳过').click())
    assert.equal(calls, 2)
  } finally { await view.destroy() }
})

test('delegating with an unsubmitted option does not submit the selected answer or custom details', async () => {
  let calls = 0
  const view = await mount(async () => assert.fail('delegation must not confirm the selected answer'),
    { custom: false, selectedId: choice.options[0].label, text: '未提交的补充' }, false, choice, async () => { calls++ })
  try {
    assert.equal(button(view.container, '继续').disabled, false)
    await act(async () => button(view.container, '跳过').click())
    assert.equal(calls, 1)
    assert.equal(button(view.container, '御剑考执照').getAttribute('aria-checked'), 'true')
  } finally { await view.destroy() }
})

test('partial-scope choices require explicit details; the selected scope and details are sent together', async () => {
  const question = parseMessageChoices(JSON.stringify({ kind: 'choices', question: '保留哪些顾问？', options: [
    { id: 'all', title: '全部保留', text: '律师、管家、医生全部保留' },
    { id: 'subset', title: '只保留一到两人', text: '只保留一到两人', requires_details: true },
  ] }))!
  const submitted: string[] = []
  const initial = { custom: false, selectedId: 'subset', text: '律师和医生' }
  assert.equal(choiceAnswerText(question, { ...initial, text: '  ' }), '')
  assert.equal(choiceAnswerText(question, initial), '只保留一到两人\n补充：律师和医生')
  const view = await mount(async answer => { submitted.push(answer) }, initial, false, question)
  try {
    assert.equal(view.container.querySelector('textarea')!.getAttribute('aria-label'), '补充所选方案')
    await act(async () => button(view.container, '继续').click())
    assert.deepEqual(submitted, ['只保留一到两人\n补充：律师和医生'])
    await act(() => button(view.container, '全部保留').click())
    assert.equal(view.container.querySelector('textarea'), null)
    await act(() => button(view.container, '只保留一到两人').click())
    assert.equal(view.container.querySelector('textarea')!.value, '', 'do not carry details from a different option')
    assert.equal(button(view.container, '继续').disabled, true)
  } finally { await view.destroy() }
})

test('open form requires each requested field, supports multiple references and submits labelled values without duplicates', async () => {
  const form = parseMessageChoices(JSON.stringify({ kind: 'input_request', question: '确定亲属身份', fields: [
    { id: 'family', label: '直系亲属' }, { id: 'inlaw', label: '姻亲身份', suggestions: ['儿媳', '女婿'] },
  ] }))!
  const submitted: string[] = []
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const view = await mount(async answer => { submitted.push(answer); await pending }, { custom: false, text: '', fields: { family: '父亲和女儿' } }, false, form)
  try {
    assert.equal(view.container.querySelectorAll('[role="radio"]').length, 0)
    assert.equal(view.container.querySelectorAll('textarea').length, 2)
    assert.equal(button(view.container, '继续').disabled, true)
    await act(() => button(view.container, '儿媳').click())
    await act(() => button(view.container, '女婿').click())
    assert.equal((view.container.querySelector('textarea[aria-label="姻亲身份"]') as HTMLTextAreaElement).value, '儿媳、女婿')
    await act(() => button(view.container, '儿媳').click())
    assert.equal(button(view.container, '儿媳').getAttribute('aria-pressed'), 'false')
    await act(() => { button(view.container, '继续').click(); button(view.container, '继续').click() })
    assert.deepEqual(submitted, ['直系亲属：父亲和女儿\n姻亲身份：女婿'])
    await act(async () => finish())
    assert.equal(button(view.container, '继续').disabled, false)
    assert.equal(choiceAnswerText(form, { custom: false, text: '', fields: { family: ' ', inlaw: '女婿' } }), '')
  } finally { await view.destroy() }
})
