import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod'
import type { OutputContract } from '../src/modules/generation/model-output.js'
const directory = await mkdtemp(join(tmpdir(), 'source-submit-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db } = await import('../src/infrastructure/database/db.js')
const { generateScriptDraftSourceSubmit, scriptDraftSourceSubmitIdentity, generateScriptDraftCandidateSubmit, scriptDraftCandidateSubmitIdentity } = await import('../src/modules/script/script-draft-source-submit.js')
const { generateStructuredOutput } = await import('../src/modules/generation/model-output.js')
after(async () => { db.close(); await rm(directory, { force: true, recursive: true }) })
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const model = { id: 'native-source', remote_id: 'native-source', modality: 'text' as const, protocol: 'anthropic_messages' as const,
  settings: { text_api: { mode: 'standard', max_output_tokens: 65536, reasoning_effort: 'medium' } } }
const result = { summary: '原稿已正确，不改', source_edits: [] }
const schema = { type: 'object', properties: { summary: { type: 'string' }, source_edits: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'source_edits'], additionalProperties: false }
const contract: OutputContract = { name: 'script_draft_workset_source', schema }
const submit = (input: unknown, name = 'submit_source_repair', id = 'call-1') => ({ type: 'tool_use', id, name, input })
const message = (content: unknown[], stop_reason = 'tool_use') => Response.json({ type: 'message', content, stop_reason, usage: { input_tokens: 10, output_tokens: 20 } })

test('source submission sends exactly one declared tool, the complete prompt and original schema, with no schema text response mode', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body))
    assert.equal(body.tools.length, 1); assert.equal(body.tools[0].name, 'submit_source_repair'); assert.deepEqual(body.tools[0].input_schema, schema)
    assert.equal(body.output_config?.format, undefined); assert.deepEqual(body.thinking, { type: 'adaptive' }); assert.equal(body.output_config.effort, 'medium'); assert.equal(body.max_tokens, 65536); assert.equal(body.tool_choice.type, 'auto'); assert.equal(body.tool_choice.disable_parallel_tool_use, true)
    assert.ok(body.messages[0].content.includes('完整原稿/全部反馈/已确认决定/完整技能历史'))
    assert.ok(body.messages[0].content.startsWith(scriptDraftSourceSubmitIdentity.instruction))
    return message([{ type: 'thinking', thinking: 'PRIVATE_REASONING', signature: 'PRIVATE_SIGNATURE' }, submit(result)])
  })
  assert.equal(await generateScriptDraftSourceSubmit(model, provider, '完整原稿/全部反馈/已确认决定/完整技能历史', contract, () => ''), JSON.stringify(result))
  assert.equal(calls, 1)
})

test('wrapped output contract is submitted unchanged for the existing parser to unwrap', async t => {
  const wrapped = { ...contract, wrapped: true, schema: { type: 'object', properties: { result: schema }, required: ['result'] } }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)).tools[0].input_schema, wrapped.schema)
    return message([submit({ result })])
  })
  assert.equal(await generateScriptDraftSourceSubmit(model, provider, '完整原稿', wrapped, () => ''), JSON.stringify({ result }))
})

test('exact submission still passes through the existing schema validation and one format correction', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => message([submit(++calls === 1 ? { summary: '缺字段' } : result)]))
  const value = await generateStructuredOutput('script_draft_workset_source', z.object({ summary: z.string(), source_edits: z.array(z.never()) }).strict(),
    (prompt, output) => generateScriptDraftSourceSubmit(model, provider, prompt, output, () => ''), '原稿默认只读')
  assert.deepEqual(value, result); assert.equal(calls, 2)
})

test('text-only, wrong-tool and multiple-tool responses never adopt any result or execute a tool', async t => {
  for (const content of [[{ type: 'text', text: JSON.stringify(result) }], [submit(result, 'unrequested_tool')], [submit(result), submit(result, 'submit_source_repair', 'call-2')]]) {
    t.mock.method(globalThis, 'fetch', async () => message(content, content[0]!.type === 'text' ? 'end_turn' : 'tool_use'))
    await assert.rejects(generateScriptDraftSourceSubmit(model, provider, '原稿', contract, () => ''), error => {
      assert.equal((error as any).upstreamCode, 'invalid_tool_call'); assert.equal((error as any).retryable, false); assert.equal((error as any).delivery, 'completed'); return true
    })
    t.mock.restoreAll()
  }
})

