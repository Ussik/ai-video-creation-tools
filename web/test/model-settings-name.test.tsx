import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider } from '../src/shared/api/api'

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
after(() => dom.window.close())

const provider = { id: 'provider-one', name: 'gpt-image', adapter: 'http', base_url: 'https://example.invalid/v1', has_key: true,
  enabled: true, auth_header: 'Authorization', auth_prefix: 'Bearer ', created_at: '2026-10-11T00:00:00Z' } as Provider
const model = { id: 'model-one', provider_id: provider.id, name: '图片模型', remote_id: 'image-model', modality: 'image',
  protocol: 'image_generations', settings: {}, enabled: true } as Model
function button(label: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  assert.ok(node, label)
  return node
}
async function fillName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="提供商名称"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function fillLabeledInput(label: string, value: string) {
  const field = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === label)
  assert.ok(field, label)
  const input = document.getElementById(field.htmlFor) as HTMLInputElement
  assert.ok(input)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function imageAnalysisSwitch() {
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.startsWith('启用 Gemini 图片反推'))
  assert.ok(label)
  return document.getElementById(label.htmlFor) as HTMLInputElement
}
async function mount(t: TestContext, fail = false, modelSettings = model.settings, configuredModel = model) {
  let stored = { ...provider }
  const requests: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [], errors: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    requests.push({ url: String(url), method: init?.method, body })
    if (fail) return Response.json({ detail: '名称保存失败' }, { status: 503 })
    if (String(url).startsWith('/api/models/')) return Response.json({ ...model, ...body })
    stored = { ...stored, name: body.name }
    return Response.json(stored)
  })
  function Harness() {
    const [providers, setProviders] = useState([stored]), [busy, setBusy] = useState(false)
    return <MantineProvider env="test"><ModelSettings providers={providers} models={[{ ...configuredModel, settings: modelSettings }]} busy={busy}
      refresh={async () => { setProviders([{ ...stored }]) }} action={async task => {
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

test('renaming a provider submits only its name and updates the heading and provider list', async t => {
  const view = await mount(t)
  try {
    await act(() => button('修改提供商名称').click())
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="提供商名称"]')!.value, provider.name)
    await fillName('  映画工坊  ')
    await act(async () => button('保存名称').click())
    assert.deepEqual(view.requests, [{ url: '/api/providers/provider-one', method: 'PATCH', body: { name: '映画工坊' } }])
    assert.equal(view.container.querySelector('.ms-provider-title h1')!.textContent, '映画工坊')
    assert.match(view.container.querySelector('.ms-provider.is-active')!.textContent!, /映画工坊/)
    assert.equal(view.container.querySelector('.ms-provider-emblem')!.textContent, '映')
    assert.equal(view.container.querySelector<HTMLInputElement>('.ms-connection-form input[type="url"]')!.value, provider.base_url)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('blank names cannot be saved and cancelling a rename makes no request', async t => {
  const view = await mount(t)
  try {
    await act(() => button('修改提供商名称').click())
    assert.equal(button('保存名称').disabled, true)
    await fillName('   ')
    assert.equal(button('保存名称').disabled, true)
    await fillName('未保存名称')
    await act(() => button('取消', document.querySelector('[role="dialog"]')!).click())
    assert.equal(view.container.querySelector('.ms-provider-title h1')!.textContent, provider.name)
    assert.deepEqual(view.requests, [])
  } finally { await view.destroy() }
})

test('failed provider renames retain the draft and leave the displayed name unchanged', async t => {
  const view = await mount(t, true)
  try {
    await act(() => button('修改提供商名称').click())
    await fillName('待重试名称')
    await act(async () => button('保存名称').click())
    assert.deepEqual(view.errors, ['名称保存失败'])
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="提供商名称"]')!.value, '待重试名称')
    assert.equal(view.container.querySelector('.ms-provider-title h1')!.textContent, provider.name)
    assert.equal(button('保存名称').disabled, false)
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
  const view = await mount(t, false, settings, video)
  try {
    await act(() => button('编辑 我的视频模型').click())
    await act(() => button('应用 Seedance 2.5 配置').click())
    await act(async () => button('保存模型').click())
    assert.equal(view.requests.length, 1)
    const body = view.requests[0].body
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
  const view = await mount(t, false, settings, textModel)
  try {
    await act(() => button('编辑 豆包文本模型').click())
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
    assert.equal(view.requests.length, 1)
    const body = view.requests[0].body
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
  const view = await mount(t, false, settings)
  try {
    await act(() => button('编辑 图片模型').click())
    assert.equal(button('高级配置 · JSON').getAttribute('aria-expanded'), 'false')
    await choose('请求配置', 'Images API · 异步任务')
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(!dialog.textContent!.includes('直接返回图片'))
    assert.ok(!dialog.textContent!.includes('自动尺寸'))
    assert.ok(!document.querySelector('[role="dialog"]')!.textContent!.includes('RightAPI'))
    await act(async () => button('保存模型').click())
    assert.equal(view.requests.length, 1)
    const saved = view.requests[0]
    assert.equal(saved.url, '/api/models/model-one')
    assert.equal(saved.body.provider_id, provider.id)
    assert.equal(saved.body.remote_id, model.remote_id)
    const result = saved.body.settings as Record<string, unknown>
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
  const view = await mount(t, false, settings)
  try {
    await act(() => button('编辑 图片模型').click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /已保留自定义请求/)
    assert.equal(button('高级配置 · JSON').getAttribute('aria-expanded'), 'false')
    await act(async () => button('保存模型').click())
    assert.deepEqual(view.requests[0].body.settings, settings)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('edits form uses repeated image files and pixel sizes; switching to generations restores JSON arrays', async t => {
  const settings = { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}' }, image_url_path: 'data.0.url' }
  const view = await mount(t, false, settings)
  try {
    await act(() => button('编辑 图片模型').click())
    await choose('请求配置', 'Images API · 异步任务')
    await choose('参考图传递方式', '文件上传 · multipart')
    await choose('尺寸传递方式', '像素尺寸 · 例如 1280x720')
    await act(async () => button('保存模型').click())
    const saved = view.requests[0].body.settings as Record<string, unknown>
    assert.equal(saved.image_reference_path, 'images/edits')
    assert.equal(saved.image_reference_transport, 'multipart')
    assert.equal(saved.request_timeout_seconds, 600)
    assert.equal(saved.image_size_mode, 'pixels')
    assert.deepEqual(saved.ratios, ['1:1', '16:9', '9:16'])
    assert.equal((saved.request_template as Record<string, unknown>).image, '{{images}}')
    assert.equal((saved.request_template as Record<string, unknown>)['image[]'], undefined)
    await act(() => button('编辑 图片模型').click())
    await choose('请求配置', 'Images API · 异步任务')
    await choose('参考图传递方式', '文件上传 · multipart')
    await choose('参考图用途', '参考生成 · images/generations')
    assert.ok(!document.querySelector('[role="dialog"]')!.textContent!.includes('参考图传递方式'))
    await act(async () => button('保存模型').click())
    const generations = view.requests[1].body.settings as Record<string, unknown>
    assert.equal(generations.image_reference_path, 'images/generations')
    assert.equal(generations.image_reference_transport, 'json')
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('the form enables imageSize only explicitly and preserves an independent task API address', async t => {
  const view = await mount(t)
  try {
    await act(() => button('编辑 图片模型').click())
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
    const saved = view.requests[0].body.settings as Record<string, unknown>
    assert.equal(saved.image_clarity_parameter, true)
    assert.equal(saved.default_clarity, '4K')
    assert.equal((saved.request_template as Record<string, unknown>).imageSize, '{{clarity}}')
    assert.equal(saved.image_task_base_url, 'https://task-proxy.invalid/v1')
    assert.equal(saved.api_base_url, 'https://example.invalid/draw/v1')
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('native video understanding is an explicit Chat Completions capability and persists independently of vision', async t => {
  const textModel = { ...model, name: '复核文本模型', modality: 'text', protocol: 'chat_completions' } as Model
  const settings = { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' }
  const view = await mount(t, false, settings, textModel)
  try {
    await act(() => button('编辑 复核文本模型').click())
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.startsWith('支持视频理解'))!
    assert.ok(label)
    const input = document.getElementById(label.htmlFor) as HTMLInputElement
    assert.equal(input.checked, false)
    assert.equal(input.disabled, false)
    await act(() => label.click())
    await act(async () => button('保存模型').click())
    const saved = view.requests[0].body.settings as Record<string, unknown>
    assert.equal(saved.supports_video, true)
    assert.equal(saved.supports_vision, undefined)
  } finally { await view.destroy() }
})

test('Responses models require an explicit Doubao format before enabling native video input', async t => {
  const textModel = { ...model, name: '图片理解模型', modality: 'text', protocol: 'responses' } as Model
  const view = await mount(t, false, { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_paths: ['output_text'] }, textModel)
  try {
    await act(() => button('编辑 图片理解模型').click())
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.startsWith('支持视频理解'))!
    assert.equal((document.getElementById(label.htmlFor) as HTMLInputElement).disabled, true)
  } finally { await view.destroy() }
})

test('Gemini analysis is explicitly enabled on image models while preserving generation settings and identity', async t => {
  const settings = { request_path: 'custom/images', request_template: { model: '{{model}}', prompt: '{{prompt}}', size: '{{ratio}}' },
    api_base_url: 'https://images.invalid/draw/v1', image_url_path: 'data.0.url',
    headers: { 'X-Route': 'existing' }, pricing: { per_image: 0.5, currency: '¥' } }
  const nano = { ...model, name: 'Nano Banana', remote_id: 'nano-banana-fast' }
  const view = await mount(t, false, settings, nano)
  try {
    await act(() => button('编辑 Nano Banana').click())
    assert.equal(imageAnalysisSwitch().checked, false, 'model name never enables analysis')
    assert.ok(![...document.querySelectorAll('label')].some(label => label.textContent === '分析 API 地址'))
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /GPT Image 生图接口只返回图片/)
    await act(() => imageAnalysisSwitch().click())
    assert.equal(imageAnalysisSwitch().checked, true)
    await fillLabeledInput('分析 API 地址', 'https://gemini.invalid/v1beta')
    await fillLabeledInput('分析模型 ID', 'gemini-2.5-flash-image')
    await fillLabeledInput('分析请求路径', 'models/{model}:generateContent')
    await act(async () => button('保存模型').click())
    assert.equal(view.requests.length, 1)
    assert.equal(view.requests[0].body.remote_id, nano.remote_id)
    assert.equal(view.requests[0].body.provider_id, nano.provider_id)
    assert.equal(view.requests[0].body.protocol, 'image_generations')
    assert.deepEqual(view.requests[0].body.settings, { ...settings, image_analysis: { enabled: true,
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
  const view = await mount(t, false, settings)
  try {
    await act(() => button('编辑 图片模型').click())
    await fillLabeledInput('分析 API 地址', '')
    await fillLabeledInput('分析请求路径', '')
    await act(() => imageAnalysisSwitch().click())
    assert.equal(imageAnalysisSwitch().checked, false)
    await act(async () => button('保存模型').click())
    assert.deepEqual(view.requests[0].body.settings, { ...settings,
      image_analysis: { enabled: false, protocol: 'gemini_generate_content', remote_id: image_analysis.remote_id } })
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('invalid analysis addresses fail locally without submitting model changes', async t => {
  const view = await mount(t, false, { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' }, image_url_path: 'data.0.url' })
  try {
    await act(() => button('编辑 图片模型').click())
    await act(() => imageAnalysisSwitch().click())
    await fillLabeledInput('分析 API 地址', 'file:///tmp/private')
    await act(async () => button('保存模型').click())
    assert.equal(view.requests.length, 0)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /图片反推 API 地址必须/)
  } finally { await view.destroy() }
})
