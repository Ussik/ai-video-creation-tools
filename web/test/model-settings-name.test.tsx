import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider } from '../src/shared/api/api'
import { resolveTextApiSettings, standardTextSettings } from '@video-studio/shared/models/text-api-settings'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: ModelSettings } = await import('../src/features/models/ModelSettings')
const { default: ModelAdvancedEditor } = await import('../src/features/models/ModelAdvancedEditor')
after(() => dom.window.close())

const provider = { id: 'provider-one', name: 'gpt-image', adapter: 'http', base_url: 'https://example.invalid/v1', has_key: true,
  enabled: true, auth_header: 'Authorization', auth_prefix: 'Bearer ', created_at: '2026-10-11T00:00:00Z' } as Provider
const model = { id: 'model-one', provider_id: provider.id, name: '图片模型', remote_id: 'image-model', modality: 'image',
  protocol: 'image_generations', settings: {}, enabled: true } as Model
function button(label: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.replace(/\s*\*$/, '') === label)
  assert.ok(node, label)
  return node
}
async function fillLabeledInput(label: string, value: string) {
  const field = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.replace(/\s*\*$/, '') === label)
  assert.ok(field, label)
  const input = document.getElementById(field.htmlFor) as HTMLInputElement
  assert.ok(input)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function ariaInput(label: string) {
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].find(node => node.getAttribute('aria-label') === label)
  assert.ok(input, label)
  return input
}
async function fillAriaInput(label: string, value: string) {
  const input = ariaInput(label)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function fillSettingsJson(value: Record<string, unknown>) {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="请求配置 JSON"]')
  assert.ok(textarea)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, JSON.stringify(value, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function imageAnalysisSwitch() {
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.startsWith('启用 Gemini 图片反推'))
  assert.ok(label)
  return document.getElementById(label.htmlFor) as HTMLInputElement
}
async function mountProvider(t: TestContext, fail = false, options: { provider?: Provider; models?: Model[]; catalog?: unknown[]; freshness?: { source: string; fetched_at: string; validated_at: string; expires_at: string } } = {}) {
  let stored = structuredClone(options.provider || provider)
  let storedModels = structuredClone(options.models || [model])
  const requests: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [], errors: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    requests.push({ url: String(url), method: init?.method, body })
    if (String(url) === '/api/providers/model-catalog/preview') return Response.json({ models: options.catalog || [], ...(options.freshness ? { freshness: options.freshness } : {}) })
    if (fail) return Response.json({ detail: '名称保存失败' }, { status: 503 })
    assert.equal(String(url), '/api/providers/provider-one/configuration')
    stored = { ...stored, ...body.provider as object }
    storedModels = body.models as Model[]
    return Response.json({ provider: stored, models: storedModels })
  })
  function Harness() {
    const [providers, setProviders] = useState([stored]), [models, setModels] = useState(storedModels), [busy, setBusy] = useState(false)
    return <MantineProvider env="test"><ModelSettings providers={providers} models={models} busy={busy}
      refresh={async () => { setProviders([{ ...stored }]); setModels(storedModels) }} action={async task => {
        setBusy(true)
        try { await task() } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
      }} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<Harness />))
  return { container, requests, errors, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

async function mountAdvanced(t: TestContext, modelSettings = model.settings, configuredModel = model) {
  const requests: string[] = [], applied: Model[] = [], errors: string[] = []
  t.mock.method(globalThis, 'fetch', async url => { requests.push(String(url)); throw new Error('Advanced editing must not persist over the network') })
  function Harness() {
    const [current, setCurrent] = useState({ ...configuredModel, settings: modelSettings }), [open, setOpen] = useState(true)
    return <MantineProvider env="test">{open
      ? <ModelAdvancedEditor model={current} provider={provider} onApply={next => { applied.push(next); setCurrent(next) }} onClose={() => setOpen(false)} />
      : <button onClick={() => setOpen(true)}>重新打开高级设置</button>}</MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<Harness />))
  return { container, requests, applied, errors, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('renaming a provider saves the complete card once and refreshes its heading', async t => {
  const view = await mountProvider(t)
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await fillLabeledInput('显示名称', '  映画工坊  ')
    await act(async () => button('保存').click())
    assert.equal(view.requests.length, 1)
    assert.equal(view.requests[0].url, '/api/providers/provider-one/configuration')
    assert.equal(view.requests[0].method, 'PUT')
    assert.equal((view.requests[0].body.provider as Provider).name, '映画工坊')
    assert.equal((view.requests[0].body.provider as Provider).base_url, provider.base_url)
    assert.equal((view.requests[0].body.models as Model[])[0].id, model.id)
    assert.equal(view.container.querySelector('.hp-provider-name strong')!.textContent, '映画工坊')
    assert.equal(view.container.querySelector('.hp-editor'), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('blank names cannot be saved and cancelling a rename makes no request', async t => {
  const view = await mountProvider(t)
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await fillLabeledInput('显示名称', '   ')
    assert.equal(button('保存').disabled, true)
    await fillLabeledInput('显示名称', '未保存名称')
    await act(() => button('取消', view.container.querySelector('.hp-editor')!).click())
    assert.equal(view.container.querySelector('.hp-provider-name strong')!.textContent, provider.name)
    assert.deepEqual(view.requests, [])
  } finally { await view.destroy() }
})

test('failed provider renames retain the draft and leave the displayed name unchanged', async t => {
  const view = await mountProvider(t, true)
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await fillLabeledInput('显示名称', '待重试名称')
    await act(async () => button('保存').click())
    assert.deepEqual(view.errors, ['名称保存失败'])
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === '显示名称')!
    assert.equal((document.getElementById(label.htmlFor) as HTMLInputElement).value, '待重试名称')
    assert.equal(view.container.querySelector('.hp-provider-name strong')!.textContent, provider.name)
    assert.equal(button('保存').disabled, false)
  } finally { await view.destroy() }
})

const textModel: Model = { ...model, id: 'text-one', name: '文本模型', remote_id: 'text-model', modality: 'text',
  protocol: 'chat_completions', settings: standardTextSettings('chat_completions') }

test('renaming a legacy provider with no stored protocol does not persist its inferred protocol or rewrite model contracts', async t => {
  const settings = { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 32768 },
    text_paths: ['output_text', 'output'], headers: { 'X-Legacy': 'keep' }, custom: { preserved: true } }
  const legacyModel: Model = { ...textModel, protocol: 'responses', settings }
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: null }, models: [legacyModel] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    const protocolLabel = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === 'API 协议')!
    assert.equal((document.getElementById(protocolLabel.htmlFor) as HTMLInputElement).value, 'OpenAI Responses')
    await fillLabeledInput('显示名称', '旧提供商新名称')
    await act(() => button('保存').click())
    assert.deepEqual(view.errors, [])
    assert.equal(view.requests.length, 1)
    assert.equal(view.requests[0].method, 'PUT')
    assert.deepEqual(view.requests[0].body.provider, { name: '旧提供商新名称', base_url: provider.base_url, enabled: true })
    assert.equal(Object.hasOwn(view.requests[0].body.provider as object, 'protocol'), false)
    const saved = (view.requests[0].body.models as Model[])[0]
    assert.equal(saved.protocol, legacyModel.protocol)
    assert.deepEqual(saved.settings, settings)
  } finally { await view.destroy() }
})

