import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'
import { streamText } from '../src/infrastructure/providers/providers.js'
import { withTextImageInput } from '../src/infrastructure/providers/text-image-input.js'

const pixels = 'data:image/jpeg;base64,' + Buffer.from('test pixels').toString('base64')

for (const protocol of ['responses', 'chat_completions'] as const) {
  test(`${protocol} sends real image parts alongside the last user message and preserves model template controls`, async t => {
    const key = protocol === 'responses' ? 'input' : 'messages'
    let captured: Record<string, any> = {}
    const original = { model: '{{model}}', [key]: [{ role: 'system', content: 'existing model rules' }, { role: 'user', content: '{{prompt}}' }],
      temperature: 0.4, max_output_tokens: 2048, stream: false }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      captured = JSON.parse(String(init.body))
      return Response.json(protocol === 'responses' ? { output_text: '完整专业提示词' } : { choices: [{ message: { content: '完整专业提示词' }, finish_reason: 'stop' }] })
    })
    const model: GenerationModel = { id: 'vision', remote_id: 'remote-vision', modality: 'text', protocol, settings: {
      supports_vision: true, request_path: 'vision', request_template: original,
      text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content',
    } }
    const output = await streamText(model, { adapter: 'http', base_url: 'https://fixture.invalid' }, { prompt: '分析图片', images: [{ data_url: pixels, detail: 'high' }] })
    assert.equal(output, '完整专业提示词')
    assert.equal(captured.model, 'remote-vision'); assert.equal(captured.temperature, 0.4)
    assert.equal(captured[key][0].content, 'existing model rules')
    const content = captured[key][1].content
    assert.deepEqual(content[0], { type: protocol === 'responses' ? 'input_text' : 'text', text: '分析图片' })
    assert.deepEqual(content[1], protocol === 'responses' ? { type: 'input_image', image_url: pixels, detail: 'high' }
      : { type: 'image_url', image_url: { url: pixels, detail: 'high' } })
    assert.equal(original[key][1]!.content, '{{prompt}}', 'configured templates remain unmodified')
  })
}

test('Responses string input becomes a user message with text and image; existing multipart text stays intact', () => {
  const result = withTextImageInput({ input: '保留这段分析要求', tools: [] }, [{ data_url: pixels }], 'responses', { supports_vision: true }) as any
  assert.equal(result.input[0].content[0].text, '保留这段分析要求')
  assert.equal(result.input[0].content[1].image_url, pixels)
  const parts = [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]
  const chat = withTextImageInput({ messages: [{ role: 'user', content: parts }] }, [{ data_url: pixels }], 'chat_completions', { supports_vision: true }) as any
  assert.deepEqual(chat.messages[0].content.slice(0, 2), parts)
  assert.equal(parts.length, 2)
})

test('image payloads cannot silently fall back to text-only or remote URLs', () => {
  for (const config of [{}, { supports_vision: false }, { supports_vision: 'true' }]) {
    assert.throws(() => withTextImageInput({ input: 'text' }, [{ data_url: pixels }], 'responses', config), /图片理解/)
  }
  assert.throws(() => withTextImageInput({ prompt: 'text' }, [{ data_url: pixels }], 'responses', { supports_vision: true }), /input/)
  assert.throws(() => withTextImageInput({ messages: [] }, [{ data_url: pixels }], 'chat_completions', { supports_vision: true }), /messages/)
  assert.throws(() => withTextImageInput({ input: 'text' }, [{ data_url: 'https://example.invalid/private.png' }], 'responses', { supports_vision: true }), /本地图片/)
  const noImages = { input: 'text' }
  assert.equal(withTextImageInput(noImages, undefined, 'responses', {}), noImages)
})

test('vision capacity excludes base64 text while budgeting pixels and preserving all real text', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ output_text: '专业提示词' }) })
  const model: GenerationModel = { id: 'vision', remote_id: 'vision', modality: 'text', protocol: 'responses', settings: {
    supports_vision: true, request_path: 'vision', request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 1000 },
    context_window_tokens: 16000, text_path: 'output_text',
  } }
  const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid' }
  const image = `data:image/jpeg;base64,${'A'.repeat(1024 * 1024)}`
  assert.equal(await streamText(model, provider, { prompt: '分析画面', images: [{ data_url: image }] }), '专业提示词')
  await assert.rejects(streamText(model, provider, { prompt: '长'.repeat(15000), images: [{ data_url: image }] }), /上下文预算不足/)
  assert.equal(calls, 1)
})

test('aborting a vision request reaches fetch and prevents a result', async t => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    controller.abort(new DOMException('cancelled', 'AbortError'))
  }))
  await assert.rejects(streamText({ id: 'vision', remote_id: 'vision', modality: 'text', protocol: 'responses', settings: {
    supports_vision: true, request_path: 'vision', request_template: { input: '{{prompt}}' }, text_path: 'output_text',
  } }, { adapter: 'http', base_url: 'https://fixture.invalid' }, { prompt: '分析', images: [{ data_url: pixels }] }, undefined, undefined, controller.signal), /cancelled|取消/)
})
