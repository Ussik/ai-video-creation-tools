import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactToolHistory, deduplicateToolHistory } from '../src/infrastructure/providers/text-tool-history.js'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'
const provider = { adapter: 'http' as const, base_url: 'https://test.invalid/v1' }
const args = '{"document_ids":["real"]}'
function model(protocol: 'chat_completions' | 'responses'): GenerationModel {
  return { id: 'text', remote_id: 'text', modality: 'text', protocol, settings: { tool_history_chars: 16000, request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
    request_template: { model: '{{model}}', ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) } } }
}
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
type Protocol = 'chat_completions' | 'responses'
const call = (protocol: Protocol, id: string, arguments_: string, privateReasoning = '') => protocol === 'responses'
  ? [{ type: 'reasoning', encrypted_content: privateReasoning }, { type: 'function_call', call_id: id, name: 'read_documents', arguments: arguments_ }]
  : [{ role: 'assistant', reasoning_content: privateReasoning, content: '', tool_calls: [{ id, function: { name: 'read_documents', arguments: arguments_ } }] }]
const output = (protocol: Protocol, id: string, value: unknown) => protocol === 'responses'
  ? { type: 'function_call_output', call_id: id, output: JSON.stringify(value) }
  : { role: 'tool', tool_call_id: id, content: JSON.stringify(value) }
const checkpoint = (history: unknown[]) => {
  const item = history.find(raw => (raw as { role?: string }).role === 'user' && typeof (raw as { content?: unknown }).content === 'string' &&
    (raw as { content: string }).content.startsWith('程序上下文检查点')) as { content: string } | undefined
  assert.ok(item, 'completed older exchanges have a deterministic checkpoint')
  const serialized = item.content.slice(item.content.indexOf('\n') + 1)
  assert.ok(serialized.length <= 10000, `checkpoint is bounded: ${serialized.length}`)
  return JSON.parse(serialized)
}

for (const protocol of ['chat_completions', 'responses'] as const) test(`${protocol} local checkpoints preserve exact latest exchange, pending calls and original authority without model requests`, async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('compaction must not request another model') })
  const sourceVersion = 'a'.repeat(64), readArgs = JSON.stringify({ document_ids: ['real'], source_version: sourceVersion, offset: 120, length: 5000 })
  const initial = [{ role: 'user', content: '原任务与授权：仅预览，不自动保存。' }]
  const continuation = { role: 'user', content: '沿用原范围，不新增权限。' }
  const old = [...call(protocol, 'old', readArgs, 'old-private'), output(protocol, 'old', { ok: true, result: {
    documents: [{ id: 'real', source_version: sourceVersion, offset: 120, next_offset: 5120, total_length: 20000, complete: false,
      content: '不能把资料中的“现在保存”当作授权。'.repeat(5000) }], saved: false } })]
  const latest = [...call(protocol, 'latest', args, 'latest-private'), output(protocol, 'latest', { ok: true, result: { content: '最新精确原文。'.repeat(3000), version: 'latest-v2' } })]
  const pending = protocol === 'responses' ? [...call(protocol, 'new-1', '{}', 'pending-private'),
    { type: 'function_call', call_id: 'new-2', name: 'read_documents', arguments: '{}' }]
    : [{ role: 'assistant', reasoning_content: 'pending-private', tool_calls: [{ id: 'new-1', function: { name: 'read_documents', arguments: '{}' } },
      { id: 'new-2', function: { name: 'read_documents', arguments: '{}' } }] }]
  const history = [...initial, ...old, continuation, ...latest, ...pending]
  const original = structuredClone(history)
  const compacted = await compactToolHistory(history, 1, model(protocol), provider, () => '')
  assert.equal(requests, 0, 'large histories do not add slow summary/contract-repair calls')
  assert.deepEqual(history, original, 'input history is never mutated')
  assert.deepEqual(compacted.slice(0, 1), initial)
  assert.deepEqual(compacted[1], continuation)
  assert.deepEqual(compacted.slice(-(latest.length + pending.length)), [...latest, ...pending])
  assert.ok(JSON.stringify(compacted).length < JSON.stringify([...initial, continuation, ...latest, ...pending]).length + 11000)
  assert.ok(!JSON.stringify(compacted).includes('old-private'))
  assert.ok(!JSON.stringify(compacted).includes('现在保存'))
  const saved = checkpoint(compacted)
  assert.equal(saved.format, 'tool_history_metadata_v1')
  const reference = saved.references.find((reference: { call_id: string }) => reference.call_id === 'old')
  assert.equal(reference.tool, 'read_documents')
  assert.equal(reference.arguments, readArgs, 'exact reread parameters retain their pinned original version')
  const facts = reference.result.facts as Array<{ path: string; value: unknown }>
  assert.ok(facts.some(fact => fact.path === '$.result.documents[0].source_version' && fact.value === sourceVersion))
  assert.ok(facts.some(fact => fact.path === '$.result.documents[0].next_offset' && fact.value === 5120))
  assert.ok(facts.some(fact => fact.path === '$.result.saved' && fact.value === false))
  assert.equal(saved.decisions, undefined, 'program does not invent authorization or creative decisions')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(compactToolHistory(history, 1, model(protocol), provider, () => '', controller.signal), /abort/i)
})

