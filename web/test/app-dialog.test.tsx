import assert from 'node:assert/strict'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(globalThis, { requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { useAppDialog } = await import('../src/shared/ui/AppDialog')
after(() => dom.window.close())

type ConfirmOptions = Parameters<ReturnType<typeof useAppDialog>['confirm']>[0]
type PromptOptions = Parameters<ReturnType<typeof useAppDialog>['prompt']>[0]
type Result = boolean | string | null

function Harness({ results, confirmOptions, promptOptions }: {
  results: Result[]; confirmOptions?: Partial<ConfirmOptions>; promptOptions?: Partial<PromptOptions>
}) {
  const { confirm, prompt, dialog } = useAppDialog()
  return <>
    <button onClick={() => { void confirm({ title: '确认更新设定', message: '已有素材保留，后续制作使用新设定。', ...confirmOptions }).then(value => results.push(value)) }}>打开确认</button>
    <button onClick={() => { void prompt({ title: '重命名项目', message: '输入新的项目名称。', ...promptOptions }).then(value => results.push(value)) }}>打开输入</button>
    {dialog}
  </>
}

async function settle() { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
function button(label: string, scope: ParentNode = document) {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  assert.ok(element, `button ${label} exists`)
  return element
}
function dialog() {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  assert.ok(element, 'dialog remains available')
  return element
}
function promptInput() {
  const element = dialog().querySelector<HTMLInputElement>('input[aria-label="重命名项目"]')
  assert.ok(element, 'prompt is labelled with its purpose')
  return element
}
async function click(element: HTMLElement) { await act(async () => element.click()); await settle() }
async function type(value: string) {
  const input = promptInput()
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}
async function enter(isComposing = false) {
  await act(async () => promptInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing })))
  await settle()
}
async function mount(t: TestContext, options: { confirmOptions?: Partial<ConfirmOptions>; promptOptions?: Partial<PromptOptions> } = {}) {
  const results: Result[] = []
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><Harness results={results} {...options} /></MantineProvider>))
  await settle()
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { results }
}

test('confirmation resolves cancellation and acceptance independently and can reopen', async t => {
  const state = await mount(t, { confirmOptions: { danger: true, confirmLabel: '确认更新', cancelLabel: '保留原设定' } })
  await click(button('打开确认'))
  assert.match(dialog().textContent!, /已有素材保留/)
  await click(button('保留原设定', dialog()))
  assert.deepEqual(state.results, [false])
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await click(button('打开确认'))
  await click(button('确认更新', dialog()))
  assert.deepEqual(state.results, [false, true])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('prompt cancellation returns null and saving returns trimmed input', async t => {
  const state = await mount(t, { promptOptions: { defaultValue: '  夜巡三更  ' } })
  await click(button('打开输入'))
  assert.equal(promptInput().value, '  夜巡三更  ')
  await click(button('取消', dialog()))
  assert.deepEqual(state.results, [null])
  await click(button('打开输入'))
  await click(button('保存', dialog()))
  assert.deepEqual(state.results, [null, '夜巡三更'])
})

test('empty and whitespace prompts cannot submit through either the save button or Enter', async t => {
  const state = await mount(t)
  await click(button('打开输入'))
  assert.equal(button('保存', dialog()).disabled, true)
  await click(button('保存', dialog()))
  await enter()
  assert.deepEqual(state.results, [])
  await type('   ')
  assert.equal(button('保存', dialog()).disabled, true)
  await enter()
  assert.deepEqual(state.results, [])
  assert.equal(promptInput().value, '   ', 'invalid submission preserves input for correction')
  await type('  城隍旧事  ')
  assert.equal(button('保存', dialog()).disabled, false)
  await enter()
  assert.deepEqual(state.results, ['城隍旧事'])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('Enter during IME composition keeps the prompt open; a later Enter submits the completed name', async t => {
  const state = await mount(t)
  await click(button('打开输入'))
  await type('沈砚')
  await enter(true)
  assert.deepEqual(state.results, [])
  assert.equal(promptInput().value, '沈砚')
  await enter()
  assert.deepEqual(state.results, ['沈砚'])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('large scrollable confirmations retain all details, their requested Mantine size and an accessible title', async t => {
  const items = Array.from({ length: 120 }, (_, index) => `镜头 ${index + 1} · 保留原始素材`)
  const state = await mount(t, { confirmOptions: {
    title: '确认镜头清理范围', size: 'lg', scrollable: true,
    details: <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>,
  } })
  await click(button('打开确认'))
  const current = dialog()
  const headingId = current.getAttribute('aria-labelledby')
  assert.ok(headingId, 'dialog points to its visible heading')
  const heading = document.getElementById(headingId)
  assert.ok(heading)
  assert.equal(heading.tagName, 'H2')
  assert.equal(heading.textContent, '确认镜头清理范围')
  assert.deepEqual([...current.querySelectorAll('li')].map(item => item.textContent), items)
  const modalRoot = document.querySelector<HTMLElement>('.mantine-Modal-root')
  assert.equal(modalRoot?.style.getPropertyValue('--modal-size'), 'var(--modal-size-lg)')
  await click(button('取消', current))
  assert.deepEqual(state.results, [false])
})
