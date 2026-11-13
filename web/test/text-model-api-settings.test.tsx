import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider } from '../src/shared/api/api'
import { resolveTextApiSettings } from '@video-studio/shared/models/text-api-settings'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: ModelAdvancedEditor } = await import('../src/features/models/ModelAdvancedEditor')
after(() => dom.window.close())

const provider = { id: 'provider-one', name: 'gpt-image', adapter: 'http', base_url: 'https://example.invalid/v1', has_key: true,
  enabled: true, auth_header: 'Authorization', auth_prefix: 'Bearer ', created_at: '2026-10-11T00:00:00Z' } as Provider
const model = { id: 'model-one', provider_id: provider.id, name: '文本模型', remote_id: 'text-model', modality: 'text',
  protocol: 'responses', settings: { text_api: { mode: 'standard' } }, enabled: true } as Model
function button(label: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  assert.ok(node, label)
  return node
}
async function fillLabeledInput(label: string, value: string) {
  const input = labeledInput(label)
  assert.ok(input)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function mount(t: TestContext, _fail = false, modelSettings = model.settings, configuredModel = model) {
  const requests: string[] = [], applied: Model[] = [], errors: string[] = []
  t.mock.method(globalThis, 'fetch', async url => { requests.push(String(url)); throw new Error('Advanced editing must not persist') })
  function Harness() {
    const [open, setOpen] = useState(true)
    return <MantineProvider env="test">{open && <ModelAdvancedEditor model={{ ...configuredModel, settings: modelSettings }} provider={provider}
      onApply={next => applied.push(next)} onClose={() => setOpen(false)} />}</MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<Harness />))
  return { container, requests, applied, errors, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

async function choose(label: string, option: string) {
  const input = labeledInput(label)
  assert.ok(input)
  await act(() => input.click())
  const dropdown = document.getElementById(input.getAttribute('aria-controls') || '') || document
  const choice = [...dropdown.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === option)
  assert.ok(choice, option)
  await act(() => choice.click())
}
function labeledInput(label: string) {
  const byAria = [...document.querySelectorAll<HTMLInputElement>('input')].find(item => item.getAttribute('aria-label') === label)
  if (byAria) return byAria
  const node = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.replace(/\s*\*$/, '') === label)
  assert.ok(node, label)
  return document.getElementById(node.htmlFor) as HTMLInputElement
}
const savedSettings = (view: Awaited<ReturnType<typeof mount>>) => view.applied[0]?.settings as Record<string, unknown>

test('advanced text forms apply the chosen output and reasoning API mapping to the actual protocol request', async t => {
  const view = await mount(t)
  try {
    await fillLabeledInput('显示名称', '我的文本模型')
    await fillLabeledInput('模型 ID / Endpoint ID', 'my-gateway-model')
    await choose('接口协议', 'Chat Completions')
    await choose('输出模式', '固定额度')
    await fillLabeledInput('最大输出 token 数', '64K')
    await choose('输出额度字段', 'max_tokens · 兼容接口')
    await act(() => labeledInput('启用推理等级').click())
    await fillLabeledInput('API 参数值 4', 'deep')
    await choose('默认档位', 'high')
    await choose('容量计算方式', '输入与输出共享上下文')
    await fillLabeledInput('上下文窗口', '1M')
    assert.equal(button('高级配置 · JSON').getAttribute('aria-expanded'), 'false')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /max_tokens = 64,000 tokens/)
    await act(async () => button('保存模型').click())
    assert.equal(view.requests.length, 0)
    assert.equal(view.applied.length, 1)
    assert.equal(view.applied[0].protocol, 'chat_completions')
    assert.equal(view.applied[0].remote_id, 'my-gateway-model')
    const settings = savedSettings(view)
    assert.equal((settings.text_capabilities as any).override.context_tokens, 1000000)
    const api = settings.text_api as Record<string, unknown>
    assert.equal(api.max_output_tokens, 64000)
    assert.equal(api.chat_output_field, 'max_tokens')
    assert.equal((api.reasoning as Record<string, unknown>).default_level, 'high')
    const body = resolveTextApiSettings(settings, view.applied[0].protocol).request_template as Record<string, unknown>
    assert.equal(body.max_tokens, 64000)
    assert.equal(body.reasoning_effort, 'deep')
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})


test('protocol round trip retains legacy output, thinking, capabilities, context, costs and other parameters', async t => {
  const settings = {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], max_tokens: 4096, thinking: { type: 'disabled' }, temperature: 0.6 },
    text_path: 'choices.0.message.content', context_window_tokens: 128000, output_reserve_tokens: 8192,
    supports_vision: true, strict_tool_arguments: true, pricing: { currency: '¥', per_generation: 0.2 }, custom_setting: { retained: true },
  }
  const configured = { ...model, protocol: 'chat_completions' as const }
  const view = await mount(t, false, settings, configured)
  try {
    assert.equal(labeledInput('最大输出 token 数').value, '4.096K')
    assert.equal(view.requests.length, 0)
    await choose('接口协议', 'Responses')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /max_output_tokens = 4,096 tokens/)
    await choose('接口协议', 'Chat Completions')
    assert.equal(labeledInput('输出额度字段').value, 'max_tokens · 兼容接口')
    assert.equal(labeledInput('默认档位').value, 'off')
    assert.equal(labeledInput('API 参数值 1').disabled, true)
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), {
      context_window_tokens: settings.context_window_tokens, output_reserve_tokens: settings.output_reserve_tokens,
      supports_vision: true, strict_tool_arguments: true, pricing: settings.pricing, custom_setting: settings.custom_setting,
      text_api: { mode: 'standard', max_output_tokens: 4096, chat_output_field: 'max_tokens', thinking: 'disabled', request_parameters: { temperature: 0.6 } },
    })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('clearing migrated output and reasoning removes their request source instead of leaving hidden template values', async t => {
  const settings = { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 65536, reasoning: { effort: 'high' }, thinking: { type: 'enabled' } }, text_paths: ['output_text', 'output'], custom: 7 }
  const view = await mount(t, false, settings)
  try {
    await fillLabeledInput('最大输出 token 数', '')
    await act(() => labeledInput('启用推理等级').click())
    await choose('输出模式', '沿用服务默认')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /未设置最大输出，沿用接口默认/)
    await act(async () => button('保存模型').click())
    const saved = savedSettings(view), options = saved.text_api as Record<string, unknown>
    assert.equal(saved.custom, 7)
    assert.equal(options.max_output_tokens, undefined)
    assert.equal((options.reasoning as Record<string, unknown>).enabled, false)
    assert.equal(saved.request_template, undefined)
    const body = resolveTextApiSettings(saved, 'responses').request_template as Record<string, unknown>
    assert.equal(body.max_output_tokens, undefined)
    assert.equal(body.reasoning, undefined)
    assert.equal(body.thinking, undefined)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('custom request and stream contracts survive protocol changes and save without automatic rewriting', async t => {
  const settings = { request_path: 'custom/generate', request_template: { model: '{{model}}', prompt: '{{prompt}}', max_tokens: 7777 }, stream_request_template: { model: '{{model}}', stream_prompt: '{{prompt}}' }, text_path: 'result.text', headers: { 'X-Custom': 'retained' }, context_window_tokens: 100000 }
  const view = await mount(t, false, settings)
  try {
    assert.equal(labeledInput('接口配置方式').value, '自定义接口 · 高级配置')
    await choose('接口协议', 'Chat Completions')
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), settings)
    assert.equal(view.applied[0].protocol, 'chat_completions')
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('changing a custom contract to standard requires the explicit action and allows restoring the original draft', async t => {
  const settings = { request_path: 'custom/generate', request_template: { custom_prompt: '{{prompt}}' }, text_path: 'answer', supports_vision: true, headers: { 'X-Route': 'keep' } }
  const view = await mount(t, false, settings)
  try {
    await choose('接口配置方式', '标准接口 · 表单配置')
    assert.equal(labeledInput('接口配置方式').value, '自定义接口 · 高级配置')
    assert.ok(button('重新构造标准接口'))
    assert.equal(view.requests.length, 0)
    await act(() => button('重新构造标准接口').click())
    await choose('输出模式', '固定额度')
    await fillLabeledInput('最大输出 token 数', '16K')
    await choose('接口配置方式', '自定义接口 · 高级配置')
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), settings)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('standard and custom mode round trips preserve form parameters and do not create duplicate template sources', async t => {
  const settings = { text_api: { mode: 'standard', max_output_tokens: 32000, reasoning_effort: 'low' }, supports_vision: true }
  const view = await mount(t, false, settings)
  try {
    await choose('接口配置方式', '自定义接口 · 高级配置')
    assert.equal(labeledInput('接口配置方式').value, '自定义接口 · 高级配置')
    await choose('接口配置方式', '标准接口 · 表单配置')
    assert.equal(labeledInput('最大输出 token 数').value, '32K')
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), settings)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('invalid visible output blocks saving and can be repaired or cleared', async t => {
  const view = await mount(t)
  try {
    await choose('输出模式', '固定额度')
    await fillLabeledInput('最大输出 token 数', '1Q')
    await act(async () => button('保存模型').click())
    assert.equal(view.requests.length, 0)
    assert.equal(labeledInput('最大输出 token 数').value, '1Q')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /最大输出必须为正整数/)
    await fillLabeledInput('最大输出 token 数', '')
    await choose('输出模式', '沿用服务默认')
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), { text_api: { mode: 'standard', output_mode: 'upstream' } })
  } finally { await view.destroy() }
})

test('advanced reserve remains separate from actual output and its absence is explained before requests', async t => {
  const settings = { text_api: { mode: 'standard' }, context_window_tokens: 1000000 }
  const view = await mount(t, false, settings)
  try {
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /无法完成共享窗口预留检查/)
    await act(() => button('高级配置 · JSON').click())
    await fillLabeledInput('输出预留', '128K')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /未设置最大输出，沿用接口默认/)
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), { ...settings, output_reserve_tokens: 128000 })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('mode backups restore only the interface while retaining edits to shared capacity and capabilities', async t => {
  const settings = { text_api: { mode: 'standard', max_output_tokens: 32000 }, context_window_tokens: 1000000 }
  const view = await mount(t, false, settings)
  try {
    await choose('接口配置方式', '自定义接口 · 高级配置')
    await fillLabeledInput('上下文窗口', '2M')
    const label = [...document.querySelectorAll<HTMLLabelElement>('.harness-text-input-choices label')].find(node => node.textContent === '图片')!
    const input = document.getElementById(label.htmlFor) as HTMLInputElement
    await act(() => input.click())
    await choose('接口配置方式', '标准接口 · 表单配置')
    assert.equal(labeledInput('上下文窗口').value, '2M')
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), { ...settings, text_capabilities: { version: 1, override: { budget_mode: 'shared', context_tokens: 2000000 } }, supports_vision: true })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('custom request summaries distinguish a smaller streaming and tools cap from nonstream output', async t => {
  const settings = { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 64000 },
    stream_request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 8000 }, text_paths: ['output_text', 'output'] }
  const view = await mount(t, false, settings)
  try {
    const text = document.querySelector('.ms-text-api-summary')!.textContent!
    assert.match(text, /非流式文本：max_output_tokens = 64,000 tokens/)
    assert.match(text, /流式 \/ 工具调用：max_output_tokens = 8,000 tokens/)
    await act(async () => button('保存模型').click())
    assert.deepEqual(savedSettings(view), settings)
  } finally { await view.destroy() }
})

