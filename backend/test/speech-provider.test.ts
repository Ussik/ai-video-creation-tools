import assert from 'node:assert/strict'
import { test } from 'node:test'

import { maxSpeechResponseBytes, speechRequestTimeoutMs, synthesizeSpeech } from '../src/infrastructure/providers/speech-provider.js'

import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'

const input = { api_key: 'secret-for-speech-test', text: '你好，晚安。', speaker: 'zh_female_vv_uranus_bigtts' }
const encode = (message: Record<string, unknown>) => new TextEncoder().encode(`${JSON.stringify(message)}\n`)
const audio = Buffer.from('ID3 test speech bytes')
const chunk = { code: 0, data: audio.toString('base64') }
const finished = { code: 20_000_000, message: 'ok' }

function streamResponse(parts: Uint8Array[], onCancel?: () => void): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts[index++]
      if (next) controller.enqueue(next)
      else controller.close()
    },
    cancel() { onCancel?.() },
  }), { headers: { 'Content-Type': 'application/json' } })
}

test('TTS sends one standard-voice request with its own resource, key and MP3 settings', async () => {
  let calls = 0
  let sent: RequestInit | undefined
  let sentUrl = ''
  const result = await synthesizeSpeech({ ...input, speech_rate: -10 }, async (url, init) => {
    calls++
    sentUrl = String(url)
    sent = init
    return streamResponse([encode(chunk), encode(finished)])
  })
  assert.equal(calls, 1)
  assert.equal(sentUrl, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
  assert.equal(sent?.method, 'POST')
  const headers = new Headers(sent?.headers)
  assert.equal(headers.get('X-Api-Key'), input.api_key)
  assert.equal(headers.get('X-Api-Resource-Id'), 'seed-tts-2.0')
  assert.equal(headers.get('X-Control-Require-Usage-Tokens-Return'), '*')
  assert.equal(headers.get('X-Api-Request-Id'), result.request_id)
  assert.match(result.request_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(JSON.parse(String(sent?.body)), { req_params: {
    text: input.text, speaker: input.speaker,
    audio_params: { format: 'mp3', sample_rate: 24_000, enable_subtitle: true, speech_rate: -10 },
  } })
  assert.deepEqual(result.audio, audio)
  assert.equal(result.duration_ms, null)
  assert.equal(result.usage_characters, null)
})

test('TTS handles arbitrary UTF-8 and JSON chunk boundaries and a final line without a newline', async () => {
  const subtitle = { word: '你好', startTime: 0.01, endTime: 0.56 }
  const all = Buffer.concat([
    encode({ ...chunk, sentence: { words: [subtitle] } }),
    encode({ code: 0, data: Buffer.from(' second chunk').toString('base64'), sentence: { words: [subtitle] } }),
    Buffer.from(JSON.stringify({ ...finished, usage: { text_words: 6 } })),
  ])
  const parts = Array.from(all, value => Uint8Array.of(value))
  const result = await synthesizeSpeech(input, async () => streamResponse(parts))
  assert.deepEqual(result.audio, Buffer.concat([audio, Buffer.from(' second chunk')]))
  assert.deepEqual(result.subtitles, [{ text: '你好', start_ms: 10, end_ms: 560 }])
  assert.equal(result.duration_ms, null)
  assert.equal(result.usage_characters, 6)
})

test('performance and context use one documented additions instruction, never changing the spoken text', async () => {
  let sent: RequestInit | undefined
  await synthesizeSpeech({ ...input, instructions: '用轻声、犹豫的语气说话。', context_text: '她刚刚得知真相。' }, async (_url, init) => {
    sent = init
    return streamResponse([encode(chunk), encode(finished)])
  })
  const request = JSON.parse(String(sent?.body)).req_params
  assert.equal(request.text, input.text)
  assert.equal(typeof request.additions, 'string')
  assert.deepEqual(JSON.parse(request.additions), {
    context_texts: ['用轻声、犹豫的语气说话。\n情境参考（不要朗读）：\n她刚刚得知真相。'],
  })
})

test('HTTP 200 provider failure stops and cancels the stream without exposing echoed credentials', async () => {
  let calls = 0
  let cancelled = false
  await assert.rejects(synthesizeSpeech(input, async () => {
    calls++
    return streamResponse([
      encode({ code: 45_000_030, message: `denied key ${input.api_key}`, debug: input.api_key }),
      encode(chunk), encode(finished),
    ], () => { cancelled = true })
  }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /45000030/)
    assert.equal(error.message.includes(input.api_key), false)
    return true
  })
  assert.equal(calls, 1)
  assert.equal(cancelled, true)
})

test('HTTP errors and connection failures never echo raw response or exception contents and never retry', async () => {
  for (const response of [
    new Response(`API key ${input.api_key}`, { status: 403 }),
    new Error(`语音服务 ${input.api_key}`),
  ]) {
    let calls = 0
    await assert.rejects(synthesizeSpeech(input, async () => {
      calls++
      if (response instanceof Error) throw response
      return response
    }), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(input.api_key), false)
      assert.match(error.message, /语音服务/)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('malformed JSON, malformed base64 and an absent completion marker cannot create a successful audio result', async () => {
  for (const parts of [
    [new TextEncoder().encode(`not json ${input.api_key}\n`), encode(finished)],
    [encode({ code: 0, data: `!${input.api_key}!` }), encode(finished)],
    [encode(chunk)],
    [encode(finished)],
  ]) {
    await assert.rejects(synthesizeSpeech(input, async () => streamResponse(parts)), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(input.api_key), false)
      assert.match(error.message, /语音服务/)
      return true
    })
  }
})

test('oversized streams are rejected and cancelled before more audio is buffered', async () => {
  let cancelled = false
  await assert.rejects(synthesizeSpeech(input, async () => streamResponse([
    new Uint8Array(maxSpeechResponseBytes + 1), encode(finished),
  ], () => { cancelled = true })), /超过 30 MB/)
  assert.equal(cancelled, true)
})

test('an oversized advertised response is cancelled without reading or persisting it', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), {
    headers: { 'Content-Length': String(maxSpeechResponseBytes + 1) },
  })
  await assert.rejects(synthesizeSpeech(input, async () => response), /超过 30 MB/)
  assert.equal(cancelled, true)
})