test('advanced model changes and credentials remain local drafts until the provider card is saved', async t => {
  const view = await mountProvider(t)
  try {
    await act(() => button('编辑 gpt-image').click())
    await fillAriaInput('API 密钥', 'unsaved-secret')
    await act(() => button('自定义设置').click())
    await fillAriaInput('显示名称 1', '未保存图片模型')
    await act(() => button('模型选项 1').click())
    await act(() => button('图片模型设置').click())
    await act(() => imageAnalysisSwitch().click())
    await fillLabeledInput('分析模型 ID', 'gemini-unsaved')
    await act(() => button('保存模型').click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(view.requests, [])
    await act(() => button('取消', view.container.querySelector('.hp-editor')!).click())
    await act(() => button('编辑 gpt-image').click())
    assert.equal(ariaInput('API 密钥').value, '')
    await act(() => button('自定义设置').click())
    assert.equal(ariaInput('显示名称 1').value, model.name)
    await act(() => button('模型选项 1').click())
    await act(() => button('图片模型设置').click())
    assert.equal(imageAnalysisSwitch().checked, false)
    assert.deepEqual(view.requests, [])
  } finally { await view.destroy() }
})

test('one atomic provider save applies managed text fields and preserves media and custom model settings', async t => {
  const customSettings = { request_path: 'vendor/generate', request_template: { model: '{{model}}', prompt: { text: '{{prompt}}' } },
    text_path: 'result.answer', stream_request_template: { messages: '{{messages}}', vendor_flag: true },
    api_base_url: 'https://custom.invalid/api', headers: { 'X-Vendor': 'keep' }, pricing: { per_generation: .2 }, custom_flag: { keep: true } }
  const custom: Model = { ...textModel, id: 'custom-one', remote_id: 'custom-model', name: '自定义文本模型', settings: customSettings }
  const image: Model = { ...model, settings: { request_path: 'custom/images', request_template: { model: '{{model}}', prompt: '{{prompt}}', content: [{ url: '{{image}}' }] }, image_url_path: 'result.url', headers: { 'X-Image': 'keep' }, pricing: { per_image: .3 }, custom_image: ['keep'] } }
  const video: Model = { ...model, id: 'video-one', remote_id: 'video-model', name: '视频模型', modality: 'video', protocol: 'async_video', settings: {
    create_path: 'contents/generations/tasks', get_path: 'contents/generations/tasks/{id}',
    request_template: { model: '{{model}}', content: '{{content}}' }, content_template: [{ type: 'text', text: '{{prompt}}' }],
    id_path: 'id', status_path: 'status', result_path: 'content.video_url', custom_video: { keep: true }, pricing: { per_second: .1 } } }
  const originals = [textModel, custom, image, video], snapshot = structuredClone(originals)
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'chat_completions' }, models: originals })
  try {
    await act(() => button('编辑 gpt-image').click())
    await fillAriaInput('API 密钥', 'new-key')
    await act(() => button('自定义设置').click())
    await fillLabeledInput('显示名称', '新提供商')
    await fillLabeledInput('API 地址', 'https://new.invalid/v1')
    await choose('API 协议', 'OpenAI Responses')
    await act(() => button('模型选项 1').click())
    await choose('容量计算方式', '输入与输出共享上下文')
    await fillLabeledInput('上下文窗口', '1M')
    await choose('输出模式', '固定额度')
    await fillLabeledInput('最大输出 token 数', '64K')
    await fillAriaInput('显示名称 1', '主力文本模型')
    assert.deepEqual(view.requests, [])
    await act(() => button('保存').click())
    assert.deepEqual(view.errors, [])
    assert.equal(view.requests.length, 1)
    const request = view.requests[0]
    assert.equal(request.url, '/api/providers/provider-one/configuration')
    assert.equal(request.method, 'PUT')
    assert.deepEqual(request.body.provider, { name: '新提供商', base_url: 'https://new.invalid/v1', protocol: 'responses', enabled: true, api_key: 'new-key' })
    const saved = request.body.models as Model[]
    assert.equal(saved[0].name, '主力文本模型')
    assert.equal(saved[0].protocol, 'responses')
    assert.equal((saved[0].settings.text_capabilities as any).override.context_tokens, 1_000_000)
    assert.equal((resolveTextApiSettings(saved[0].settings, saved[0].protocol).request_template as Record<string, unknown>).max_output_tokens, 64_000)
    assert.equal(saved[1].protocol, custom.protocol)
    assert.deepEqual(saved[1].settings, customSettings)
    assert.deepEqual(saved[2].settings, image.settings)
    assert.deepEqual(saved[3].settings, video.settings)
    for (const row of saved) {
      assert.equal('local_id' in row, false)
      assert.equal('inherit' in row, false)
    }
    assert.deepEqual(originals, snapshot)
    assert.equal(view.container.querySelector('.hp-editor'), null)
  } finally { await view.destroy() }
})

