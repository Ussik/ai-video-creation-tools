import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import { resolveTextApiSettings, textApiConfigError, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLInputElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: HarnessTextModelOptions } = await import('../src/features/models/HarnessTextModelOptions')
after(() => dom.window.close())

type Settings = Record<string, unknown>
async function mount(initial: Settings, protocol: TextApiProtocol = 'responses', disabled = false, scope?: { base_url: string; protocol: string; remote_id: string }) {
  let current = initial
  const changes: Settings[] = []
  function Form() {
    const [settings, setSettings] = useState(initial)
    return <MantineProvider env="test"><HarnessTextModelOptions settings={settings} protocol={protocol} disabled={disabled} scope={scope}
      onChange={next => { current = next; changes.push(next); setSettings(next) }} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<Form />))
  return { container, changes, settings: () => current, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function input(label: string) {
  const byAria = [...document.querySelectorAll<HTMLInputElement>('input')].find(node => node.getAttribute('aria-label') === label)
  if (byAria) return byAria
  const field = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.replace(/\s*\*$/, '') === label)
  assert.ok(field, label)
  return document.getElementById(field.htmlFor) as HTMLInputElement
}
async function fill(label: string, value: string) {
  const node = input(label)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function choose(label: string, option: string) {
  const node = input(label)
  await act(() => node.click())
  const dropdown = document.getElementById(node.getAttribute('aria-controls') || '') || document
  const item = [...dropdown.querySelectorAll<HTMLElement>('[role="option"]')].find(candidate => candidate.textContent === option)
  assert.ok(item, option)
  await act(() => item.click())
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  assert.ok(found, label)
  return found
}
const api = (settings: Settings) => settings.text_api as any

test('the Harness layout exposes compact capability fields without mutating settings on mount', async () => {
  const initial = { text_api: { mode: 'standard' }, custom: { keep: true } }, view = await mount(initial)
  try {
    assert.equal(input('最大输入 token 数').placeholder, '未知时留空')
    assert.equal(input('输出模式').value, '沿用服务默认')
    assert.equal(input('最大输出 token 数').disabled, true)
    assert.equal(input('文本').checked, true)
    assert.equal(input('文本').disabled, true)
    assert.equal(input('图片').checked, false)
    assert.equal(input('启用推理等级').checked, false)
    assert.equal(view.container.querySelectorAll('.harness-text-capacities').length, 2)
    const inputTypes = view.container.querySelector('.harness-text-input-types')!
    assert.equal(inputTypes.children[0].textContent, '输入类型')
    assert.equal(inputTypes.children[1].className, 'harness-text-input-choices')
    assert.deepEqual(view.changes, [])
    assert.equal(document.querySelector('textarea'), null)
  } finally { await view.destroy() }
})

test('legacy capacity reserve stays visibly distinct from the output cap and an explicit cap reaches the request', async () => {
  const initial = { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' },
    text_paths: ['output_text', 'output'], context_window_tokens: 1_000_000, output_reserve_tokens: 128_000 }
  const view = await mount(initial)
  try {
    assert.equal(input('最大输出 token 数').value, '')
    assert.match(view.container.textContent!, /不发送输出参数，由服务决定默认额度/)
    assert.match(view.container.textContent!, /容量预留 128,000 tokens 仅用于估算，不会提高实际输出长度/)
    assert.deepEqual(view.changes, [])
    await choose('输出模式', '固定额度')
    await fill('最大输出 token 数', '65536')
    assert.equal(api(view.settings()).max_output_tokens, 65_536)
    assert.equal(view.settings().output_reserve_tokens, 128_000)
    const request = resolveTextApiSettings(view.settings(), 'responses').request_template as Settings
    assert.equal(request.max_output_tokens, 65_536)
    assert.equal(request.output_reserve_tokens, undefined)
    assert.match(view.container.textContent!, /实际请求最大输出：65,536 tokens（max_output_tokens）/)
    assert.doesNotMatch(view.container.textContent!, /未设置实际输出上限/)
  } finally { await view.destroy() }
})

test('K/M capacities and image support edit their actual settings while preserving unknown options and invalid drafts', async () => {
  const initial = { text_api: { mode: 'standard', request_parameters: { temperature: .6 } }, custom: { keep: true } }, view = await mount(initial)
  try {
    await choose('容量计算方式', '输入与输出共享上下文')
    await fill('上下文窗口', '1.5M')
    await choose('输出模式', '固定额度')
    await fill('最大输出 token 数', '128k')
    await act(() => input('图片').click())
    assert.equal((view.settings().text_capabilities as any).override.context_tokens, 1_500_000)
    assert.equal(api(view.settings()).max_output_tokens, 128_000)
    assert.equal(view.settings().supports_vision, true)
    assert.deepEqual(view.settings().custom, initial.custom)
    assert.deepEqual(api(view.settings()).request_parameters, { temperature: .6 })
    assert.equal((resolveTextApiSettings(view.settings(), 'responses').request_template as Settings).max_output_tokens, 128_000)
    await fill('最大输出 token 数', '1Q')
    assert.equal(api(view.settings()).max_output_tokens, '1Q')
    assert.equal(input('最大输出 token 数').getAttribute('aria-invalid'), 'true')
    assert.match(textApiConfigError(view.settings(), 'responses')!, /最大输出/)
    await fill('最大输出 token 数', '')
    assert.equal('max_output_tokens' in api(view.settings()), false)
    await fill('上下文窗口', '')
    assert.equal('context_tokens' in (view.settings().text_capabilities as any).override, false)
  } finally { await view.destroy() }
})

test('reasoning mappings and the selected default reach the real protocol request instead of remaining display metadata', async () => {
  const view = await mount({ text_api: { mode: 'standard' } })
  try {
    await act(() => input('启用推理等级').click())
    assert.equal(input('API 参数值 1').disabled, true)
    assert.equal(input('API 参数值 1').placeholder, '关闭思考')
    assert.deepEqual(api(view.settings()).reasoning.levels.map((row: any) => row.level), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    await fill('API 参数值 4', 'deep')
    await choose('默认档位', 'high')
    const settings = view.settings()
    assert.equal(api(settings).reasoning.default_level, 'high')
    assert.deepEqual((resolveTextApiSettings(settings, 'responses').request_template as Settings).reasoning, { effort: 'deep' })
    assert.equal((resolveTextApiSettings(settings, 'chat_completions').request_template as Settings).reasoning_effort, 'deep')
  } finally { await view.destroy() }
})

test('adding, changing and deleting mapping rows keeps the default bound to an available level', async () => {
  const view = await mount({ text_api: { mode: 'standard' } })
  try {
    await act(() => input('启用推理等级').click())
    await act(() => button('添加档位').click())
    assert.equal(input('推理档位 7').value, 'minimal')
    await act(() => button('删除推理档位 5').click())
    assert.equal(input('推理档位 5').value, 'max')
    await choose('推理档位 6', 'xhigh')
    await fill('API 参数值 6', 'extended')
    await choose('默认档位', 'xhigh')
    assert.equal(api(view.settings()).reasoning.default_level, 'xhigh')
    await act(() => button('删除推理档位 6').click())
    assert.equal(api(view.settings()).reasoning.default_level, 'off')
    const request = resolveTextApiSettings(view.settings(), 'responses').request_template as Settings
    assert.deepEqual(request.reasoning, { effort: 'none' })
    assert.equal(request.thinking, undefined)
  } finally { await view.destroy() }
})

test('turning reasoning off preserves mappings and overrides legacy reasoning values in requests', async () => {
  const reasoning = { enabled: true, default_level: 'high', levels: [{ level: 'high', api_value: 'deep' }] }
  const view = await mount({ text_api: { mode: 'standard', reasoning_effort: 'medium', thinking: 'enabled', reasoning } })
  try {
    await act(() => input('启用推理等级').click())
    assert.deepEqual(api(view.settings()).reasoning, { ...reasoning, enabled: false })
    assert.equal(api(view.settings()).reasoning_effort, 'medium')
    const body = resolveTextApiSettings(view.settings(), 'responses').request_template as Settings
    assert.equal(body.reasoning, undefined)
    assert.equal(body.thinking, undefined)
    await act(() => input('启用推理等级').click())
    assert.equal(input('API 参数值 1').value, 'deep')
  } finally { await view.destroy() }
})

test('complex custom request and stream templates stay intact and require advanced editing', async () => {
  const initial = { request_path: '/vendor/generate', request_template: { model: '{{model}}', input: { prompt: '{{prompt}}' }, max_output_tokens: 7777 },
    stream_request_template: { model: '{{model}}', special_input: '{{prompt}}', max_output_tokens: 3333 },
    text_path: 'result.answer', headers: { 'X-Route': 'retained' }, special: ['keep'] }
  const view = await mount(initial)
  try {
    assert.equal(input('最大输出 token 数').value, '7.777K')
    assert.equal(input('最大输出 token 数').disabled, true)
    assert.equal(input('启用推理等级').disabled, true)
    assert.deepEqual(view.changes, [])
    await choose('容量计算方式', '输入与输出共享上下文')
    await fill('上下文窗口', '1M')
    await act(() => input('图片').click())
    assert.deepEqual(view.settings(), { ...initial, text_capabilities: { version: 1, override: { budget_mode: 'shared', context_tokens: 1_000_000 } }, supports_vision: true })
  } finally { await view.destroy() }
})

test('Anthropic requires an explicit visible output limit and never supplies a hidden 8K default', async () => {
  const view = await mount({ text_api: { mode: 'standard' } }, 'anthropic_messages')
  try {
    assert.equal(input('最大输出 token 数').value, '')
    assert.equal(input('最大输出 token 数').required, true)
    assert.equal(input('最大输出 token 数').getAttribute('aria-invalid'), 'true')
    assert.deepEqual(view.changes, [])
    await fill('最大输出 token 数', '128K')
    const body = resolveTextApiSettings(view.settings(), 'anthropic_messages').request_template as Settings
    assert.equal(body.max_tokens, 128_000)
    assert.equal(input('最大输出 token 数').getAttribute('aria-invalid'), null)
  } finally { await view.destroy() }
})

test('disabled forms keep all mutating controls disabled', async () => {
  const initial = { text_api: { mode: 'standard', reasoning: { enabled: true, default_level: 'medium', levels: [{ level: 'medium', api_value: 'medium' }] } } }
  const view = await mount(initial, 'responses', true)
  try {
    for (const label of ['最大输入 token 数', '输出模式', '最大输出 token 数', '图片', '启用推理等级', '推理档位 1', 'API 参数值 1', '默认档位']) assert.equal(input(label).disabled, true, label)
    assert.equal(button('添加档位').disabled, true)
    assert.equal(button('删除推理档位 1').disabled, true)
    assert.deepEqual(view.changes, [])
  } finally { await view.destroy() }
})

const discovered = {
  limits: { budget_mode: 'separate' as const, input_tokens: 1_048_576, output_tokens: 65_536, output_includes_reasoning: true },
  source: 'provider' as const, fetched_at: '2026-11-10T00:00:00Z',
  scope: { base_url: 'https://provider.invalid/v1', protocol: 'responses', remote_id: 'gemini' },
}

test('capability limits are distinct from the preserved legacy 65536 request cap and manual values can restore discovery', async () => {
  const initial = { text_api: { mode: 'standard', max_output_tokens: 65_536 }, text_capabilities: { version: 1, discovered } }
  const view = await mount(initial)
  try {
    assert.equal(input('输出模式').value, '固定额度')
    assert.equal(input('最大输入 token 数').value, '1,048,576')
    assert.equal(input('模型最大输出 token 数').value, '65.536K')
    assert.equal(input('最大输出 token 数').value, '65.536K')
    assert.match(view.container.textContent!, /来源：提供商目录/)
    assert.deepEqual(view.changes, [])
    await fill('模型最大输出 token 数', '128K')
    assert.deepEqual((view.settings().text_capabilities as any).discovered, discovered)
    assert.equal((view.settings().text_capabilities as any).override.output_tokens, 128_000)
    assert.equal(api(view.settings()).max_output_tokens, 65_536)
    await act(() => button('恢复发现值').click())
    assert.equal((view.settings().text_capabilities as any).override, undefined)
    assert.equal(input('模型最大输出 token 数').value, '65.536K')
    assert.equal(api(view.settings()).max_output_tokens, 65_536)
  } finally { await view.destroy() }
})

test('auto and upstream remain distinct while switching modes preserves a reusable fixed value', async () => {
  const view = await mount({ text_api: { mode: 'standard', max_output_tokens: 65_536 }, text_capabilities: { version: 1, discovered } })
  try {
    await choose('输出模式', '自动安排')
    assert.equal(api(view.settings()).output_mode, 'auto')
    assert.equal(api(view.settings()).max_output_tokens, 65_536)
    assert.equal(input('最大输出 token 数').disabled, true)
    assert.match(view.container.querySelector('.harness-text-output-summary')!.textContent!, /计算并发送输出额度/)
    assert.equal((resolveTextApiSettings(view.settings(), 'responses').request_template as Settings).max_output_tokens, undefined)
    await choose('输出模式', '沿用服务默认')
    assert.equal(api(view.settings()).output_mode, 'upstream')
    assert.match(view.container.querySelector('.harness-text-output-summary')!.textContent!, /不发送输出参数/)
    await choose('输出模式', '固定额度')
    assert.equal(input('最大输出 token 数').disabled, false)
    assert.equal((resolveTextApiSettings(view.settings(), 'responses').request_template as Settings).max_output_tokens, 65_536)
  } finally { await view.destroy() }
})

test('invalid capability drafts remain editable and fixed requests exceeding a known limit show a conflict', async () => {
  const view = await mount({ text_api: { mode: 'standard', max_output_tokens: 65_536 }, text_capabilities: { version: 1, discovered } })
  try {
    await fill('模型最大输出 token 数', '8K')
    assert.match(view.container.textContent!, /固定最大输出超过已配置的模型生成上限/)
    assert.equal(api(view.settings()).max_output_tokens, 65_536)
    await fill('模型最大输出 token 数', '1Q')
    assert.equal(input('模型最大输出 token 数').value, '1Q')
    assert.equal(input('模型最大输出 token 数').disabled, false)
    assert.match(view.container.textContent!, /能力上限必须为正整数/)
    await fill('模型最大输出 token 数', '128K')
    assert.doesNotMatch(view.container.textContent!, /能力上限必须为正整数/)
    assert.equal(api(view.settings()).max_output_tokens, 65_536)
  } finally { await view.destroy() }
})

test('Anthropic offers auto or fixed only and channel token counting is an explicit protocol-specific option', async () => {
  const view = await mount({ text_api: { mode: 'standard' } }, 'anthropic_messages')
  try {
    await act(() => input('输出模式').click())
    const dropdown = document.getElementById(input('输出模式').getAttribute('aria-controls') || '')!
    assert.deepEqual([...dropdown.querySelectorAll('[role="option"]')].map(node => node.textContent), ['自动安排', '固定额度'])
    await act(() => input('输出模式').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await choose('输出模式', '自动安排')
    assert.equal(api(view.settings()).output_mode, 'auto')
    await choose('渠道输入计数', 'Messages 输入计数')
    assert.equal(view.settings().text_token_counter, 'anthropic_messages')
    await act(() => input('渠道输入计数').click())
    const options = document.getElementById(input('渠道输入计数').getAttribute('aria-controls') || '')!
    const mismatched = [...options.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === 'Responses 输入计数')!
    await act(() => mismatched.click())
    assert.equal(view.settings().text_token_counter, 'anthropic_messages')
  } finally { await view.destroy() }
})

test('a stale discovery cannot force a recognized legacy template into read-only custom mode after changing channel', async () => {
  const initial = { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 65_536 },
    text_paths: ['output_text', 'output'], text_capabilities: { version: 1, discovered: { ...discovered, limits: { budget_mode: 'unknown', output_tokens: 8192 } } } }
  const view = await mount(initial, 'responses', false, { ...discovered.scope, base_url: 'https://other.invalid/v1' })
  try {
    assert.equal(input('输出模式').value, '固定额度')
    assert.equal(input('最大输出 token 数').disabled, false)
    assert.match(view.container.textContent!, /原目录能力暂不适用/)
    await fill('最大输出 token 数', '128K')
    assert.equal(api(view.settings()).max_output_tokens, 128_000)
    assert.equal((view.settings().text_capabilities as any).discovered, undefined)
  } finally { await view.destroy() }
})

test('Messages thinking mode exposes fixed budgets and keeps adaptive and effort wire parameters distinct', async () => {
  const view = await mount({ text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8000,
    reasoning: { enabled: true, default_level: 'medium', levels: [{ level: 'medium', api_value: 'medium' }] } } }, 'anthropic_messages')
  try {
    await choose('推理方式', '固定思考预算')
    await fill('思考预算 token 数', '2K')
    assert.equal(api(view.settings()).reasoning.mode, 'fixed')
    assert.equal(api(view.settings()).reasoning.budget_tokens, 2000)
    assert.equal(textApiConfigError(view.settings(), 'anthropic_messages'), null)
    let body = resolveTextApiSettings(view.settings(), 'anthropic_messages').request_template as any
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2000 }); assert.equal(body.output_config, undefined)
    assert.equal(document.querySelector('[aria-label="推理档位 1"]'), null)
    await choose('推理方式', '自适应思考 + 强度档位')
    assert.equal(api(view.settings()).reasoning.budget_tokens, undefined)
    body = resolveTextApiSettings(view.settings(), 'anthropic_messages').request_template as any
    assert.deepEqual(body.thinking, { type: 'adaptive' }); assert.deepEqual(body.output_config, { effort: 'medium' })
    await choose('推理方式', '仅强度档位')
    body = resolveTextApiSettings(view.settings(), 'anthropic_messages').request_template as any
    assert.equal(body.thinking, undefined); assert.deepEqual(body.output_config, { effort: 'medium' })
    await act(() => input('启用推理等级').click())
    assert.equal(api(view.settings()).reasoning.enabled, false)
    body = resolveTextApiSettings(view.settings(), 'anthropic_messages').request_template as any
    assert.equal(body.thinking, undefined); assert.equal(body.output_config, undefined)
    assert.deepEqual(api(view.settings()).reasoning.levels, [{ level: 'medium', api_value: 'medium' }])
  } finally { await view.destroy() }
})