test('a terminal success stops the stream even if the provider keeps the connection open', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.concat([encode(chunk), encode(finished)])) },
    cancel() { cancelled = true },
  }))
  const metrics: any[] = []
  const result = await withModelRequestContext({ policy: modelTaskPolicies.paid, onMetrics: value => metrics.push(value) }, () =>
    synthesizeSpeech(input, async () => response))
  assert.deepEqual(result.audio, audio)
  assert.equal(cancelled, true)
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].delivery, 'completed')
  assert.equal(metrics[0].failure_reason, undefined)
  assert.equal(metrics[0].raw_reason, undefined)
  assert.equal(metrics[0].input_tokens, undefined)
})

test('invalid UTF-8 is rejected instead of silently corrupting subtitles', async () => {
  await assert.rejects(synthesizeSpeech(input, async () => streamResponse([
    Uint8Array.from([0xc3, 0x28]), encode(finished),
  ])), /数据编码无效/)
})

test('the deadline covers waiting for both headers and stalled response bodies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const stall of ['headers', 'body']) {
    let calls = 0
    let signal: AbortSignal | null | undefined
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const result = synthesizeSpeech(input, async (_url, init) => {
      calls++
      signal = init?.signal
      started()
      if (stall === 'headers') return new Promise<Response>(() => {})
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode(chunk)) } }))
    })
    const rejected = assert.rejects(result, /语音生成超时/)
    await ready
    t.mock.timers.tick(speechRequestTimeoutMs)
    await rejected
    assert.equal(signal?.aborted, true)
    assert.equal(calls, 1)
  }
})

test('empty input, invalid rates and paid clone voice IDs fail before contacting the service', async () => {
  const shouldNotFetch: typeof fetch = async () => { assert.fail('validation must run before any paid request') }
  for (const invalid of [
    { ...input, text: ' ' },
    { ...input, api_key: '' },
    { ...input, api_key: 'secret\nheader' },
    { ...input, speaker: '' },
    { ...input, speaker: 'S_clone-slot' },
    { ...input, speech_rate: -51 },
    { ...input, speech_rate: 101 },
    { ...input, speech_rate: 0.5 },
  ]) await assert.rejects(synthesizeSpeech(invalid, shouldNotFetch))
})


test('a terminal marker without audio cannot confirm a successful speech transport', async () => {
  const metrics: any[] = []
  await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.paid, onMetrics: value => metrics.push(value) }, () =>
    synthesizeSpeech(input, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(finished)) } })))), /没有返回音频/)
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].delivery, 'accepted')
  assert.equal(metrics[0].raw_reason, 'body_cancelled')
})
