import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import { textContextConfigError } from '@video-studio/shared/models/text-context-settings'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
const { default: TextModelContextSettings } = await import('../src/features/models/TextModelContextSettings')
after(() => dom.window.close())

function inputFor(label: string) {
  const node = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === label)
  assert.ok(node, label)
  return document.getElementById(node.htmlFor) as HTMLInputElement
}

async function fill(label: string, value: string) {
  const input = inputFor(label)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

async function blur(label: string) {
  await act(() => inputFor(label).dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })))
}

test('capacity controls preserve custom templates and output caps while editing and clearing optional limits', async () => {
  const original = { request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 8192 }, custom: { keep: true } }
  let saved: Record<string, unknown> = original
  const errors: string[] = []
  function Harness() {
    const [value, setValue] = useState(JSON.stringify(original))
    return <MantineProvider env="test"><TextModelContextSettings value={value} onChange={next => { saved = next; setValue(JSON.stringify(next)) }} onError={message => errors.push(message)} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<Harness />))
    assert.match(container.textContent!, /未配置模型容量，无法在发送前判断/)
    await fill('上下文容量', '128000')
    await fill('输出预留', '16384')
    assert.deepEqual(saved, { ...original, context_window_tokens: 128000, output_reserve_tokens: 16384 })
    assert.match(container.textContent!, /实际输出上限预留/)
    await fill('输出预留', '')
    await fill('上下文容量', '')
    assert.deepEqual(saved, original)
    assert.deepEqual(errors, [])
  } finally { await act(() => root.unmount()); container.remove() }
})

test('capacity edits explain invalid advanced JSON and retain it for repair', async () => {
  const errors: string[] = [], changes: Record<string, unknown>[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><TextModelContextSettings value={'{"request_template":'} onChange={value => changes.push(value)} onError={message => errors.push(message)} /></MantineProvider>))
    await fill('上下文容量', '128000')
    assert.deepEqual(changes, [])
    assert.deepEqual(errors, ['请先修正请求配置 JSON，再调整模型容量'])
  } finally { await act(() => root.unmount()); container.remove() }
})

test('capacity controls accept K/M input and normalize its display after editing', async () => {
  const original = { request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 8192 }, custom: { keep: true } }
  let saved: Record<string, unknown> = original
  const errors: string[] = []
  function Harness() {
    const [value, setValue] = useState(JSON.stringify(original))
    return <MantineProvider env="test"><TextModelContextSettings value={value} onChange={next => { saved = next; setValue(JSON.stringify(next)) }} onError={message => errors.push(message)} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<Harness />))
    await fill('上下文容量', '1m')
    assert.equal(saved.context_window_tokens, 1_000_000)
    assert.equal(inputFor('上下文容量').value, '1m')
    await blur('上下文容量')
    assert.equal(inputFor('上下文容量').value, '1M')
    await fill('上下文容量', '1.5M')
    await fill('输出预留', '128k')
    assert.deepEqual(saved, { ...original, context_window_tokens: 1_500_000, output_reserve_tokens: 128_000 })
    await blur('输出预留')
    assert.equal(inputFor('输出预留').value, '128K')
    assert.equal(textContextConfigError(saved), null)
    assert.deepEqual(errors, [])
  } finally { await act(() => root.unmount()); container.remove() }
})

test('saved capacities display compactly without rewriting settings on mount', async () => {
  const original = { request_template: { model: '{{model}}', input: '{{prompt}}' }, context_window_tokens: 1_000_000, output_reserve_tokens: 128_000 }
  const changes: Record<string, unknown>[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><TextModelContextSettings value={JSON.stringify(original)} onChange={value => changes.push(value)} onError={assert.fail} /></MantineProvider>))
    assert.equal(inputFor('上下文容量').value, '1M')
    assert.equal(inputFor('输出预留').value, '128K')
    assert.deepEqual(changes, [])
    assert.equal(container.querySelectorAll('.ms-context-unit').length, 2)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('invalid visible capacity remains invalid for saving until repaired or cleared', async () => {
  const original = { custom: { keep: true }, context_window_tokens: 1_000_000, output_reserve_tokens: 128_000 }
  let saved: Record<string, unknown> = original
  const errors: string[] = []
  function Harness() {
    const [value, setValue] = useState(JSON.stringify(original))
    return <MantineProvider env="test"><TextModelContextSettings value={value} onChange={next => { saved = next; setValue(JSON.stringify(next)) }} onError={message => errors.push(message)} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<Harness />))
    await fill('上下文容量', '1Q')
    await blur('上下文容量')
    assert.equal(inputFor('上下文容量').value, '1Q')
    assert.equal(saved.context_window_tokens, '1Q')
    assert.match(textContextConfigError(saved)!, /上下文容量必须为正整数/)
    assert.equal(inputFor('上下文容量').getAttribute('aria-invalid'), 'true')
    await fill('上下文容量', '1.5M')
    assert.equal(saved.context_window_tokens, 1_500_000)
    assert.equal(textContextConfigError(saved), null)
    assert.notEqual(inputFor('上下文容量').getAttribute('aria-invalid'), 'true')
    await fill('输出预留', '0.1')
    assert.equal(saved.output_reserve_tokens, '0.1')
    assert.match(textContextConfigError(saved)!, /输出预留必须为正整数/)
    await fill('输出预留', '')
    assert.equal('output_reserve_tokens' in saved, false)
    assert.equal(textContextConfigError(saved), null)
    assert.equal(inputFor('输出预留').value, '')
    assert.deepEqual(saved.custom, original.custom)
    assert.deepEqual(errors, [])
  } finally { await act(() => root.unmount()); container.remove() }
})