test('EOF with a complete-looking tool block still fails and no hidden retry is performed', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response([{ type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: submit(result) }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } }].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  await assert.rejects(generateScriptDraftSourceSubmit(model, provider, '原稿', contract, () => ''), { upstreamCode: 'stream_disconnected' })
  assert.equal(calls, 1)
})

test('malformed arguments and non-source contracts reject before any adoption', async t => {
  t.mock.method(globalThis, 'fetch', async () => message([submit('not-an-object')]))
  await assert.rejects(generateScriptDraftSourceSubmit(model, provider, '原稿', contract, () => ''), { upstreamCode: 'invalid_tool_call' })
  t.mock.restoreAll(); t.mock.method(globalThis, 'fetch', async () => assert.fail('invalid local contract must not dispatch'))
  await assert.rejects(generateScriptDraftSourceSubmit(model, provider, '原稿', { ...contract, name: 'other' }, () => ''), /仅适用于/)
  await assert.rejects(generateScriptDraftSourceSubmit({ ...model, protocol: 'responses' }, provider, '原稿', contract, () => ''), /仅适用于/)
})


test('candidate submission declares exactly its own schema/tool and retains source protocol identity unchanged', async t => {
  const sourceBefore = JSON.stringify(scriptDraftSourceSubmitIdentity)
  const candidate = { summary: '当前稿已核对', edits: [] }
  const candidateSchema = { type: 'object', properties: { summary: { type: 'string' }, edits: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'edits'] }
  const output: OutputContract = { name: 'script_draft_workset_candidate', schema: candidateSchema }
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests++; const body = JSON.parse(String(init.body))
    assert.equal(body.tools.length, 1); assert.equal(body.tools[0].name, 'submit_draft_repair'); assert.deepEqual(body.tools[0].input_schema, candidateSchema)
    assert.equal(body.output_config?.format, undefined); assert.deepEqual(body.thinking, { type: 'adaptive' }); assert.equal(body.output_config.effort, 'medium'); assert.equal(body.max_tokens, 65536)
    assert.ok(body.messages[0].content.startsWith(scriptDraftCandidateSubmitIdentity.instruction)); assert.ok(body.messages[0].content.includes('冻结九稿/完整反馈/已确认方案/全部技能历史'))
    return message([{ type: 'thinking', thinking: 'PRIVATE_REASONING', signature: 'PRIVATE_SIGNATURE' }, submit(candidate, 'submit_draft_repair')])
  })
  assert.equal(await generateScriptDraftCandidateSubmit(model, provider, '冻结九稿/完整反馈/已确认方案/全部技能历史', output, () => ''), JSON.stringify(candidate))
  assert.equal(requests, 1); assert.equal(JSON.stringify(scriptDraftSourceSubmitIdentity), sourceBefore)
})

test('candidate text-only, wrong-tool, multiple calls, EOF and unrelated contracts never supply a result', async t => {
  const output: OutputContract = { name: 'script_draft_workset_candidate', schema: { type: 'object' } }
  for (const content of [[{ type: 'text', text: '{"summary":"not adopted","edits":[]}' }], [submit({}, 'submit_source_repair')],
    [submit({}, 'submit_draft_repair'), submit({}, 'submit_draft_repair', 'second')]]) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return message(content, content[0]!.type === 'text' ? 'end_turn' : 'tool_use') })
    await assert.rejects(generateScriptDraftCandidateSubmit(model, provider, '完整当前稿', output, () => ''), { upstreamCode: 'invalid_tool_call', delivery: 'completed', retryable: false })
    assert.equal(calls, 1); t.mock.restoreAll()
  }
  t.mock.method(globalThis, 'fetch', async () => new Response([{ type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: submit({}, 'submit_draft_repair') }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
  await assert.rejects(generateScriptDraftCandidateSubmit(model, provider, '完整当前稿', output, () => ''), { upstreamCode: 'stream_disconnected' })
  t.mock.restoreAll(); t.mock.method(globalThis, 'fetch', async () => assert.fail('unrelated contracts never dispatch'))
  for (const name of ['script_draft_workset_source','script_draft_workset_decisions','script_quality_review']) await assert.rejects(generateScriptDraftCandidateSubmit(model, provider, '完整当前稿', { ...output, name }, () => ''), /仅适用于/)
})