test('a swallowed action failure still appears inside the provider card and retains model and credential drafts', async t => {
  const view = await mountProvider(t, true, { models: [textModel] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await fillAriaInput('API 密钥', 'key-for-retry')
    await act(() => button('自定义设置').click())
    await fillAriaInput('模型 ID 1', 'retry-model')
    await fillAriaInput('显示名称 1', '重试模型')
    await act(() => button('模型选项 1').click())
    await choose('输出模式', '固定额度')
    await fillLabeledInput('最大输出 token 数', '32K')
    await act(() => button('保存').click())
    assert.equal(view.requests.length, 1)
    assert.deepEqual(view.errors, ['名称保存失败'])
    assert.match(view.container.querySelector('.hp-editor [role="alert"]')!.textContent!, /名称保存失败/)
    assert.equal(ariaInput('API 密钥').value, 'key-for-retry')
    assert.equal(ariaInput('模型 ID 1').value, 'retry-model')
    assert.equal(ariaInput('显示名称 1').value, '重试模型')
    const outputLabel = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.replace(/\s*\*$/, '') === '最大输出 token 数')!
    assert.equal((document.getElementById(outputLabel.htmlFor) as HTMLInputElement).value, '32K')
    assert.equal(button('保存').disabled, false)
    assert.equal(view.container.querySelector('.hp-provider-name strong')!.textContent, provider.name)
  } finally { await view.destroy() }
})

test('turning an inherited standard model into a custom contract detaches it from later provider protocol changes', async t => {
  const customSettings = { text_api: { mode: 'custom' }, request_path: 'vendor/custom-generate',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: { prompt: '{{prompt}}' } }], vendor: { contract: true } },
    stream_request_template: { model: '{{model}}', special_input: '{{prompt}}', max_tokens: 12345 },
    text_path: 'vendor.answer', custom_marker: { keep: true } }
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'chat_completions' }, models: [textModel] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await act(() => button('模型选项 1').click())
    assert.equal([...document.querySelectorAll('label')].some(label => label.textContent === '此模型 API 协议'), false)
    await act(() => button('高级设置').click())
    await choose('接口配置方式', '自定义接口 · 高级配置')
    await fillSettingsJson(customSettings)
    await act(() => button('保存模型').click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal([...document.querySelectorAll('label')].some(label => label.textContent === '此模型 API 协议'), true)
    await choose('API 协议', 'OpenAI Responses')
    assert.deepEqual(view.requests, [])
    await act(() => button('保存').click())
    assert.deepEqual(view.errors, [])
    assert.equal(view.requests.length, 1)
    assert.equal((view.requests[0].body.provider as Provider).protocol, 'responses')
    const saved = (view.requests[0].body.models as Model[])[0]
    assert.equal(saved.protocol, 'chat_completions')
    assert.deepEqual(saved.settings, customSettings)
  } finally { await view.destroy() }
})

