import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamText, createTextToolTransport, type GenerationModel, type TextRequestMetrics } from '../src/infrastructure/providers/providers.js'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { textToolSession } from '../src/infrastructure/providers/text-tools.js'
import { textHeadersTimeoutMs } from '../src/infrastructure/providers/text-transport-boundary.js'
import { createStreamScope, StreamWaitTimeoutError, generationStepBudgets } from '@video-studio/shared/script/script-stream-policy'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'
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
  // A transport's header deadline is shorter than its discussion-wide budget.
  // Exercise transports directly so a session retry is not confused with one
  // connection's lifecycle; session-wide deadlines are checked separately.
  for (const native of [false, true]) for (const phase of ['headers', 'body']) await t.test(`${native ? 'native' : 'text'} ${phase}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let entered!: () => void, requestSignal!: AbortSignal, bodyCancelled = false, metrics: TextRequestMetrics | undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requestSignal = init.signal!; entered()
      return phase === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ cancel() { bodyCancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const onMetrics = (value: TextRequestMetrics) => { metrics = value }
    const result = native ? createTextToolTransport(model, provider, '请求', [], undefined, [], () => '', undefined, undefined, undefined, onMetrics)
      : streamText(model, provider, { prompt: '请求' }, undefined, undefined, undefined, onMetrics)
    const rejected = assert.rejects(result, issue => phase === 'headers'
      ? issue instanceof TextProviderError && issue.upstreamCode === 'headers_timeout' && issue.rawReason === 'headers_timeout' && issue.failureReason === 'disconnected'
      : issue instanceof StreamWaitTimeoutError && issue.kind === 'total' && /5 分钟/.test(issue.message))
    await started
    // The channel admission and transport.wait layers must finish processing
    // response headers before advancing a mocked body clock.
    await new Promise<void>(resolve => setImmediate(resolve))
    const deadline = phase === 'headers' ? textHeadersTimeoutMs : generationStepBudgets.discussion
    t.mock.timers.tick(deadline - 1)
    assert.equal(requestSignal.aborted, false)
    t.mock.timers.tick(1)
    await rejected; assert.equal(requestSignal.aborted, true)
    assert.equal(metrics?.failure_reason, 'disconnected')
    assert.equal(metrics?.raw_reason, phase === 'headers' ? 'headers_timeout' : 'total')
    if (phase === 'body') assert.equal(bodyCancelled, true)
  })
})

test('tool-session activity cannot extend its whole discussion deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let writer!: ReadableStreamDefaultController<Uint8Array>, requestSignal!: AbortSignal, cancelled = false, calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; requestSignal = init.signal!
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const result = textToolSession(model, provider, '请求', [], () => '')()
  const rejected = assert.rejects(result, issue => issue instanceof StreamWaitTimeoutError && issue.kind === 'total' && /5 分钟/.test(issue.message))
  await new Promise<void>(resolve => setImmediate(resolve))
  for (let index = 0; index < 4; index++) {
    t.mock.timers.tick(60_000)
    writer.enqueue(encode.encode('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n'))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(requestSignal.aborted, false)
  }
  t.mock.timers.tick(60_000)
  await rejected; assert.equal(requestSignal.aborted, true); assert.equal(cancelled, true)
  assert.equal(calls, 1, 'a session deadline never dispatches a replacement request')
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

test('Responses output-limit failures expose the upstream reason on the text stream path', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  }))
  await assert.rejects(streamText(model, provider, { prompt: 'private source text' }), (issue: unknown) => {
    assert.ok(issue instanceof Error)
    assert.match(issue.message, /已达到模型输出长度上限/)
    assert.ok(!issue.message.includes('private source text'))
    return true
  })
})

test('Responses terminal output-limit text and usage survive SSE and ordinary JSON responses', async t => {
  for (const transport of ['sse', 'json'] as const) await t.test(transport, async t => {
    const payload = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '已生成正文结尾' }] }],
      usage: { ...(transport === 'json' ? { input_tokens: 123 } : {}), output_tokens: 64, output_tokens_details: { reasoning_tokens: 32 } } } }
    let captured: TextRequestMetrics | undefined
    const deltas: string[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 96000)
      return transport === 'json' ? Response.json(payload.response) : new Response(
        'data: {"type":"response.output_text.delta","delta":"已生成正文","usage":{"input_tokens":123}}\n\n' + `data: ${JSON.stringify(payload)}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'terminal-limit' } })
    })
    const selected = { ...model, settings: { ...model.settings as object, request_template: { input: '{{prompt}}', max_output_tokens: 96000 } } }
    await assert.rejects(streamText(selected, provider, { prompt: 'private screenplay' }, undefined,
      event => { if (event.type === 'delta') deltas.push(event.text) }, undefined, value => { captured = value }), issue => {
      assert.ok(issue instanceof TextOutputLimitError)
      assert.equal(issue.partialText, '已生成正文结尾'); assert.equal(issue.reason, 'max_output_tokens')
      assert.equal(issue.retryable, false); assert.ok(!issue.message.includes('private screenplay'))
      return true
    })
    assert.equal(deltas.join(''), '已生成正文结尾')
    assert.equal(captured?.response_chars, '已生成正文结尾'.length)
    assert.equal(captured?.input_tokens, 123); assert.equal(captured?.output_tokens, 64)
    assert.equal(captured?.reasoning_tokens, 32); assert.equal(captured?.output_limit, 96000)
    assert.equal(captured?.http_status, 200); assert.ok((captured?.request_bytes || 0) > 0)
    if (transport === 'sse') assert.equal(captured?.upstream_request_id, 'terminal-limit')
  })
})

