import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { applyOutputContract, generateStructuredOutput, outputContract, restoreOptionalNulls, strictJsonSchema } from '../src/model-output.js'
import { streamText, type GenerationModel } from '../src/providers.js'
import { textToolSession } from '../src/text-tools.js'
import { workflowInstructions } from '../src/script-workflow.js'

test('native workflow instructions keep creative requirements without JSON-only protocol', () => {
  const request = { stage: 'characters' as const, scope: 'project' as const, episode_number: 0 }
  const native = workflowInstructions(request, 'tools')
  assert.match(native, /人物身份、目标、阻力/); assert.match(native, /create_document_draft/)
  assert.doesNotMatch(native, /只输出一个合法 JSON 对象/)
  assert.match(workflowInstructions(request), /只输出一个合法 JSON 对象/)
})

test('strict wire fields restore absent/default values while retaining intentional nullable fields', () => {
  const schema = z.object({ title: z.string(), note: z.string().optional(), scenes: z.array(z.string()).default([]), asset_id: z.string().nullable().optional() }).strict()
  const original = z.toJSONSchema(schema, { io: 'input' }), strict = strictJsonSchema(original)
  assert.deepEqual(strict.required, ['title', 'note', 'scenes', 'asset_id']); assert.equal(strict.additionalProperties, false)
  assert.deepEqual(schema.parse(restoreOptionalNulls({ title: '林晚', note: null, scenes: null, asset_id: null }, original)), { title: '林晚', scenes: [], asset_id: null })
})

test('response adapters preserve unrelated template fields and require explicit capability configuration', () => {
  const contract = outputContract('test_result', z.object({ content: z.string() }))
  const base = { model: 'anything', temperature: 0.4, text: { verbosity: 'low' }, response_format: { type: 'custom' } }
  assert.equal(applyOutputContract(base, 'responses', {}, contract), base)
  const response = applyOutputContract(base, 'responses', { structured_output_mode: 'json_schema' }, contract) as any
  assert.equal(response.text.verbosity, 'low'); assert.equal(response.text.format.strict, true); assert.equal(response.temperature, 0.4)
  const chat = applyOutputContract(base, 'chat_completions', { structured_output_mode: 'json_object' }, contract) as any
  assert.deepEqual(chat.response_format, { type: 'json_object' })
})

test('discriminated outputs use a root envelope and normalize optional null parameters', async () => {
  const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('discuss'), note: z.string().optional() }).strict(), z.object({ action: z.literal('create'), content: z.string() }).strict()])
  const result = await generateStructuredOutput('intent', schema, async (prompt, contract) => {
    assert.match(prompt, /result 字段/); assert.equal(contract!.schema.type, 'object')
    return JSON.stringify({ result: { action: 'discuss', note: null } })
  }, '判断请求')
  assert.deepEqual(result, { action: 'discuss' })
})

test('enveloped outputs preserve root definition references and trailing source data', async () => {
  const item = z.object({ title: z.string(), note: z.string().optional() }).meta({ id: 'shared_result' })
  const schema = z.union([item, z.null()]), contract = outputContract('union_with_refs', schema)
  assert.ok(contract.schema.$defs)
  assert.equal((contract.schema.properties as any).result.anyOf[0].$ref, '#/$defs/shared_result')
  const result = await generateStructuredOutput('union_with_refs', schema, async prompt => {
    assert.deepEqual(JSON.parse(prompt.split('资料：\n')[1]), { name: '林晚' })
    return JSON.stringify({ result: { title: '林晚', note: null } })
  }, '资料：\n' + JSON.stringify({ name: '林晚' }))
  assert.deepEqual(result, { title: '林晚' })
})

test('invalid results receive exactly one correction with diagnostics; valid text is preserved', async () => {
  let attempts = 0
  const content = '# 林晚\n记者，目标是找到妹妹。'
  const result = await generateStructuredOutput('document', z.object({ content: z.string().min(1) }).strict(), async prompt => {
    if (++attempts === 1) return '{"content":9}'
    assert.match(prompt, /一次格式修正/); assert.match(prompt, /content/)
    return JSON.stringify({ content })
  }, '写人物设定')
  assert.equal(attempts, 2); assert.equal(result.content, content)
  attempts = 0
  await assert.rejects(generateStructuredOutput('bad', z.object({ count: z.number() }), async () => { attempts++; return '缺少结果' }, '分析'), /已修正一次/)
  assert.equal(attempts, 2)
})

test('domain validation can correct IDs once; network failures and cancellation never retry', async () => {
  let attempts = 0
  assert.deepEqual(await generateStructuredOutput('ids', z.object({ id: z.string() }), async () => JSON.stringify({ id: ++attempts === 1 ? 'foreign' : 'selected' }), '选定场次', {
    validate: value => { if (value.id !== 'selected') throw new Error('场次不属于所选范围') },
  }), { id: 'selected' })
  attempts = 0
  await assert.rejects(generateStructuredOutput('network', z.object({}), async () => { attempts++; throw new Error('网络断开') }, '分析'), /网络断开/)
  assert.equal(attempts, 1)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(generateStructuredOutput('cancelled', z.object({}), async () => { attempts++; return '{}' }, '分析', { signal: controller.signal }), /abort/i)
  assert.equal(attempts, 1)
})

test('streaming sends task schemas and native tools discard conflicting text formats', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) {
    const model: GenerationModel = { id: 'fixture', remote_id: 'unrelated-name', modality: 'text', protocol, settings: {
      structured_output_mode: 'json_schema', strict_tool_arguments: true, request_path: protocol, text_path: 'output_text', stream: false,
      request_template: { model: '{{model}}', response_format: { type: 'json_object' }, text: { verbosity: 'low', format: { type: 'json_object' } }, ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) },
    } }
    const provider = { adapter: 'http' as const, base_url: 'https://mock.invalid' }
    const contract = outputContract('typed_result', z.object({ value: z.string() }).strict())
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (body.tools) {
        assert.equal(body.response_format, undefined); assert.equal(body.text.format, undefined); assert.equal(body.text.verbosity, 'low')
        const fn = protocol === 'responses' ? body.tools[0] : body.tools[0].function
        assert.equal(fn.strict, true); assert.deepEqual(fn.parameters.required, ['note'])
        return protocol === 'responses' ? Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '已完成' }] }] })
          : Response.json({ choices: [{ message: { content: '已完成' }, finish_reason: 'stop' }] })
      }
      const format = protocol === 'responses' ? body.text.format : body.response_format.json_schema
      assert.equal(format.strict, true); assert.equal(format.name, 'typed_result')
      return Response.json({ output_text: '{"value":"结果"}', ...(protocol === 'chat_completions' ? { choices: [{ message: { content: '{"value":"结果"}' }, finish_reason: 'stop' }] } : {}) })
    })
    assert.equal(await streamText(model, provider, { prompt: '结构化任务', structured_output: contract }), '{"value":"结果"}')
    assert.equal((await textToolSession(model, provider, '工具任务', [{ name: 'read', description: '读取', parameters: z.toJSONSchema(z.object({ note: z.string().optional() }).strict(), { io: 'input' }) }], () => '')()).text, '已完成')
    t.mock.restoreAll()
  }
})
