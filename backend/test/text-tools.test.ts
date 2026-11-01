import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textToolSession } from '../src/infrastructure/providers/text-tools.js'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { withUnrestrictedScriptExecution } from '../src/modules/generation/model-execution.js'

const functions = [{ name: 'read_documents', description: '读取', parameters: { type: 'object', properties: { document_ids: { type: 'array', items: { type: 'string' } } } } }]
const provider = { adapter: 'http' as const, base_url: 'https://test.invalid/v1', auth_header: 'X-Key', auth_prefix: '' }
const model = (protocol: 'responses' | 'chat_completions', stream = true): GenerationModel => ({ id: 'text', remote_id: 'configured-remote', modality: 'text', protocol, settings: {
  request_path: protocol === 'responses' ? 'responses' : 'chat/completions', stream,
  request_template: { model: '{{model}}', temperature: 0.3, ...(protocol === 'responses' ? { input: '{{prompt}}', reasoning: { effort: 'high' } } : { messages: [{ role: 'system', content: '保留配置' }, { role: 'user', content: '{{prompt}}' }] }) }
} })
const sse = (items: unknown[]) => new Response(items.map(item => `data: ${JSON.stringify(item)}\r\n\r\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })

test('script tool transport keeps waiting beyond former request and idle deadlines', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    t.mock.timers.tick(181 * 60_000)
    assert.equal(init.signal!.aborted, false)
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }] })
  })
  const response = await withUnrestrictedScriptExecution(() => textToolSession(model('responses', false), provider, 'request', functions, () => '')())
  assert.equal(response.text, '完成')
})

test('Chat Completions assembles fragmented calls and relays private reasoning, auth and template options', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests++
    assert.equal(String(url), 'https://test.invalid/v1/chat/completions')
    assert.equal((init.headers as Record<string, string>)['X-Key'], 'secret')
    assert.equal(body.model, 'configured-remote'); assert.equal(body.temperature, 0.3)
    assert.equal(body.parallel_tool_calls, false); assert.equal(body.tools[0].function.name, 'read_documents')
    if (requests === 1) return sse([
      { choices: [{ delta: { reasoning_content: 'private thought', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_documents', arguments: '{"document_' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ids":["doc-1"]}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.deepEqual(body.messages.slice(-2), [{ role: 'assistant', content: '', reasoning_content: 'private thought', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_documents', arguments: '{"document_ids":["doc-1"]}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }])
    return sse([{ choices: [{ delta: { content: '这是' } }] }, { choices: [{ delta: { content: '评审结论' }, finish_reason: 'stop' }] }])
  })
  const visibleText: string[] = []
  const session = textToolSession(model('chat_completions'), provider, '创作者请求', functions, () => 'secret', undefined, text => visibleText.push(text))
  const first = await session()
  assert.equal(first.text, '')
  assert.ok(first.metrics.request_bytes > 0); assert.equal(first.metrics.http_status, 200)
  assert.deepEqual(visibleText, [])
  assert.deepEqual(first.calls, [{ id: 'call-1', name: 'read_documents', arguments: '{"document_ids":["doc-1"]}' }])
  const second = await session([{ id: 'call-1', output: '{"ok":true}' }])
  assert.equal(second.text, '这是评审结论'); assert.equal(second.calls.length, 0)
  assert.deepEqual(visibleText, ['这是', '这是评审结论'])
})

test('Responses relays all completed output items and function outputs without exposing private reasoning', async t => {
  const output = [{ id: 'rs-1', type: 'reasoning', encrypted_content: 'opaque-reasoning', summary: [{ type: 'summary_text', text: 'private' }] },
    { type: 'function_call', id: 'fc-1', call_id: 'call-r', name: 'read_documents', arguments: '{"document_ids":["doc-1"]}' }]
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    assert.equal(body.tools[0].name, 'read_documents'); assert.equal(body.tools[0].type, 'function'); assert.equal(body.tools[0].function, undefined)
    assert.deepEqual(body.reasoning, { effort: 'high' })
    if (++requests === 1) return sse([{ type: 'response.output_item.done', output_index: 0, item: output[0] }, { type: 'response.output_item.done', output_index: 1, item: output[1] }, { type: 'response.completed', response: { status: 'completed', output } }])
    assert.deepEqual(body.input.slice(-3), [...output, { type: 'function_call_output', call_id: 'call-r', output: '{"documents":[]}' }])
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已阅读' }] }] })
  })
  const session = textToolSession(model('responses'), provider, 'request', functions, () => '')
  const first = await session(); assert.equal(first.text, ''); assert.equal(first.calls[0].id, 'call-r')
  assert.equal((await session([{ id: 'call-r', output: '{"documents":[]}' }])).text, '已阅读')
})

test('JSON Chat Completions tools and text are native, with configured streaming disabled', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).stream, false)
    return Response.json({ choices: [{ message: { content: 'reading', tool_calls: [{ id: 'json-call', type: 'function', function: { name: 'read_documents', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
  })
  const first = await textToolSession(model('chat_completions', false), provider, 'request', functions, () => '')()
  assert.equal(first.text, 'reading'); assert.equal(first.calls[0].id, 'json-call')
})

test('incomplete, truncated, duplicate and missing-call responses never return executable calls', async t => {
  const chatCall = { index: 0, id: 'c', function: { name: 'read_documents', arguments: '{}' } }
  const fixtures = [
    { protocol: 'chat_completions' as const, response: () => sse([{ choices: [{ delta: { tool_calls: [chatCall] } }] }]) },
    { protocol: 'chat_completions' as const, response: () => sse([{ choices: [{ delta: { tool_calls: [chatCall] }, finish_reason: 'length' }] }]) },
    { protocol: 'chat_completions' as const, response: () => Response.json({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'read_documents', arguments: '{}' } }, { id: 'c', function: { name: 'read_documents', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) },
    { protocol: 'responses' as const, response: () => Response.json({ status: 'incomplete', output: [{ type: 'function_call', call_id: 'c', name: 'read_documents', arguments: '{}' }] }) },
    { protocol: 'responses' as const, response: () => sse([{ type: 'response.failed', response: { status: 'failed' } }]) },
    { protocol: 'responses' as const, response: () => Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'read_documents', arguments: '{}' }] }) },
    { protocol: 'chat_completions' as const, response: () => Response.json({ choices: [] }) },
  ]
  for (const fixture of fixtures) {
    t.mock.method(globalThis, 'fetch', async () => fixture.response())
    await assert.rejects(textToolSession(model(fixture.protocol), provider, 'request', functions, () => '')(), /提前结束|截断|无效|完整/)
    t.mock.restoreAll()
  }
})

test('Responses output-limit failures explain the upstream reason without exposing prompt contents', async t => {
  const prompt = 'private original screenplay'
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' }, output: [] }))
  await assert.rejects(textToolSession(model('responses'), provider, prompt, functions, () => '')(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /已达到模型输出长度上限/)
    assert.ok(!error.message.includes(prompt))
    return true
  })
})

test('reasoning-only truncated tools remain nonretryable transport failures without continuation', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async t => {
    let requests = 0
    const response = protocol === 'responses'
      ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
        usage: { input_tokens: 5, output_tokens: 65535, output_tokens_details: { reasoning_tokens: 65535 } } }
      : { choices: [{ message: { content: '', tool_calls: [{ id: 'truncated', type: 'function', function: { name: 'read_documents', arguments: '{' } }] }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 65535, completion_tokens_details: { reasoning_tokens: 65535 } } }
    t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(response) })
    await assert.rejects(textToolSession(model(protocol), provider, 'request', functions, () => '')(), (issue: unknown) => {
      assert.ok(issue instanceof TextProviderError)
      assert.ok(!(issue instanceof TextOutputLimitError))
      assert.equal(issue.message, '模型输出被截断，未执行工具调用：已达到模型输出长度上限')
      assert.equal(issue.retryable, false)
      return true
    })
    assert.equal(requests, 1)
  })
})

test('abort and provider errors stop the tool session without falling back to simulated tools', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { init.signal!.throwIfAborted(); return Response.json({ error: 'unsupported tools' }, { status: 400 }) })
  await assert.rejects(textToolSession(model('responses'), provider, 'request', functions, () => '')(), /400/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(textToolSession(model('responses'), provider, 'request', functions, () => '', controller.signal)(), /abort/i)
})

test('partial and complete thought tags stay private during native streaming and in the final reply', async t => {
  t.mock.method(globalThis, 'fetch', async () => sse([
    { choices: [{ delta: { content: '<th' } }] },
    { choices: [{ delta: { content: 'ink>private-tagged-thought' } }] },
    { choices: [{ delta: { content: '</think>公开回复' }, finish_reason: 'stop' }] },
  ]))
  const visible: string[] = []
  const result = await textToolSession(model('chat_completions'), provider, 'request', functions, () => '', undefined, text => visible.push(text))()
  assert.deepEqual(visible, ['公开回复']); assert.equal(result.text, '公开回复')
  assert.match(JSON.stringify(result.history), /private-tagged-thought/, 'provider continuation retains its private history')
})

for (const protocol of ['chat_completions', 'responses'] as const) test(`${protocol} long tool sessions compact locally and deliver exact fresh results to the next decision`, async t => {
  let requests = 0
  const selectedModel = model(protocol, false)
  selectedModel.settings = { ...selectedModel.settings as Record<string, unknown>, tool_history_chars: 16000 }
  const results = [
    { id: 'call-1', output: JSON.stringify({ ok: true, result: { id: 'doc-1', version: 'v1', offset: 0, next_offset: 5000, content: '较早的正文。'.repeat(4000) } }) },
    { id: 'call-2', output: JSON.stringify({ ok: true, result: { id: 'doc-1', version: 'v1', offset: 5000, next_offset: 10000, content: '最新已完成正文。'.repeat(3000) } }) },
    { id: 'call-3', output: JSON.stringify({ ok: false, error: '需要补读后再核对', diagnostic: { retryable: true } }) },
  ]
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), history = protocol === 'responses' ? body.input : body.messages
    requests++
    assert.equal(body.tools.length, 1, 'no additional structured summary request is sent')
    if (requests === 4) {
      const checkpoint = history.find((item: { role?: string; content?: string }) => item.role === 'user' && item.content?.startsWith('程序上下文检查点'))
      assert.ok(checkpoint)
      assert.ok(!JSON.stringify(history).includes('较早的正文。'))
      for (const result of results.slice(1)) {
        const item = history.find((item: { call_id?: string; tool_call_id?: string }) => (item.call_id || item.tool_call_id) === result.id &&
          (protocol === 'responses' ? (item as { type?: string }).type === 'function_call_output' : (item as { role?: string }).role === 'tool'))
        assert.equal(protocol === 'responses' ? item.output : item.content, result.output, 'recent and freshly supplied result text is exact')
      }
      return protocol === 'responses' ? Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续补读' }] }] })
        : Response.json({ choices: [{ message: { content: '继续补读' }, finish_reason: 'stop' }] })
    }
    const id = `call-${requests}`, arguments_ = JSON.stringify({ document_ids: ['doc-1'], offset: (requests - 1) * 5000, length: 5000 })
    return protocol === 'responses' ? Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: id, name: 'read_documents', arguments: arguments_ }] })
      : Response.json({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_documents', arguments: arguments_ } }] }, finish_reason: 'tool_calls' }] })
  })
  const session = textToolSession(selectedModel, provider, '只生成预览，不自动保存。', functions, () => '')
  await session()
  await session([results[0]!])
  await session([results[1]!])
  assert.equal((await session([results[2]!])).text, '继续补读')
  assert.equal(requests, 4, 'each request is an actual task decision, with zero summary overhead')
})