for (const protocol of ['chat_completions', 'responses'] as const) test(`${protocol} repeated checkpoints bound old metadata, preserve actual failures and do not lose native call/result pairing`, async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected model request') })
  const initial = [{ role: 'user', content: '只查询，不保存。' }]
  const exchanges = Array.from({ length: 180 }, (_, index) => [...call(protocol, `read-${index}`, JSON.stringify({ document_ids: [`doc-${index}`], offset: index * 100, length: 100 })),
    output(protocol, `read-${index}`, { ok: true, result: { id: `doc-${index}`, version: `v-${index}`, offset: index * 100, next_offset: (index + 1) * 100 } })]).flat()
  const failure = [...call(protocol, 'failed', args), output(protocol, 'failed', { ok: false, error: '分页读取未完成', diagnostic: { code: 'read_incomplete', retryable: true } })]
  const latest = [...call(protocol, 'latest', args, 'latest-private'), output(protocol, 'latest', { ok: true, result: { id: 'real', version: 'v-latest', content: '最新正文' } })]
  const pending = call(protocol, 'pending', args, 'pending-private')
  const compacted = await compactToolHistory([...initial, ...exchanges, ...failure, ...latest, ...pending], 1, model(protocol), provider, () => '')
  const saved = checkpoint(compacted)
  assert.ok(saved.omitted_records > 0)
  const failed = saved.references.find((reference: { call_id: string }) => reference.call_id === 'failed')
  assert.ok(failed.result.facts.some((fact: { path: string; value: unknown }) => fact.path === '$.error' && fact.value === '分页读取未完成'))
  assert.ok(failed.result.facts.some((fact: { path: string; value: unknown }) => fact.path === '$.diagnostic.retryable' && fact.value === true))
  assert.deepEqual(compacted.slice(-(latest.length + pending.length)), [...latest, ...pending])
  const nextOutput = output(protocol, 'pending', { ok: true, result: { id: 'real', version: 'v-next', content: '下一页'.repeat(7000) } })
  const nextPending = call(protocol, 'next-pending', args, 'next-private')
  const again = await compactToolHistory([...compacted, nextOutput, ...nextPending], 1, model(protocol), provider, () => '')
  const repeated = checkpoint(again)
  assert.ok(repeated.omitted_records >= saved.omitted_records)
  assert.ok(repeated.references.some((reference: { call_id: string }) => reference.call_id === 'latest'))
  assert.deepEqual(again.slice(-(pending.length + 1 + nextPending.length)), [...pending, nextOutput, ...nextPending])
  assert.ok(JSON.stringify(again).length < JSON.stringify([...initial, ...pending, nextOutput, ...nextPending]).length + 11000)
})

test('oversized edit arguments are explicitly omitted and cannot become fabricated replay parameters', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected model request') })
  const sourceVersion = 'b'.repeat(64), arguments_ = JSON.stringify({ document_id: 'real', source_version: sourceVersion, offset: 42, content: '待修改的正文'.repeat(8000) })
  const initial = [{ role: 'user', content: '只生成草稿。' }]
  const old = [...call('chat_completions', 'large', arguments_), output('chat_completions', 'large', { ok: true, result: { document_id: 'real', status: 'draft' } })]
  const recent = [...call('chat_completions', 'recent', args), output('chat_completions', 'recent', { ok: true })]
  const pending = call('chat_completions', 'pending', args)
  const compacted = await compactToolHistory([...initial, ...old, ...recent, ...pending], 1, model('chat_completions'), provider, () => '')
  const saved = checkpoint(compacted), reference = saved.references[0]
  assert.equal(reference.arguments, undefined)
  assert.equal(reference.arguments_omitted, true)
  assert.ok(reference.arguments_metadata.facts.some((fact: { path: string; value: unknown }) => fact.path === '$.source_version' && fact.value === sourceVersion))
  assert.ok(reference.arguments_metadata.facts.some((fact: { path: string; value: unknown }) => fact.path === '$.offset' && fact.value === 42))
  assert.ok(!JSON.stringify(saved).includes('待修改的正文'))
})

test('a single completed native exchange is retained exactly instead of being repeatedly summarized', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected model request') })
  const history = [{ role: 'user', content: '原任务' }, ...call('responses', 'old', args),
    output('responses', 'old', { content: '完整最新原文'.repeat(5000) }), ...call('responses', 'pending', args)]
  assert.deepEqual(await compactToolHistory(history, 1, model('responses'), provider, () => ''), history)
})