test('whitespace deltas preserve checkpointed documents through terminal output limits and semantic continuation', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async t => {
    const completed = scriptStageArtifacts.outline.slice(0, -1).map(artifact_type => ({ artifact_type,
      title: `完整 ${artifact_type}`, content: `林舟 keeps the promise，保留全部 空格与正文。` }))
    const raw = '{\n\t"artifacts": [\n' + completed.map(value => JSON.stringify(value)).join(',\n')
      + ',\n{"artifact_type":"episode_outline","title":"分集大纲","content":"截断尾部'
    const chunks = raw.split(/([ \t\r\n]+)/u).filter(Boolean)
    assert.ok(chunks.includes(' ')); assert.ok(chunks.some(value => value.includes('\n')))
    const steps = createGenerationSteps(), received: string[] = [], contracts: string[] = []
    const selected: GenerationModel = { ...model, protocol, settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
      structured_output_mode: 'json_schema', text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content',
      request_template: protocol === 'responses' ? { input: '{{prompt}}', max_output_tokens: 96000 }
        : { messages: [{ role: 'user', content: '{{prompt}}' }], max_completion_tokens: 24000 } } }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)), contract = body.text?.format?.name || body.response_format?.json_schema?.name
      contracts.push(contract)
      assert.equal(body[protocol === 'responses' ? 'max_output_tokens' : 'max_completion_tokens'], protocol === 'responses' ? 96000 : 24000)
      if (contract === 'workflow_draft') {
        const frames = protocol === 'responses'
          ? [{ type: 'response.reasoning_text.delta', delta: 'PRIVATE_REASONING' },
            { type: 'response.created', response: { status: 'in_progress', metadata: { content: 'PRIVATE_METADATA' } } },
            ...chunks.map(delta => ({ type: 'response.output_text.delta', delta })),
            { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
              output: [{ type: 'reasoning', content: [{ text: 'PRIVATE_REASONING' }] }, { type: 'message', content: [{ type: 'output_text', text: raw }] }] } }]
          : [{ choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING' }, finish_reason: null }], metadata: { content: 'PRIVATE_METADATA' } },
            ...chunks.map(content => ({ choices: [{ delta: { content }, finish_reason: null }] })),
            { choices: [{ message: { role: 'assistant', content: raw }, finish_reason: 'length' }] }]
        return new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      assert.equal(contract, 'script_stage_blocks')
      const retained = steps.checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[] }
      assert.deepEqual(retained.artifacts, completed, 'the exact received documents must survive before continuation starts')
      const prompt = protocol === 'responses' ? body.input : body.messages[0].content
      assert.ok(prompt.includes(JSON.stringify(completed)))
      const result = JSON.stringify({ blocks: [{ id: 'episode:1', title: '分集大纲', content: '第1集：林舟 fulfills the promise。', scenes: [] }], complete: true })
      return Response.json(protocol === 'responses' ? { status: 'completed', output_text: result }
        : { choices: [{ message: { content: result }, finish_reason: 'stop' }] })
    })
    const draft = await generateStageDraftWithContinuation(workflowRequest.parse({ stage: 'outline' }), '保留原稿和全部已完成正文。',
      (prompt, contract, onPartial) => {
        let cumulative = ''
        return streamText(selected, provider, { prompt, structured_output: contract }, undefined, event => {
          if (event.type === 'delta') { received.push(event.text); cumulative += event.text; onPartial?.(cumulative) }
        })
      }, { steps })
    assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks'], 'an output limit continues the missing document without replaying the stage')
    assert.equal(received.slice(0, chunks.length).join(''), raw, 'space, tab and newline deltas must reach the checkpoint reader unchanged')
    assert.ok(!received.join('').includes('PRIVATE_'), 'reasoning and metadata must not become screenplay text')
    assert.deepEqual(draft.artifacts.slice(0, -1), completed)
    assert.equal(draft.artifacts.at(-1)!.content, '第1集：林舟 fulfills the promise。')
    assert.deepEqual(steps.checkpoint.steps, {})
  })
})