test('provider name and key edits preserve untouched incomplete, invalid and legacy model settings verbatim', async t => {
  const oldModels: Model[] = [
    { ...textModel, id: 'disabled-incomplete', name: '', remote_id: 'disabled-incomplete', protocol: 'anthropic_messages', enabled: false,
      settings: { text_api: { mode: 'standard' }, old_incomplete: true } },
    { ...textModel, id: 'invalid-legacy', remote_id: 'invalid-legacy',
      settings: { text_api: { mode: 'standard', max_output_tokens: -1 }, context_window_tokens: 0, historical: { keep: true } } },
    { ...textModel, id: 'legacy-template', remote_id: 'legacy-template', settings: {
      request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], max_tokens: 8192 },
      text_path: 'choices.0.message.content', headers: { 'X-Historical': 'keep' }, pricing: { per_million_input_tokens: 1 } } },
    { ...model, id: 'disabled-image', remote_id: 'disabled-image', enabled: false, settings: { image_api_profile: 'documented_images', historical: true } },
  ]
  const before = structuredClone(oldModels)
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'chat_completions' }, models: oldModels })
  try {
    await act(() => button('编辑 gpt-image').click())
    await fillAriaInput('API 密钥', 'rotated-key')
    await act(() => button('自定义设置').click())
    await fillLabeledInput('显示名称', '只修改提供商')
    await act(() => button('保存').click())
    assert.deepEqual(view.errors, [])
    assert.equal(view.requests.length, 1)
    assert.equal(view.requests[0].method, 'PUT')
    assert.deepEqual(view.requests[0].body.provider, { name: '只修改提供商', base_url: provider.base_url, protocol: 'chat_completions', enabled: true, api_key: 'rotated-key' })
    const saved = view.requests[0].body.models as Model[]
    assert.deepEqual(saved.map(row => row.settings), before.map(row => row.settings))
    assert.deepEqual(saved.map(row => row.protocol), before.map(row => row.protocol))
    assert.deepEqual(saved.map(row => row.enabled), before.map(row => row.enabled))
    assert.deepEqual(oldModels, before)
    assert.equal(view.container.querySelector('.hp-editor'), null)
  } finally { await view.destroy() }
})

test('new text models inherit the selected provider protocol while custom models keep their overrides', async t => {
  const custom: Model = { ...textModel, id: 'custom-one', remote_id: 'custom-model', name: '自定义模型',
    settings: { request_path: 'vendor/generate', request_template: { input: { prompt: '{{prompt}}' } }, text_path: 'result.text', custom: true } }
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'chat_completions' }, models: [textModel, custom] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await choose('API 协议', 'OpenAI Responses')
    await act(() => button('添加模型').click())
    await fillAriaInput('模型 ID 3', 'new-responses-model')
    await fillAriaInput('显示名称 3', '新模型')
    assert.deepEqual(view.requests, [])
    await act(() => button('保存').click())
    assert.deepEqual(view.errors, [])
    const saved = view.requests[0].body.models as Model[]
    assert.deepEqual(saved.map(row => row.protocol), ['responses', 'chat_completions', 'responses'])
    assert.deepEqual(saved[1].settings, custom.settings)
    assert.equal('id' in saved[2], false)
    assert.equal(resolveTextApiSettings(saved[2].settings, saved[2].protocol).request_path, 'responses')
  } finally { await view.destroy() }
})

test('keyboard sorting and model deletion only change the draft and save the final order atomically', async t => {
  const models = [textModel, { ...textModel, id: 'text-two', name: '第二模型', remote_id: 'two' },
    { ...textModel, id: 'text-three', name: '第三模型', remote_id: 'three' }]
  const view = await mountProvider(t, false, { models })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await act(() => button('调整模型顺序 3').dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' })))
    assert.equal(ariaInput('模型 ID 2').value, 'three')
    await act(() => button('删除模型 1').click())
    assert.equal(ariaInput('模型 ID 1').value, 'three')
    assert.equal(ariaInput('模型 ID 2').value, 'two')
    assert.deepEqual(view.requests, [])
    await act(() => button('保存').click())
    assert.deepEqual(view.errors, [])
    assert.equal(view.requests.length, 1)
    assert.deepEqual((view.requests[0].body.models as Model[]).map(row => row.id), ['text-three', 'text-two'])
  } finally { await view.destroy() }
})

