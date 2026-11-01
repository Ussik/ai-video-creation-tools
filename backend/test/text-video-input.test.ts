import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textVideoCapacityBody, withTextVideoInput } from '../src/infrastructure/providers/text-video-input.js'
import { streamText, type GenerationModel } from '../src/infrastructure/providers/providers.js'

const video = { data_url: 'data:video/mp4;base64,YWJjZA==', duration_ms: 4000 }
const body = { model: 'video-reader', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'review' }] }
test('native video is attached to the user message without dropping text or changing the template', () => {
  const output = withTextVideoInput(body, video, 'chat_completions', { supports_video: true }) as { messages: any[] }
  assert.deepEqual(output.messages[1].content, [{ type: 'text', text: 'review' }, { type: 'video_url', video_url: { url: video.data_url } }])
  assert.equal(body.messages[1]!.content, 'review')
  assert.deepEqual(output.messages[0], body.messages[0])
  assert.doesNotMatch(JSON.stringify(textVideoCapacityBody(output)), /YWJjZA/)
  assert.match(JSON.stringify(textVideoCapacityBody(output)), /local video bytes/)
})
test('video transport requires explicit capability, compatible protocol and bounded local MP4 input', () => {
  for (const [settings, protocol] of [[{}, 'chat_completions'], [{ supports_video: 'true' }, 'chat_completions'], [{ supports_video: true }, 'responses']] as const) {
    assert.throws(() => withTextVideoInput(body, video, protocol, settings), /video_url/)
  }
  for (const invalid of [{ ...video, data_url: 'https://example.com/secret.mp4' }, { ...video, duration_ms: 60_001 }, { ...video, duration_ms: 0 }]) {
    assert.throws(() => withTextVideoInput(body, invalid, 'chat_completions', { supports_video: true }), /本地 MP4/)
  }
  assert.equal(withTextVideoInput(body, undefined, 'responses', {}), body)
})

test('native provider transport sends video bytes, budgets media separately and redacts echoed video from upstream errors', async t => {
  const bigVideo = { data_url: `data:video/mp4;base64,${'A'.repeat(1024 * 1024)}`, duration_ms: 4000 }
  const model: GenerationModel = { id: 'reader', remote_id: 'reader', modality: 'text', protocol: 'chat_completions', settings: {
    supports_video: true, context_window_tokens: 32_000, request_path: 'chat/completions',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], max_tokens: 1000, stream: false },
    text_path: 'choices.0.message.content',
  } }
  let captured: any, fails = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    captured = JSON.parse(String(init.body))
    if (fails) return Response.json({ error: { message: `unsupported ${video.data_url}` } }, { status: 400 })
    return Response.json({ choices: [{ message: { content: '已观察画面' }, finish_reason: 'stop' }] })
  })
  const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid' }
  assert.equal(await streamText(model, provider, { prompt: '复核', video: bigVideo }), '已观察画面')
  assert.equal(captured.messages[0].content[1].video_url.url, bigVideo.data_url)
  fails = true
  await assert.rejects(streamText(model, provider, { prompt: '复核', video }), error => {
    assert.match(String(error), /视频数据已隐藏/); assert.doesNotMatch(String(error), /YWJjZA/)
    return true
  })
})

const doubao = { supports_video: true, video_input_format: 'doubao_ark' }
test('Doubao Chat and Responses retain text and use their documented fps positions for a 90 second clip', () => {
  const clip = { ...video, duration_ms: 90_000, fps: 3 }
  const chat = withTextVideoInput(body, clip, 'chat_completions', doubao) as { messages: any[] }
  assert.deepEqual(chat.messages[1].content, [{ type: 'text', text: 'review' }, { type: 'video_url', video_url: { url: video.data_url, fps: 3 } }])
  const input = { model: 'doubao-reader', instructions: 'Keep rules', input: 'Analyze actual video' }
  const response = withTextVideoInput(input, clip, 'responses', doubao) as { input: any[]; instructions: string }
  assert.deepEqual(response.input, [{ role: 'user', content: [
    { type: 'input_text', text: 'Analyze actual video' }, { type: 'input_video', video_url: video.data_url, fps: 3 },
  ] }])
  assert.equal(response.instructions, input.instructions)
  assert.equal(input.input, 'Analyze actual video')
  assert.doesNotMatch(JSON.stringify(textVideoCapacityBody(response)), /YWJjZA/)
  assert.match(JSON.stringify(textVideoCapacityBody(response)), /local video bytes/)
})

test('Doubao video bounds reject invalid fps, duration, foreign transports and invalid Base64 before dispatch', () => {
  for (const clip of [{ ...video, fps: 0.1 }, { ...video, fps: 5.01 }, { ...video, fps: NaN },
    { ...video, duration_ms: 180_001 }, { ...video, data_url: 'https://example.invalid/clip.mp4' },
    { ...video, data_url: 'data:video/mp4;base64,YWJjZA=' }, { ...video, data_url: 'data:video/webm;base64,YWJjZA==' }]) {
    assert.throws(() => withTextVideoInput(body, clip, 'chat_completions', doubao), /豆包/)
  }
  assert.throws(() => withTextVideoInput(body, { ...video, fps: 2 }, 'chat_completions', { supports_video: true }), /采样率/)
  assert.throws(() => withTextVideoInput(body, video, 'chat_completions', { ...doubao, video_input_format: 'unknown' }), /视频输入格式/)
  assert.throws(() => withTextVideoInput({ input: [] }, video, 'responses', doubao), /input/)
  assert.throws(() => withTextVideoInput(body, { ...video, data_url: `data:video/mp4;base64,${'A'.repeat(64 * 1024 * 1024)}` }, 'chat_completions', doubao), /64 MB/)
})

test('Responses video provider transport carries actual bytes and redacts upstream echoes', async t => {
  const clip = { ...video, duration_ms: 90_000, fps: 2 }
  const model: GenerationModel = { id: 'doubao', remote_id: 'doubao-reader', modality: 'text', protocol: 'responses', settings: {
    ...doubao, context_window_tokens: 1_000_000, request_path: 'responses',
    request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 1500, stream: false },
    text_path: 'output.0.content.0.text',
  } }
  let captured: any, fails = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    captured = JSON.parse(String(init.body))
    if (fails) return Response.json({ error: { message: `unsupported ${video.data_url}` } }, { status: 400 })
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '视频观察结果' }] }], status: 'completed' })
  })
  const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid' }
  assert.equal(await streamText(model, provider, { prompt: '分析镜头', video: clip }), '视频观察结果')
  assert.deepEqual(captured.input[0].content[1], { type: 'input_video', video_url: video.data_url, fps: 2 })
  fails = true
  await assert.rejects(streamText(model, provider, { prompt: '分析镜头', video: clip }), error => {
    assert.match(String(error), /视频数据已隐藏/); assert.doesNotMatch(String(error), /YWJjZA/); return true
  })
})
