import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textToolSession, type ToolCall } from '../src/infrastructure/providers/text-tools.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { streamText, type GenerationModel } from '../src/infrastructure/providers/providers.js'
import { claimModelAttempt, runModelStep } from '../src/modules/generation/model-execution.js'

type Protocol = 'chat_completions' | 'responses'
const protocols: Protocol[] = ['chat_completions', 'responses']
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const tools = [
  { name: 'read_documents', description: '阅读当前文档', parameters: {
    type: 'object', properties: { document_ids: { type: 'array', items: { type: 'string' } } }, required: ['document_ids'], additionalProperties: false,
  } },
  { name: 'create_document_draft', description: '准备草稿', parameters: {
    type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false,
  } },
]
const encoder = new TextEncoder()
const settings = (protocol: Protocol): GenerationModel => ({
  id: 'recovery', remote_id: 'recovery', modality: 'text', protocol,
  settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
    request_template: { model: '{{model}}', ...(protocol === 'responses'
      ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) } },
})
function completed(protocol: Protocol, calls: ToolCall[] = [], text = '') {
  return protocol === 'responses'
    ? Response.json({ status: 'completed', output: [
      ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
      ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
    ] })
    : Response.json({ choices: [{ message: { role: 'assistant', content: text,
      ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
    }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
}
function partial(protocol: Protocol) {
  return protocol === 'responses'
    ? { type: 'response.output_item.done', output_index: 0, item: {
      type: 'function_call', call_id: 'unsafe-partial', name: 'create_document_draft', arguments: '{"content":"UNSAFE_PARTIAL',
    } }
    : { choices: [{ delta: { tool_calls: [{ index: 0, id: 'unsafe-partial', function: {
      name: 'create_document_draft', arguments: '{"content":"UNSAFE_PARTIAL',
    } }] } }] }
}
function interrupted(protocol: Protocol, reason: 'terminated' | 'eof', onRead?: () => void) {
  let reads = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(partial(protocol))}\n\n`)); return }
      onRead?.()
      if (reason === 'terminated') controller.error(new TypeError('terminated', {
        cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
      }))
      else controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}
function outputs(body: Record<string, unknown>, protocol: Protocol) {
  return (body[protocol === 'responses' ? 'input' : 'messages'] as Array<Record<string, unknown>>)
    .filter(item => item.type === 'function_call_output' || item.role === 'tool')
}

for (const protocol of protocols) for (const failure of ['terminated', 'eof'] as const) {
  test(`${protocol} retries one interrupted decision without replaying tools or retaining partial function arguments (${failure})`, async t => {
    const bodies: Array<Record<string, unknown>> = []
    const executed: string[] = []
    const readCall = { id: 'read-complete', name: 'read_documents', arguments: '{"document_ids":["episode-1"]}' }
    const finalCall = { id: 'draft-complete', name: 'create_document_draft', arguments: '{"content":"完整的新设计正文"}' }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length === 1) return completed(protocol, [readCall])
      if (bodies.length === 2) return interrupted(protocol, failure)
      if (bodies.length === 3) return completed(protocol, [finalCall])
      if (bodies.length === 4) return completed(protocol, [], '草稿已准备，等待确认')
      assert.fail('no further request may replay an already completed operation')
    })
    const turn = textToolSession(settings(protocol), provider, '重新设计第一集，保留创作要求', tools, () => '')
    const first = await turn()
    assert.deepEqual(first.calls, [readCall]); executed.push(...first.calls.map(call => call.id))
    const result = await turn([{ id: readCall.id, output: '{"ok":true,"result":{"content":"当前有效原文","version":"v1"}}' }])
    assert.deepEqual(result.calls, [finalCall]); executed.push(...result.calls.map(call => call.id))
    assert.deepEqual(bodies[1], bodies[2], 'retry sends the same authorized context and real completed outputs')
    assert.equal(outputs(bodies[2], protocol).length, 1, 'completed read is relayed exactly once')
    assert.ok(!JSON.stringify(result.history).includes('UNSAFE_PARTIAL'), 'incomplete arguments are never adopted into history')
    assert.ok(!JSON.stringify(result.history).includes('unsafe-partial'))
    const done = await turn([{ id: finalCall.id, output: '{"ok":true,"saved":false,"draft_id":"draft-1"}' }])
    assert.equal(done.text, '草稿已准备，等待确认')
    assert.deepEqual(executed, ['read-complete', 'draft-complete'], 'only complete final calls are executable')
    assert.equal(bodies.length, 4)
    const relayed = outputs(bodies[3], protocol)
    assert.deepEqual(relayed.map(item => item.call_id || item.tool_call_id), ['read-complete', 'draft-complete'])
    assert.ok(!JSON.stringify(bodies[3]).includes('UNSAFE_PARTIAL'))
  })
}

for (const protocol of protocols) {
  test(`${protocol} retries HTTP 503 only for the pending model decision`, async t => {
    const bodies: string[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return bodies.length === 1
        ? Response.json({ error: { code: 'service_unavailable', message: 'temporary' } }, { status: 503 })
        : completed(protocol, [], '已恢复本轮处理')
    })
    assert.equal((await textToolSession(settings(protocol), provider, '仅本轮请求', tools, () => '')()).text, '已恢复本轮处理')
    assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1])
  })

  test(`${protocol} a persistent connection failure stops after one retry with a usable Chinese error`, async t => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => { requests++; return interrupted(protocol, 'terminated') })
    await assert.rejects(textToolSession(settings(protocol), provider, '重试当前决策', tools, () => '')(), issue => {
      assert.ok(issue instanceof TextProviderError); assert.equal(issue.retryable, true)
      assert.notEqual(issue.message, 'terminated'); assert.match(issue.message, /[\u4e00-\u9fff]/)
      return true
    })
    assert.equal(requests, 2, 'transport recovery cannot create an unbounded model loop')
  })

  test(`${protocol} cancellation during reception never retries or returns partial calls`, async t => {
    const controller = new AbortController(); let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      return interrupted(protocol, 'eof', () => controller.abort(new DOMException('创作者停止', 'AbortError')))
    })
    await assert.rejects(textToolSession(settings(protocol), provider, '停止后不重发', tools, () => '', controller.signal)(), /创作者停止|abort/i)
    assert.equal(requests, 1)
  })

  test(`${protocol} an already cancelled decision never contacts the provider`, async t => {
    const controller = new AbortController(); controller.abort(new DOMException('创作者停止', 'AbortError'))
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('cancelled work must not contact the model') })
    await assert.rejects(textToolSession(settings(protocol), provider, '不发送已取消任务', tools, () => '', controller.signal)(), /创作者停止|abort/i)
  })

  test(`${protocol} decision recovery respects an enclosing step's shared attempt limit`, async t => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      return Response.json({ error: { code: 'service_unavailable', message: 'temporary' } }, { status: 503 })
    })
    await assert.rejects(runModelStep('script_tool_decision', undefined, async () => {
      claimModelAttempt(); claimModelAttempt()
      return textToolSession(settings(protocol), provider, '共用当前步骤的三次请求额度', tools, () => '')()
    }), issue => issue instanceof TextProviderError && issue.upstreamStatus === 503)
    assert.equal(requests, 1, 'the final available attempt cannot start another network retry')
  })

  test(`${protocol} a Retry-After beyond the current step deadline does not start another request`, async t => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      return Response.json({ error: { code: 'service_unavailable', message: 'temporary' } }, {
        status: 503, headers: { 'Retry-After': '120' },
      })
    })
    await assert.rejects(runModelStep('script_tool_decision', undefined,
      () => textToolSession(settings(protocol), provider, '不越过步骤期限等待重发', tools, () => '')(), 1000),
    issue => issue instanceof TextProviderError && issue.upstreamStatus === 503)
    assert.equal(requests, 1)
  })

  test(`${protocol} cancellation during retry backoff prevents the second model request`, async t => {
    const controller = new AbortController(); let requests = 0
    let cancellation: ReturnType<typeof setTimeout> | undefined
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      cancellation = setTimeout(() => controller.abort(new DOMException('创作者停止等待', 'AbortError')), 20)
      return Response.json({ error: { code: 'service_unavailable', message: 'temporary' } }, { status: 503 })
    })
    try {
      await assert.rejects(textToolSession(settings(protocol), provider, '停止后不自动重发', tools, () => '', controller.signal)(), /创作者停止等待|abort/i)
      assert.equal(requests, 1)
    } finally { clearTimeout(cancellation) }
  })

  for (const failure of ['filter', 'length', 'invalid_call', 'http400'] as const) {
    test(`${protocol} ${failure} is not a recoverable transport failure`, async t => {
      let requests = 0
      t.mock.method(globalThis, 'fetch', async () => {
        requests++
        if (failure === 'http400') return Response.json({ error: { code: 'invalid_request_error', message: 'invalid configuration' } }, { status: 400 })
        if (failure === 'invalid_call') return completed(protocol, [
          { id: '', name: 'create_document_draft', arguments: '{}' },
        ])
        return protocol === 'responses'
          ? Response.json({ status: 'incomplete', incomplete_details: { reason: failure === 'length' ? 'max_output_tokens' : 'content_filter' }, output: [] })
          : Response.json({ choices: [{ message: { content: '' }, finish_reason: failure === 'length' ? 'length' : 'content_filter' }] })
      })
      await assert.rejects(textToolSession(settings(protocol), provider, '保持契约和质量检查', tools, () => '')())
      assert.equal(requests, 1, 'invalid or rejected output must not be retried as a transient network problem')
    })
  }
}

test('ordinary text reception also normalizes terminated into a Chinese retryable provider error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new TypeError('terminated', {
      cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
    })) },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(settings('responses'), provider, { prompt: '不可暴露的剧本正文' }), issue => {
    assert.ok(issue instanceof TextProviderError); assert.equal(issue.retryable, true)
    assert.notEqual(issue.message, 'terminated'); assert.match(issue.message, /[\u4e00-\u9fff]/)
    assert.ok(!issue.message.includes('不可暴露的剧本正文'))
    return true
  })
})