test('catalog preview uses current draft connection and adding selected models never saves configuration', async t => {
  const view = await mountProvider(t, false, { models: [textModel], catalog: [
    { remote_id: textModel.remote_id, name: textModel.name, modality_hint: 'text', existing: true },
    { remote_id: 'catalog-text', name: '目录文本模型', modality_hint: 'text', existing: false },
    { remote_id: 'catalog-image', name: '目录图片模型', modality_hint: 'image', existing: false },
  ] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await fillAriaInput('API 密钥', 'preview-key')
    await act(() => button('自定义设置').click())
    await fillLabeledInput('API 地址', 'https://draft.invalid/v1')
    await choose('API 协议', 'OpenAI Responses')
    await act(() => button('获取可用模型').click())
    assert.equal(view.requests.length, 1)
    assert.deepEqual(view.requests[0], { url: '/api/providers/model-catalog/preview', method: 'POST', body: {
      provider_id: provider.id, base_url: 'https://draft.invalid/v1', api_key: 'preview-key', protocol: 'responses' } })
    assert.equal(ariaInput(`选择 ${textModel.remote_id}`).disabled, true)
    await act(() => ariaInput('选择 catalog-text').click())
    await act(() => ariaInput('选择 catalog-image').click())
    await act(() => button('添加所选模型').click())
    assert.equal(ariaInput('模型 ID 2').value, 'catalog-text')
    assert.equal(ariaInput('模型 ID 3').value, 'catalog-image')
    assert.equal(view.requests.length, 1)
    await act(() => button('取消', view.container.querySelector('.hp-editor')!).click())
    assert.equal(view.requests.length, 1)
    assert.equal(view.container.querySelector('.hp-editor'), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('Seedance 2.5 preset replaces obsolete video payloads while retaining model identity, connection and pricing', async t => {
  const settings = {
    api_base_url: 'https://video-provider.invalid/api/v3', headers: { 'X-Route': 'video' }, pricing: { per_second: 0.08, currency: '¥' },
    request_templates: { reference: { prompt: '{{prompt}}' } },
    mode_variables: { reference: { resolution: '4k' } }, draft_variables: { resolution: '720p' },
    video_reference_profile: 'seedance_2_0', max_reference_images: 9,
  }
  const video = { ...model, name: '我的视频模型', remote_id: 'my-video-endpoint', modality: 'video' as const, protocol: 'async_video' as const }
  const view = await mountAdvanced(t, settings, video)
  try {
    await choose('视频接口配置', 'Seedance 2.5 · 异步任务')
    await act(async () => button('保存模型').click())
    assert.equal(view.applied.length, 1)
    assert.equal(view.requests.length, 0)
    const body = view.applied[0]
    assert.equal(body.provider_id, video.provider_id)
    assert.equal(body.remote_id, video.remote_id)
    const saved = body.settings as Record<string, unknown>
    assert.equal(saved.video_reference_profile, 'seedance_2_5')
    assert.equal(saved.max_reference_images, 30)
    assert.equal(saved.default_resolution, '720p')
    assert.deepEqual(saved.resolutions, ['480p', '720p', '1080p'])
    assert.deepEqual(saved.supported_modes, ['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend'])
    assert.equal(saved.request_templates, undefined)
    assert.deepEqual(saved.draft_variables, { resolution: '480p' })
    assert.equal(saved.api_base_url, settings.api_base_url)
    assert.deepEqual(saved.headers, settings.headers)
    assert.deepEqual(saved.pricing, settings.pricing)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

async function choose(label: string, option: string) {
  const node = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === label)
  assert.ok(node, label)
  const input = document.getElementById(node.htmlFor) as HTMLInputElement
  assert.ok(input)
  await act(() => input.click())
  const choice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === option)
  assert.ok(choice, option)
  await act(() => choice.click())
}

test('Doubao video format can be explicitly enabled for Responses while preserving unrelated model settings', async t => {
  const settings = { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' },
    text_path: 'output.0.content.0.text', supports_vision: true, pricing: { per_generation: 0.02, per_million_input_tokens: 3, currency: '¥' } }
  const textModel = { ...model, name: '豆包文本模型', remote_id: 'my-text-endpoint', modality: 'text' as const, protocol: 'responses' as const }
  const view = await mountAdvanced(t, settings, textModel)
  try {
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.startsWith('支持视频理解'))!
    assert.ok(label)
    let checkbox = document.getElementById(label.htmlFor) as HTMLInputElement
    assert.equal(checkbox.disabled, true)
    assert.equal(checkbox.checked, false)
    await choose('视频输入格式', '豆包视频理解 · Chat / Responses')
    checkbox = document.getElementById(label.htmlFor) as HTMLInputElement
    assert.equal(checkbox.disabled, false)
    await act(() => checkbox.click())
    await act(async () => button('保存模型').click())
    assert.equal(view.applied.length, 1)
    assert.equal(view.requests.length, 0)
    const body = view.applied[0]
    assert.equal(body.protocol, 'responses')
    assert.equal(body.remote_id, textModel.remote_id)
    const saved = body.settings as Record<string, unknown>
    assert.equal(saved.video_input_format, 'doubao_ark')
    assert.equal(saved.supports_video, true)
    assert.equal(saved.supports_vision, true)
    assert.deepEqual(saved.request_template, settings.request_template)
    assert.deepEqual(saved.pricing, settings.pricing)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('image models apply the documented async form without changing model ID, provider or pricing', async t => {
  const settings = { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}' },
    image_url_path: 'data.0.url', ratios: ['1:1', '9:16'], default_ratio: '9:16', pricing: { per_image: 0.3, currency: '¥' } }
  const view = await mountAdvanced(t, settings)
  try {
    assert.equal(button('高级配置 · JSON').getAttribute('aria-expanded'), 'false')
    await choose('请求配置', 'Images API · 异步任务')
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(!dialog.textContent!.includes('直接返回图片'))
    assert.ok(!dialog.textContent!.includes('自动尺寸'))
    assert.ok(!document.querySelector('[role="dialog"]')!.textContent!.includes('RightAPI'))
    await act(async () => button('保存模型').click())
    assert.equal(view.applied.length, 1)
    assert.equal(view.requests.length, 0)
    const saved = view.applied[0]
    assert.equal(saved.id, model.id)
    assert.equal(saved.provider_id, provider.id)
    assert.equal(saved.remote_id, model.remote_id)
    const result = saved.settings as Record<string, unknown>
    assert.equal(result.api_base_url, 'https://example.invalid/draw/v1')
    assert.equal(result.image_task_base_url, 'https://example.invalid/v1')
    assert.equal(result.image_reference_path, 'images/edits')
    assert.equal(result.request_path, 'images/generations')
    assert.equal(result.async_image, true)
    assert.equal(result.get_path, 'tasks/{id}')
    assert.deepEqual(result.ratios, settings.ratios)
    assert.equal(result.default_ratio, settings.default_ratio)
    assert.deepEqual(result.pricing, settings.pricing)
    assert.deepEqual(result.request_template, { model: '{{model}}', prompt: '{{prompt}}', n: 1, size: '{{ratio}}', image: '{{images}}', async: true })
    assert.deepEqual((result.request_templates as Record<string, unknown>).reference, result.request_template)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('editing an existing nested image request leaves its custom payload and endpoint intact', async t => {
  const settings = { request_path: 'custom/image', api_base_url: 'https://image-provider.invalid/v2',
    request_template: { model: '{{model}}', prompt: '{{prompt}}', content: [{ type: 'image_url', url: '{{image}}' }] },
    image_url_path: 'result.url', custom_flag: true }
  const view = await mountAdvanced(t, settings)
  try {
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /已保留自定义请求/)
    assert.equal(button('高级配置 · JSON').getAttribute('aria-expanded'), 'false')
    await act(async () => button('保存模型').click())
    assert.deepEqual(view.applied[0].settings, settings)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('edits form uses repeated image files and pixel sizes; switching to generations restores JSON arrays', async t => {
  const settings = { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}' }, image_url_path: 'data.0.url' }
  const view = await mountAdvanced(t, settings)
  try {
    await choose('请求配置', 'Images API · 异步任务')
    await choose('参考图传递方式', '文件上传 · multipart')
    await choose('尺寸传递方式', '像素尺寸 · 例如 1280x720')
    await act(async () => button('保存模型').click())
    const saved = view.applied[0].settings as Record<string, unknown>
    assert.equal(saved.image_reference_path, 'images/edits')
    assert.equal(saved.image_reference_transport, 'multipart')
    assert.equal(saved.request_timeout_seconds, 600)
    assert.equal(saved.image_size_mode, 'pixels')
    assert.deepEqual(saved.ratios, ['1:1', '16:9', '9:16'])
    assert.equal((saved.request_template as Record<string, unknown>).image, '{{images}}')
    assert.equal((saved.request_template as Record<string, unknown>)['image[]'], undefined)
    await act(() => button('重新打开高级设置').click())
    await choose('请求配置', 'Images API · 异步任务')
    await choose('参考图传递方式', '文件上传 · multipart')
    await choose('参考图用途', '参考生成 · images/generations')
    assert.ok(!document.querySelector('[role="dialog"]')!.textContent!.includes('参考图传递方式'))
    await act(async () => button('保存模型').click())
    const generations = view.applied[1].settings as Record<string, unknown>
    assert.equal(generations.image_reference_path, 'images/generations')
    assert.equal(generations.image_reference_transport, 'json')
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('the form enables imageSize only explicitly and preserves an independent task API address', async t => {
  const view = await mountAdvanced(t)
  try {
    await choose('请求配置', 'Images API · 异步任务')
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.includes('通过 imageSize 传递清晰度'))!
    assert.ok(label)
    await act(() => label.click())
    await choose('默认清晰度', '4K')
    await act(() => button('连接与任务查询').click())
    const addressLabel = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === '任务查询 API 地址')!
    const input = document.getElementById(addressLabel.htmlFor) as HTMLInputElement
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://task-proxy.invalid/v1')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(async () => button('保存模型').click())
    const saved = view.applied[0].settings as Record<string, unknown>
    assert.equal(saved.image_clarity_parameter, true)
    assert.equal(saved.default_clarity, '4K')
    assert.equal((saved.request_template as Record<string, unknown>).imageSize, '{{clarity}}')
    assert.equal(saved.image_task_base_url, 'https://task-proxy.invalid/v1')
    assert.equal(saved.api_base_url, 'https://example.invalid/draw/v1')
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('native video understanding applies as a draft independently of vision', async t => {
  const textModel = { ...model, name: '复核文本模型', modality: 'text', protocol: 'chat_completions' } as Model
  const settings = { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' }
  const view = await mountAdvanced(t, settings, textModel)
  try {
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.startsWith('支持视频理解'))!
    assert.ok(label)
    const input = document.getElementById(label.htmlFor) as HTMLInputElement
    assert.equal(input.checked, false)
    assert.equal(input.disabled, false)
    await act(() => label.click())
    await act(async () => button('保存模型').click())
    const saved = view.applied[0].settings as Record<string, unknown>
    assert.equal(saved.supports_video, true)
    assert.equal(saved.supports_vision, undefined)
  } finally { await view.destroy() }
})

test('Responses models require an explicit Doubao format before enabling native video input', async t => {
  const textModel = { ...model, name: '图片理解模型', modality: 'text', protocol: 'responses' } as Model
  const view = await mountAdvanced(t, { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_paths: ['output_text'] }, textModel)
  try {
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.startsWith('支持视频理解'))!
    assert.equal((document.getElementById(label.htmlFor) as HTMLInputElement).disabled, true)
  } finally { await view.destroy() }
})

test('Gemini analysis is explicitly enabled on image models while preserving generation settings and identity', async t => {
  const settings = { request_path: 'custom/images', request_template: { model: '{{model}}', prompt: '{{prompt}}', size: '{{ratio}}' },
    api_base_url: 'https://images.invalid/draw/v1', image_url_path: 'data.0.url',
    headers: { 'X-Route': 'existing' }, pricing: { per_image: 0.5, currency: '¥' } }
  const nano = { ...model, name: 'Nano Banana', remote_id: 'nano-banana-fast' }
  const view = await mountAdvanced(t, settings, nano)
  try {
    assert.equal(imageAnalysisSwitch().checked, false, 'model name never enables analysis')
    assert.ok(![...document.querySelectorAll('label')].some(label => label.textContent === '分析 API 地址'))
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /GPT Image 生图接口只返回图片/)
    await act(() => imageAnalysisSwitch().click())
    assert.equal(imageAnalysisSwitch().checked, true)
    await fillLabeledInput('分析 API 地址', 'https://gemini.invalid/v1beta')
    await fillLabeledInput('分析模型 ID', 'gemini-2.5-flash-image')
    await fillLabeledInput('分析请求路径', 'models/{model}:generateContent')
    await act(async () => button('保存模型').click())
    assert.equal(view.applied.length, 1)
    assert.equal(view.requests.length, 0)
    assert.equal(view.applied[0].remote_id, nano.remote_id)
    assert.equal(view.applied[0].provider_id, nano.provider_id)
    assert.equal(view.applied[0].protocol, 'image_generations')
    assert.deepEqual(view.applied[0].settings, { ...settings, image_analysis: { enabled: true,
      protocol: 'gemini_generate_content', api_base_url: 'https://gemini.invalid/v1beta', remote_id: 'gemini-2.5-flash-image',
      request_path: 'models/{model}:generateContent' } })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('analysis overrides can be cleared or disabled without losing the image endpoint or saved analysis model', async t => {
  const image_analysis = { enabled: true, protocol: 'gemini_generate_content',
    remote_id: 'gemini-2.5-flash-image', api_base_url: 'https://gemini.invalid/v1beta', request_path: 'models/{model}:generateContent' }
  const settings = { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' },
    image_url_path: 'data.0.url', image_analysis }
  const view = await mountAdvanced(t, settings)
  try {
    await fillLabeledInput('分析 API 地址', '')
    await fillLabeledInput('分析请求路径', '')
    await act(() => imageAnalysisSwitch().click())
    assert.equal(imageAnalysisSwitch().checked, false)
    await act(async () => button('保存模型').click())
    assert.deepEqual(view.applied[0].settings, { ...settings,
      image_analysis: { enabled: false, protocol: 'gemini_generate_content', remote_id: image_analysis.remote_id } })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('invalid analysis addresses fail locally without submitting model changes', async t => {
  const view = await mountAdvanced(t, { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' }, image_url_path: 'data.0.url' })
  try {
    await act(() => imageAnalysisSwitch().click())
    await fillLabeledInput('分析 API 地址', 'file:///tmp/private')
    await act(async () => button('保存模型').click())
    assert.equal(view.applied.length, 0)
    assert.equal(view.requests.length, 0)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /图片反推 API 地址必须/)
  } finally { await view.destroy() }
})

const capabilityDiscovery = {
  limits: { budget_mode: 'separate', input_tokens: 1_000_000, output_tokens: 128_000 }, source: 'provider', fetched_at: '2026-11-10T00:00:00Z',
  scope: { base_url: provider.base_url, protocol: 'responses', remote_id: 'text-model' },
}

test('catalog capability refresh preserves manual overrides, fixed output and custom templates until the provider is saved', async t => {
  const initial = { ...textModel, protocol: 'responses' as const, settings: {
    text_api: { mode: 'standard', max_output_tokens: 65_536 },
    text_capabilities: { version: 1, discovered: { ...capabilityDiscovery, limits: { ...capabilityDiscovery.limits, output_tokens: 65_536 } }, override: { output_tokens: 100_000 } },
    custom_setting: { keep: true },
  } }
  const custom = { ...textModel, id: 'custom', remote_id: 'custom', protocol: 'responses' as const, settings: {
    text_api: { mode: 'custom' }, request_path: 'custom/generate', request_template: { prompt: '{{prompt}}', max_tokens: 65_536 },
    stream_request_template: { prompt: '{{prompt}}', max_tokens: 32_768 }, text_path: 'answer', context_window_tokens: 1_000_000,
  } }
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'responses' }, models: [initial, custom], catalog: [
    { remote_id: initial.remote_id, name: initial.name, modality_hint: 'text', existing: true, capabilities: capabilityDiscovery },
    { remote_id: custom.remote_id, name: custom.name, modality_hint: 'text', existing: true, capabilities: { ...capabilityDiscovery, scope: { ...capabilityDiscovery.scope, remote_id: 'custom' } } },
  ] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await act(() => button('获取可用模型').click())
    assert.equal(view.requests.length, 1)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /已更新 2 个模型的目录能力草稿/)
    await act(() => button('关闭', document.querySelector('[role="dialog"]')!).click())
    await act(() => button('模型选项 1').click())
    const maxLabel = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === '模型最大输出 token 数')!
    assert.equal((document.getElementById(maxLabel.htmlFor) as HTMLInputElement).value, '100K')
    await act(() => button('保存').click())
    assert.equal(view.requests.length, 2)
    const saved = view.requests[1].body.models as Model[]
    assert.deepEqual((saved[0].settings.text_capabilities as any).discovered, capabilityDiscovery)
    assert.deepEqual((saved[0].settings.text_capabilities as any).override, { output_tokens: 100_000 })
    assert.deepEqual(saved[0].settings.text_api, initial.settings.text_api)
    assert.deepEqual(saved[1].settings.request_template, custom.settings.request_template)
    assert.deepEqual(saved[1].settings.stream_request_template, custom.settings.stream_request_template)
    assert.deepEqual((saved[1].settings.text_capabilities as any).override, { budget_mode: 'shared', context_tokens: 1_000_000 })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('cancelling a capability refresh discards discovered drafts and imports retain selected capability metadata', async t => {
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'responses' }, models: [{ ...textModel, protocol: 'responses' }], catalog: [
    { remote_id: textModel.remote_id, name: textModel.name, modality_hint: 'text', existing: true, capabilities: capabilityDiscovery },
    { remote_id: 'imported', name: '导入模型', modality_hint: 'text', existing: false, capabilities: { ...capabilityDiscovery, scope: { ...capabilityDiscovery.scope, remote_id: 'imported' } } },
  ] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await act(() => button('获取可用模型').click())
    await act(() => ariaInput('选择 imported').click())
    await act(() => button('添加所选模型').click())
    await act(() => button('取消', view.container.querySelector('.hp-editor')!).click())
    assert.equal(view.requests.length, 1)
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    assert.equal(view.container.querySelectorAll('.hp-model-row').length, 1)
    await act(() => button('获取可用模型').click())
    await act(() => ariaInput('选择 imported').click())
    await act(() => button('添加所选模型').click())
    await act(() => button('保存').click())
    const saved = (view.requests[2].body.models as Model[])[1]
    assert.deepEqual((saved.settings.text_capabilities as any).discovered, { ...capabilityDiscovery, scope: { ...capabilityDiscovery.scope, remote_id: 'imported' } })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('changing channel ignores stale discovery for validation while preserving manual capabilities and 65536 fixed output', async t => {
  const configured = { ...textModel, protocol: 'responses' as const, settings: {
    text_api: { mode: 'standard', max_output_tokens: 8192 },
    text_capabilities: { version: 1, discovered: { ...capabilityDiscovery, limits: { budget_mode: 'unknown', output_tokens: 8192 } }, override: { input_tokens: 1_000_000 } },
  } }
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'responses' }, models: [configured] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await fillLabeledInput('API 地址', 'https://other.invalid/v1')
    await act(() => button('模型选项 1').click())
    await fillLabeledInput('最大输出 token 数', '65536')
    await act(() => button('保存').click())
    assert.deepEqual(view.errors, [])
    const saved = (view.requests[0].body.models as Model[])[0].settings
    assert.equal((saved.text_api as any).max_output_tokens, 65_536)
    assert.deepEqual(saved.text_capabilities, { version: 1, override: { input_tokens: 1_000_000 } })
  } finally { await view.destroy() }
})

test('provider catalog refresh preserves a model discovery bound to its independent API address', async t => {
  const independentDiscovery = { ...capabilityDiscovery, scope: { ...capabilityDiscovery.scope, base_url: 'https://independent.invalid/v1' } }
  const configured = { ...textModel, protocol: 'responses' as const, settings: {
    api_base_url: 'https://independent.invalid/v1/', text_api: { mode: 'standard', max_output_tokens: 65_536 },
    text_capabilities: { version: 1, discovered: independentDiscovery },
  } }
  const view = await mountProvider(t, false, { provider: { ...provider, protocol: 'responses' }, models: [configured], catalog: [
    { remote_id: configured.remote_id, name: configured.name, modality_hint: 'text', existing: true, capabilities: capabilityDiscovery },
  ] })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await act(() => button('获取可用模型').click())
    assert.doesNotMatch(document.querySelector('[role="dialog"]')!.textContent!, /已更新 1 个模型/)
    await act(() => button('关闭', document.querySelector('[role="dialog"]')!).click())
    await act(() => button('保存').click())
    assert.deepEqual((view.requests[1].body.models as Model[])[0].settings.text_capabilities, configured.settings.text_capabilities)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('catalog freshness is visible and explicit refresh only changes preview drafts', async t => {
  const view = await mountProvider(t, false, { models: [textModel], catalog: [], freshness: {
    source: 'cache', fetched_at: '2026-11-10T01:00:00Z', validated_at: '2026-11-10T01:05:00Z', expires_at: '2026-11-10T01:10:00Z',
  } })
  try {
    await act(() => button('编辑 gpt-image').click())
    await act(() => button('自定义设置').click())
    await act(() => button('获取可用模型').click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /缓存目录.*更新于/)
    await act(() => button('重新获取目录').click())
    assert.equal(view.requests.length, 2)
    assert.equal(view.requests[1].body.refresh, true)
    assert.ok(view.requests.every(request => request.url === '/api/providers/model-catalog/preview'))
    await act(() => button('关闭', document.querySelector('[role="dialog"]')!).click())
    await act(() => button('取消', view.container.querySelector('.hp-editor')!).click())
    assert.ok(view.requests.every(request => request.url === '/api/providers/model-catalog/preview'), 'discarding a refreshed directory never persists provider/model changes')
  } finally { await view.destroy() }
})
