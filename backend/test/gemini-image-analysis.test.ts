import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeGeminiImage } from '../src/infrastructure/providers/gemini-image-analysis.js'
import type { GenerationModel, GenerationProvider } from '../src/infrastructure/providers/providers.js'

const pixels = Buffer.from('bounded local image pixels').toString('base64')
const request = { prompt: '根据真实图片反推专业提示词', images: [{ data_url: `data:image/jpeg;base64,${pixels}` }] }
const provider: GenerationProvider = { adapter: 'http', base_url: 'https://gateway.invalid/v1beta',
  auth_header: 'x-goog-api-key', auth_prefix: '', key_ciphertext: 'encrypted' }
const model: GenerationModel = { id: 'nano', remote_id: 'gemini-2.5-flash-image', modality: 'image', protocol: 'image_generations', settings: {
  api_base_url: 'https://images.invalid/draw/v1', request_path: 'images/generations',
  request_template: { async: true, imageSize: '4K', model: '{{model}}', prompt: '{{prompt}}' },
  image_analysis: { enabled: true, protocol: 'gemini_generate_content' },
} }
const success = (parts: unknown[] = [{ text: '柔和侧光下的蓝色织物，近景构图。' }], finishReason = 'STOP') =>
  Response.json({ candidates: [{ content: { parts }, finishReason }] })

test('Nano Banana sends real Gemini inline pixels and requests only TEXT, independently of the Images API settings', async t => {
  const original = JSON.stringify(model)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls++
    assert.equal(url, 'https://gateway.invalid/v1beta/models/gemini-2.5-flash-image:generateContent')
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'fixture-secret')
    assert.deepEqual(JSON.parse(String(init.body)), { contents: [{ role: 'user', parts: [
      { text: request.prompt }, { inlineData: { mimeType: 'image/jpeg', data: pixels } },
    ] }], generationConfig: { responseModalities: ['TEXT'] } })
    return success([{ thought: true, text: '内部思考不应进入提示词' }, { text: '柔和侧光，' }, { text: '蓝色织物。' }])
  })
  assert.equal(await analyzeGeminiImage(model, provider, request, target => {
    assert.equal(target, provider); return 'fixture-secret'
  }), '柔和侧光，蓝色织物。')
  assert.equal(calls, 1); assert.equal(JSON.stringify(model), original)
})

test('analysis overrides preserve API prefixes and encode model IDs without reusing image endpoint or authentication defaults', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(url, 'https://analysis.invalid/proxy/google/v1beta/models/vendor%2Fcustom:generateContent')
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer gateway-secret')
    return success()
  })
  const configured = { ...model, settings: { image_analysis: { enabled: true, protocol: 'gemini_generate_content',
    api_base_url: 'https://analysis.invalid/proxy/google', request_path: 'v1beta/models/{model}:generateContent', remote_id: 'models/vendor/custom' } } }
  assert.match(await analyzeGeminiImage(configured, { ...provider, auth_header: null, auth_prefix: null }, request, () => 'gateway-secret'), /蓝色织物/)
})

test('unconfigured image models and invalid input never call a model', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must validate before fetching'))
  for (const settings of [{}, { image_analysis: { enabled: false, protocol: 'gemini_generate_content' } },
    { image_analysis: { enabled: true, protocol: 'images' } }]) {
    await assert.rejects(analyzeGeminiImage({ ...model, settings }, provider, request), /未配置/)
  }
  await assert.rejects(analyzeGeminiImage({ ...model, modality: 'text' }, provider, request), /未配置/)
  await assert.rejects(analyzeGeminiImage(model, { ...provider, adapter: 'demo' }, request), /未配置/)
  for (const images of [[], [request.images[0]!, request.images[0]!], [{ data_url: 'https://image.invalid/private.png' }],
    [{ data_url: 'data:image/jpeg;base64,' + 'A'.repeat(6 * 1024 * 1024) }]]) {
    await assert.rejects(analyzeGeminiImage(model, provider, { ...request, images }), /本地图片/)
  }
})

test('unsupported TEXT output fails visibly once, without retrying or falling back to image generation', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ error: { message: 'This model does not support TEXT-only output' } }, { status: 400 })
  })
  await assert.rejects(analyzeGeminiImage(model, provider, request), /HTTP 400.*TEXT-only/)
  assert.equal(calls, 1)
})

test('blocked, truncated, thought-only, malformed and nontext responses cannot become a usable prompt', async t => {
  for (const response of [
    Response.json({ promptFeedback: { blockReason: 'SAFETY' } }), success([{ text: '未写完' }], 'MAX_TOKENS'),
    success([{ text: '被拦截的部分文字' }], 'SAFETY'), success([{ thought: true, text: '内部推理' }]),
    success([{ text: ' ' }]), success([{ text: '说明文字' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } }]),
    success([{ fileData: { fileUri: 'https://output.invalid/image.png' } }]), Response.json({ candidates: [] }),
    success([{ text: '文字', codeExecutionResult: { output: '工具结果' } }]),
    new Response('<html>not JSON</html>'),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response)
    await assert.rejects(analyzeGeminiImage(model, provider, request), /未返回|不完整|非文本|未完整/)
  }
})

test('drawing gateways returning task IDs or image URLs are rejected without polling or downloading', async t => {
  let calls = 0
  for (const response of [Response.json({ task_id: 'paid-image-task', status: 'processing' }),
    success([{ text: 'https://cdn.invalid/result.png' }]), success([{ text: '![image](https://cdn.invalid/result.png)' }])]) {
    t.mock.method(globalThis, 'fetch', async () => { calls++; return response })
    await assert.rejects(analyzeGeminiImage(model, provider, request), /异步生图任务|返回了图片地址/)
  }
  assert.equal(calls, 3)
})

test('upstream error messages redact credentials and image data', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message:
    `bad credential fixture-secret; Bearer other-secret; data:image/jpeg;base64,${pixels}; {"data":"${'A'.repeat(128)}"}` } }, { status: 401 }))
  await assert.rejects(analyzeGeminiImage(model, provider, request, () => 'fixture-secret'), error => {
    const message = String(error)
    assert.match(message, /HTTP 401/)
    assert.doesNotMatch(message, /fixture-secret|other-secret|data:image\/|A{64}/)
    return true
  })
})

test('oversized responses are cancelled and discarded', async t => {
  let cancelled = false
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
    cancel() { cancelled = true } }))
  t.mock.method(globalThis, 'fetch', async () => response)
  await assert.rejects(analyzeGeminiImage(model, provider, request), /响应过大/)
  assert.equal(cancelled, true)
})

test('cancellation reaches fetch and a pre-aborted request never starts', async t => {
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    calls++
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    controller.abort(new DOMException('cancelled', 'AbortError'))
  }))
  await assert.rejects(analyzeGeminiImage(model, provider, request, undefined, controller.signal), /cancelled/)
  await assert.rejects(analyzeGeminiImage(model, provider, request, undefined, controller.signal), /cancelled/)
  assert.equal(calls, 1)
})
