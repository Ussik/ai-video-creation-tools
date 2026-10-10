import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamText, type GenerationModel } from '../src/providers.js'
import { textToolSession } from '../src/text-tools.js'
import { createStreamScope, StreamWaitTimeoutError, textRequestTimeoutMs } from '../src/script-stream-policy.js'
const model: GenerationModel = { id: 'text', remote_id: 'fixture', modality: 'text', protocol: 'responses', settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } }
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid' }
const encode = new TextEncoder()
function heldStream(payload: string, cancelled: () => void) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode.encode(payload)) }, cancel() { cancelled() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stream incorrectly waited for socket close')), 200) })]) }
  finally { clearTimeout(timer!) }
}

test('legacy text finishes at terminal protocol events even while the provider keeps the socket open', async t => {
  for (const terminal of ['data: [DONE]\n\n', 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']) {
    let cancelled = false
    t.mock.method(globalThis, 'fetch', async () => heldStream('data: {"type":"response.output_text.delta","delta":"人物设定完整正文"}\n\n' + terminal, () => { cancelled = true }))
    assert.equal(await bounded(streamText(model, provider, { prompt: '创作人物' })), '人物设定完整正文')
    assert.equal(cancelled, true)
    t.mock.restoreAll()
  }
})

test('native tool responses complete and cancel open bodies before executing further rounds', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) {
    let cancelled = false
    const output = protocol === 'responses'
      ? { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'read-1', name: 'read_documents', arguments: '{}' }] } }
      : { choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read_documents', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
    t.mock.method(globalThis, 'fetch', async () => heldStream(`data: ${JSON.stringify(output)}\n\n`, () => { cancelled = true }))
    const selected = { ...model, protocol, settings: { ...model.settings as object, request_template: protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] } } }
    const result = await bounded(textToolSession(selected, provider, '读取', [], () => '')())
    assert.equal(result.calls[0].name, 'read_documents'); assert.equal(cancelled, true)
    t.mock.restoreAll()
  }
})

test('provider deadlines bound both header and body waits even if the upstream ignores abort', async t => {
  for (const native of [false, true]) for (const phase of ['headers', 'body']) await t.test(`${native ? 'native' : 'text'} ${phase}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let entered!: () => void, requestSignal!: AbortSignal
    const started = new Promise<void>(resolve => { entered = resolve })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requestSignal = init.signal!; entered()
      return phase === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const result = native ? textToolSession(model, provider, '请求', [], () => '')() : streamText(model, provider, { prompt: '请求' })
    const rejected = assert.rejects(result, /20 分钟/)
    await started; await Promise.resolve(); await Promise.resolve()
    t.mock.timers.tick(10 * 60_000)
    assert.equal(requestSignal.aborted, false, 'slow requests may continue beyond the previous ten-minute deadline')
    t.mock.timers.tick(textRequestTimeoutMs - 10 * 60_000)
    await rejected; assert.equal(requestSignal.aborted, true)
  })
})

test('heartbeat activity extends idle time but cannot extend the whole-dialogue deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const scope = createStreamScope(undefined, { idleMs: 45, totalMs: 150 })
  const stalled = assert.rejects(scope.wait(new Promise(() => {})), issue => issue instanceof StreamWaitTimeoutError && issue.kind === 'total')
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(30); scope.touch(); assert.equal(scope.signal.aborted, false) }
  t.mock.timers.tick(30); await stalled; scope.close()
  const idle = createStreamScope(undefined, { idleMs: 45, totalMs: 150 })
  const disconnected = assert.rejects(idle.wait(new Promise(() => {})), issue => issue instanceof StreamWaitTimeoutError && issue.kind === 'idle')
  t.mock.timers.tick(45); await disconnected; idle.close()
})

test('partial text without a completion and explicit provider failures do not become completed drafts', async t => {
  for (const tail of ['', 'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n']) {
    const received: string[] = []
    t.mock.method(globalThis, 'fetch', async () => new Response('data: {"type":"response.output_text.delta","delta":"半段人物内容"}\n\n' + tail, { headers: { 'Content-Type': 'text/event-stream' } }))
    await assert.rejects(streamText(model, provider, { prompt: '人物' }, undefined, event => { if (event.type === 'delta') received.push(event.text) }), /提前结束|不完整|截断/)
    assert.deepEqual(received, ['半段人物内容']); t.mock.restoreAll()
  }
})
