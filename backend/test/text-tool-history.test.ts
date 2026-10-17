import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactToolHistory, deduplicateToolHistory } from '../src/infrastructure/providers/text-tool-history.js'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'
const provider = { adapter: 'http' as const, base_url: 'https://test.invalid/v1' }
const args = '{"document_ids":["real"]}'
const state = { completed: ['已读取 real'], decisions: [], references: [{ tool: 'read_documents', arguments: args, facts: ['文稿仍未保存'] }], pending: ['继续核对'], errors: [] }
function model(protocol: 'chat_completions' | 'responses'): GenerationModel {
  return { id: 'text', remote_id: 'text', modality: 'text', protocol, settings: { tool_history_chars: 16000, request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
    request_template: { model: '{{model}}', ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) } } }
}
const reply = (content: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], output_text: JSON.stringify(content) })
test('duplicate bodies and complete results retain native pairing, fresh versions and real errors', () => {
  for (const responses of [false, true]) {
    const raw = JSON.stringify({ ok: true, result: { version: 'old', content: '原文内容。'.repeat(100) } })
    const output = (id: string, content: string) => responses ? { type: 'function_call_output', call_id: id, output: content } : { role: 'tool', tool_call_id: id, content }
    const history = [output('old', raw), output('same', raw), output('failure', JSON.stringify({ ok: false, error: '失败'.repeat(200) }))]
    const updated = deduplicateToolHistory(history, [{ id: 'fresh', output: JSON.stringify({ ok: true, result: { version: 'new', content: '原文内容。'.repeat(100) } }) }]) as Record<string, string>[]
    assert.equal(updated[0].call_id || updated[0].tool_call_id, 'old')
    const key = responses ? 'output' : 'content'
    assert.equal(JSON.parse(updated[0][key]).duplicate_of_call, 'same')
    assert.equal(JSON.parse(updated[1][key]).result.version, 'old')
    assert.match(JSON.parse(updated[1][key]).result.content, /fresh/)
    assert.equal(updated[2][key], (history[2] as Record<string, string>)[key])
    assert.match(raw, /原文内容/, 'actual tool result is never mutated')
  }
})
for (const protocol of ['chat_completions', 'responses'] as const) test(`${protocol} checkpoints bound each request and preserve all pending calls and private reasoning`, async t => {
  const initial = [{ role: 'user', content: '原任务与授权' }]
  const completed = protocol === 'responses' ? [
    { type: 'reasoning', encrypted_content: 'old-private' }, { type: 'function_call', call_id: 'old', name: 'read_documents', arguments: args },
    { type: 'function_call_output', call_id: 'old', output: JSON.stringify({ content: '源稿'.repeat(23000) }) },
  ] : [{ role: 'assistant', content: '<think>old-private</think>已读取', reasoning_content: 'old-private', tool_calls: [{ id: 'old', function: { name: 'read_documents', arguments: args } }] },
    { role: 'tool', tool_call_id: 'old', content: JSON.stringify({ content: '源稿'.repeat(23000) }) }]
  const pending = protocol === 'responses' ? [{ type: 'reasoning', encrypted_content: 'latest-private' },
    { type: 'function_call', call_id: 'new-1', name: 'read_documents', arguments: '{}' }, { type: 'function_call', call_id: 'new-2', name: 'read_documents', arguments: '{}' }]
    : [{ role: 'assistant', reasoning_content: 'latest-private', tool_calls: [{ id: 'new-1', function: { name: 'read_documents', arguments: '{}' } }, { id: 'new-2', function: { name: 'read_documents', arguments: '{}' } }] }]
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), prompt = body.input || body.messages[0].content
    assert.ok(prompt.length < 26000, `checkpoint request is bounded: ${prompt.length}`)
    assert.ok(!prompt.includes('old-private')); assert.ok(!prompt.includes('latest-private'))
    requests++; return reply(state)
  })
  const compacted = await compactToolHistory([...initial, ...completed, ...pending], 1, model(protocol), provider, () => '')
  assert.ok(requests > 1, 'oversized completed record is processed losslessly in independent requests')
  assert.deepEqual(compacted.slice(0, 1), initial)
  assert.deepEqual(compacted.slice(-pending.length), pending)
  assert.match((compacted[1] as { content: string }).content, /real/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(compactToolHistory([...initial, ...completed, ...pending], 1, model(protocol), provider, () => '', controller.signal), /abort/i)
})
test('checkpoint rejects fabricated tool references instead of dropping the real history', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply({ ...state, references: [{ tool: 'read_documents', arguments: '{"document_ids":["invented"]}', facts: [] }] }) })
  const history = [{ role: 'user', content: '原任务' }, { role: 'assistant', tool_calls: [{ id: 'old', function: { name: 'read_documents', arguments: args } }] },
    { role: 'tool', tool_call_id: 'old', content: '原文'.repeat(9000) }, { role: 'assistant', tool_calls: [{ id: 'new', function: { name: 'read_documents', arguments: '{}' } }] }]
  await assert.rejects(compactToolHistory(history, 1, model('chat_completions'), provider, () => ''), /不得编造/)
  assert.equal(calls, 2); assert.equal(history.length, 4)
})