test('Chat length terminal delta and nonstream message preserve partial text and the configured output budget', async t => {
  for (const transport of ['sse', 'json'] as const) await t.test(transport, async t => {
    const received: string[] = [], submitted: Record<string, unknown>[] = []
    let captured: TextRequestMetrics | undefined
    const usage = { prompt_tokens: 17, completion_tokens: 23, completion_tokens_details: { reasoning_tokens: 9 } }
    const choice = transport === 'sse' ? { delta: { content: '结尾' }, finish_reason: 'length' }
      : { message: { role: 'assistant', content: '已有正文结尾' }, finish_reason: 'length' }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      submitted.push(JSON.parse(String(init?.body)))
      return transport === 'json' ? Response.json({ choices: [choice], usage }) : new Response(
        'data: {"choices":[{"delta":{"content":"已有正文"},"finish_reason":null}]}\n\n'
        + `data: ${JSON.stringify({ choices: [choice], usage })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const selected: GenerationModel = { ...model, protocol: 'chat_completions', settings: { request_path: 'chat/completions', text_path: 'choices.0.message.content',
      request_template: { messages: [{ role: 'user', content: '{{prompt}}' }], max_completion_tokens: 24000, max_tokens: 7000 } } }
    await assert.rejects(streamText(selected, provider, { prompt: 'request' }, undefined,
      event => { if (event.type === 'delta') received.push(event.text) }, undefined, value => { captured = value }), issue => {
      assert.ok(issue instanceof TextOutputLimitError); assert.equal(issue.partialText, '已有正文结尾'); assert.equal(issue.reason, 'length'); return true
    })
    assert.equal(received.join(''), '已有正文结尾')
    assert.equal(captured?.reasoning_tokens, 9); assert.equal(captured?.output_limit, 24000)
    assert.equal(captured?.input_tokens, 17); assert.equal(captured?.output_tokens, 23)
    assert.equal(submitted[0]?.max_tokens, 7000)
  })
})

test('stream template budgets remain independent and absent budgets are not invented', async t => {
  for (const limit of [undefined, 150000]) await t.test(String(limit), async t => {
    let captured: TextRequestMetrics | undefined
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.max_output_tokens, limit); assert.equal(body.temperature, undefined)
      return Response.json({ status: 'completed', output_text: 'complete' })
    })
    const selected = { ...model, settings: { ...model.settings as object,
      request_template: { input: '{{prompt}}', max_output_tokens: 9000, temperature: 0.4 },
      stream_request_template: { input: '{{prompt}}', ...(limit ? { max_output_tokens: limit } : {}) } } }
    assert.equal(await streamText(selected, provider, { prompt: 'request' }, undefined, undefined, undefined, value => { captured = value }), 'complete')
    assert.equal(captured?.output_limit, limit)
  })
})

test('native tools reject truncated arguments without exposing them as continuable text', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async t => {
    const payload = protocol === 'responses'
      ? { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'function_call', call_id: 'unsafe', name: 'write_document', arguments: '{"content":"partial' }],
        usage: { input_tokens: 11, output_tokens: 19, output_tokens_details: { reasoning_tokens: 8 } } } }
      : { choices: [{ delta: { tool_calls: [{ index: 0, id: 'unsafe', function: { name: 'write_document', arguments: '{"content":"partial' } }] }, finish_reason: 'length' }],
        usage: { prompt_tokens: 11, completion_tokens: 19, completion_tokens_details: { reasoning_tokens: 8 } } }
    t.mock.method(globalThis, 'fetch', async () => new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }))
    const selected: GenerationModel = { ...model, protocol, settings: { request_path: 'generate', request_template: protocol === 'responses'
      ? { input: '{{prompt}}', max_output_tokens: 2000 } : { messages: [{ role: 'user', content: '{{prompt}}' }], max_tokens: 2000 } } }
    let captured: TextRequestMetrics | undefined
    const turn = textToolSession(selected, provider, 'write', [], () => '', undefined, undefined, value => { captured = value })
    await assert.rejects(turn(), issue => {
      assert.ok(issue instanceof TextProviderError); assert.ok(!(issue instanceof TextOutputLimitError))
      assert.equal(issue.retryable, false); assert.match(issue.message, /未执行工具调用/); return true
    })
    assert.equal(captured?.reasoning_tokens, 8); assert.equal(captured?.output_limit, 2000)
  })
})
