import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { applyOutputContract, generateStructuredOutput, isStructuredOutputError, nativeOutputContractPrompt, outputContract, restoreOptionalNulls, strictJsonSchema } from '../src/modules/generation/model-output.js'
import { streamText, type GenerationModel } from '../src/infrastructure/providers/providers.js'
import { textToolSession } from '../src/infrastructure/providers/text-tools.js'
import { workflowEnvelope, workflowInstructions } from '../src/modules/script/script-workflow.js'

test('native workflow instructions keep creative requirements without JSON-only protocol', () => {
  const request = { stage: 'characters' as const, scope: 'project' as const, episode_number: 0 }
  const native = workflowInstructions(request, 'tools')
  assert.match(native, /人物小传逐人列出身份[\s\S]*目标、动机[\s\S]*阻力/); assert.match(native, /create_document_draft/)
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

test('native contract compaction uses managed identity and preserves authored schema text and correction context', async () => {
  const schema = z.object({ answer: z.string().describe('SCHEMA_DESCRIPTION') }).strict()
  const authored = '原文中的契约不能删除：\n【本次结构化返回契约】\n' + JSON.stringify(outputContract('fixture', schema).schema)
  let calls = 0
  await generateStructuredOutput('fixture', schema, async (prompt, contract) => {
    calls++
    const native = nativeOutputContractPrompt(prompt, contract)
    assert.ok(native.endsWith(authored))
    assert.match(native, /仅返回一个 JSON 对象.*接口提供的 JSON Schema.*优先/)
    assert.equal(native.split('SCHEMA_DESCRIPTION').length - 1, 1, 'the authored schema remains; only the managed copy is omitted')
    assert.equal(prompt.split('SCHEMA_DESCRIPTION').length - 1, 2, 'the original prompt stays intact for fallback')
    assert.equal(nativeOutputContractPrompt(prompt, { ...contract! }), prompt, 'unmanaged contract copies cannot authorize removal')
    assert.equal(nativeOutputContractPrompt(authored, contract), authored, 'authored markers never identify a managed prefix')
    if (calls === 1) return '{"answer":7}'
    assert.match(native, /一次格式修正/)
    assert.match(native, /字段类型不合法/)
    return '{"answer":"完整"}'
  }, authored)
  assert.equal(calls, 2)
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

test('workflow correction identifies missing and extra fields at exact artifact paths without expanding the full enum', async () => {
  const content = '# 真官印\n方形铜印，缺角处铜绿发亮；原文要求与完整正文均须保留。'
  const invalid = JSON.stringify({ artifacts: [{ type: 'props', content }], scenes: [], summary: '多余的概括' })
  const corrected = { artifacts: [{ artifact_type: 'props' as const, title: '全剧道具清单', content }], scenes: [] }
  const guidance = '文档类型字段必须名为 artifact_type，不能使用 type；将原 type 的合法值写入 artifact_type 后删除 type，正文保持完整。'
  const source = '仅设计全剧道具，保持原故事、名称与使用规则。'
  const observations: Array<{ attempt: number; diagnostics?: string }> = []
  let calls = 0
  const result = await generateStructuredOutput('workflow_draft', workflowEnvelope, async text => {
    calls++
    assert.ok(text.endsWith(source), 'the complete original task remains available on every request')
    if (calls === 1) {
      assert.ok(!text.includes(guidance), 'task-specific correction guidance applies only to the bounded repair')
      return invalid
    }
    assert.match(text, /一次格式修正/)
    assert.ok(text.includes(guidance))
    assert.ok(text.includes(JSON.stringify(invalid)), 'the rejected invocation remains unchanged in the repair context')
    assert.match(text, /保留原任务内容、正文与范围/)
    return JSON.stringify(corrected)
  }, source, { correctionInstructions: guidance, onAttempt: (attempt, diagnostics) => observations.push({ attempt, diagnostics }) })
  assert.equal(calls, 2)
  assert.deepEqual(result, corrected)
  assert.equal(observations[0]!.diagnostics, undefined)
  const diagnostics = observations[1]!.diagnostics!
  assert.match(diagnostics, /\$\.artifacts\[0\]\.artifact_type: 缺少必填字段/)
  assert.match(diagnostics, /\$\.artifacts\[0\]\.title: 缺少必填字段/)
  assert.match(diagnostics, /\$\.artifacts\[0\]\.type: .*请删除该字段/)
  assert.match(diagnostics, /\$\.summary: .*请删除该字段/)
  assert.doesNotMatch(diagnostics, /Invalid option|episode_script|location_continuity/)
})

test('workflow correction reports illegal values and field types while retaining the full schema contract', async () => {
  let calls = 0, diagnostics = ''
  const result = await generateStructuredOutput('workflow_draft', workflowEnvelope, async (text, contract) => {
    calls++
    if (calls === 1) return JSON.stringify({ artifacts: [{ artifact_type: 'prop', title: 42, content: '原道具正文。' }], scenes: [] })
    assert.equal(contract!.schema.additionalProperties, false)
    assert.ok(text.includes('prop_visuals'), 'the complete schema still provides every allowed artifact type')
    return JSON.stringify({ artifacts: [{ artifact_type: 'props', title: '道具清单', content: '原道具正文。' }], scenes: [] })
  }, '全剧道具设计', { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.equal(calls, 2)
  assert.match(diagnostics, /\$\.artifacts\[0\]\.artifact_type: 字段取值不合法/)
  assert.match(diagnostics, /其余合法值见本次 Schema/)
  assert.match(diagnostics, /\$\.artifacts\[0\]\.title: 字段类型不合法，要求 string，当前为 number/)
  assert.doesNotMatch(diagnostics, /episode_script|Invalid option/)
  assert.equal(result.artifacts[0]!.content, '原道具正文。')
})

test('unrelated JSON candidates do not replace actionable workflow diagnostics with missing root fields', async () => {
  let calls = 0, diagnostics = ''
  await generateStructuredOutput('workflow_draft', workflowEnvelope, async () => {
    calls++
    if (calls === 1) return JSON.stringify({ artifacts: [{ type: 'props', title: '道具', content: '正文。' }], scenes: [] }) + '\n{"note":"额外说明对象"}'
    return JSON.stringify({ artifacts: [{ artifact_type: 'props', title: '道具', content: '正文。' }], scenes: [] })
  }, '全剧道具设计', { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.equal(calls, 2)
  assert.match(diagnostics, /\$\.artifacts\[0\]\.artifact_type/)
  assert.match(diagnostics, /\$\.artifacts\[0\]\.type/)
  assert.doesNotMatch(diagnostics, /\$\.artifacts: 缺少必填字段|\$\.note/)
})

test('a bare scene array is diagnosed at its root without presenting the last scene as the entire response', async () => {
  let calls = 0, diagnostics = ''
  const scenes = [{ heading: '前台', duration: 45 }, { heading: '会议室', duration: 35 }]
  const corrected = { artifacts: [{ artifact_type: 'episode_script', title: '第1集', content: '先在前台，再到会议室。' }], scenes }
  const result = await generateStructuredOutput('workflow_draft', workflowEnvelope, async () => {
    calls++
    return JSON.stringify(calls === 1 ? scenes : corrected)
  }, '返回完整分集正文与对应分场。', { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.equal(calls, 2)
  assert.match(diagnostics, /\$: 字段类型不合法，要求 object，当前为 array/)
  assert.doesNotMatch(diagnostics, /\$\.heading|\$\.duration|\$\.artifacts: 缺少必填字段/)
  assert.equal(result.scenes.length, 2)
})

test('damaged outer JSON does not diagnose a nested sound plan as the response root', async () => {
  const sound = { ambience: ['雨声'], acoustics: '室内', music_policy: 'timeline' }
  const schema = z.object({ scenes: z.array(z.object({ sound: z.object({ ambience: z.array(z.string()), acoustics: z.string(), music_policy: z.string() }).strict() }).strict()) }).strict()
  const raw = '{"scenes":[{"sound":' + JSON.stringify(sound)
  let calls = 0, diagnostics = ''
  const result = await generateStructuredOutput('controlled_storyboard', schema, async () => ++calls === 1 ? raw : JSON.stringify({ scenes: [{ sound }] }), '分镜规划',
    { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.equal(calls, 2)
  assert.match(diagnostics, /外层 JSON.*不完整|语法错误/)
  assert.doesNotMatch(diagnostics, /\$\.scenes: 缺少必填字段|\$\.(?:ambience|acoustics|music_policy).*删除/)
  assert.deepEqual(result, { scenes: [{ sound }] })
})

test('an actual sound-only root still receives its own missing and extra root field diagnostics', async () => {
  const schema = z.object({ scenes: z.array(z.string()) }).strict()
  let calls = 0, diagnostics = ''
  await generateStructuredOutput('controlled_storyboard', schema, async () => ++calls === 1
    ? '说明：\n```json\n' + JSON.stringify({ ambience: [], acoustics: '', music_policy: 'timeline' }) + '\n```' : '{"scenes":[]}', '分镜规划',
  { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.match(diagnostics, /\$\.scenes: 缺少必填字段/)
  assert.match(diagnostics, /\$\.ambience: .*删除/)
})

test('safe syntax recovery accepts the first response and still runs strict schema and semantic validation', async () => {
  const schema = z.object({ scenes: z.array(z.object({ text: z.string() }).strict()) }).strict()
  const text = '原话<think>不是推理</think>\r\n下一句，保持原文。'
  const raw = '{"scenes":[{"text":' + JSON.stringify(text).replaceAll('\\r', '\r').replaceAll('\\n', '\n') + ',},],}'
  let calls = 0, validations = 0
  const result = await generateStructuredOutput('controlled_storyboard', schema, async () => { calls++; return raw }, '分镜规划', {
    validate: value => { validations++; assert.equal(value.scenes[0]!.text, text) },
  })
  assert.equal(calls, 1)
  assert.equal(validations, 1)
  assert.equal(result.scenes[0]!.text, text)
  let semanticCalls = 0
  await assert.rejects(generateStructuredOutput('controlled_storyboard', schema, async () => { semanticCalls++; return raw }, '分镜规划',
    { validate: () => { throw new Error('台词来源不在本次剧本中') } }), /台词来源不在本次剧本中/)
  assert.equal(semanticCalls, 2)
  await assert.rejects(generateStructuredOutput('controlled_storyboard', schema, async () => '{"scenes":[{"text":"正文","extra":true,},],}', '分镜规划'), /\$\.scenes\[0\]\.extra: .*删除/)
})

test('persistent workflow field errors stop after one correction without silently discarding unknown fields', async () => {
  const invalid = JSON.stringify({ artifacts: [{ type: 'props', title: '道具', content: '不可丢失的原正文。' }], scenes: [] })
  let calls = 0
  await assert.rejects(generateStructuredOutput('workflow_draft', workflowEnvelope, async () => {
    calls++
    return invalid
  }, '全剧道具设计'), (error: unknown) => {
    const failure = error as Error & { statusCode: number; raw_output: string; diagnostics: string }
    assert.match(failure.message, /已修正一次/)
    assert.equal(failure.statusCode, 422)
    assert.equal(failure.raw_output, invalid)
    assert.match(failure.diagnostics, /\$\.artifacts\[0\]\.type: .*请删除该字段/)
    assert.ok(isStructuredOutputError(failure))
    assert.equal(failure.structuredOutputContract, 'workflow_draft')
    return true
  })
  assert.equal(calls, 2)
})

test('diagnostic output retains the complete bounded JSON and both ends of oversized results without external reasoning', async () => {
  const schema = z.object({ count: z.number() }).strict()
  const visible = JSON.stringify({ text: '正文<think>原文标记</think>' + '字'.repeat(8000), end: 'ROOT_TAIL' })
  await assert.rejects(generateStructuredOutput('diagnostic_fixture', schema, async () => '<think>PRIVATE_REASONING</think>\n' + visible, '核对'), (issue: unknown) => {
    const failure = issue as Error & { raw_output: string }
    assert.equal(failure.raw_output.trim(), visible)
    assert.doesNotMatch(failure.raw_output, /PRIVATE_REASONING/)
    assert.match(failure.raw_output, /<think>原文标记<\/think>/)
    assert.ok(failure.raw_output.includes('ROOT_TAIL'))
    return true
  })
  const oversized = JSON.stringify({ start: 'ROOT_HEAD', text: '字'.repeat(210000), end: 'ROOT_TAIL' })
  await assert.rejects(generateStructuredOutput('diagnostic_fixture', schema, async () => oversized, '核对'), (issue: unknown) => {
    const failure = issue as Error & { raw_output: string }
    assert.equal(failure.raw_output.length, 200000)
    assert.ok(failure.raw_output.startsWith('{"start":"ROOT_HEAD"'))
    assert.ok(failure.raw_output.endsWith('"end":"ROOT_TAIL"}'))
    assert.match(failure.raw_output, /中间内容已省略/)
    return true
  })
})

test('union corrections follow the actual target and operation and identify nested payload errors', async () => {
  const ending = z.object({ summary: z.string(), section_ids: z.array(z.number().int()) }).strict()
  const schema = z.object({ changes: z.array(z.union([
    z.object({ target: z.literal('story.summary'), operation: z.literal('replace'), value: z.string() }).strict(),
    z.object({ target: z.literal('story.ending'), operation: z.literal('remove'), value: z.null() }).strict(),
    z.object({ target: z.literal('story.ending'), operation: z.literal('replace'), value: ending }).strict(),
  ])) }).strict()
  let calls = 0, diagnostics = ''
  const result = await generateStructuredOutput('repair_union', schema, async () => {
    calls++
    return JSON.stringify({ changes: [{ target: 'story.ending', operation: 'replace',
      value: calls === 1 ? { summary: '入匣之后转运', invented: true } : { summary: '入匣之后转运', section_ids: [1] } }] })
  }, '修正结局时间，保留来源。', { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.equal(calls, 2)
  assert.match(diagnostics, /\$\.changes\[0\]\.value\.section_ids: 缺少必填字段/)
  assert.match(diagnostics, /\$\.changes\[0\]\.value\.invented: .*请删除该字段/)
  assert.doesNotMatch(diagnostics, /story.summary|remove|要求 string|要求 null|任一允许格式/)
  assert.deepEqual(result.changes[0]!.value, { summary: '入匣之后转运', section_ids: [1] })
})

test('unknown union targets and operations report their own choices without unrelated payload errors', async t => {
  const schema = z.object({ changes: z.array(z.union([
    z.object({ target: z.literal('summary'), operation: z.literal('replace'), value: z.string() }).strict(),
    z.object({ target: z.literal('ending'), operation: z.literal('replace'), value: z.object({ summary: z.string() }) }).strict(),
    z.object({ target: z.literal('ending'), operation: z.literal('remove'), value: z.null() }).strict(),
  ])) })
  for (const [key, change, allowed] of [
    ['target', { target: 'unknown', operation: 'replace', value: 7 }, /summary.*ending/],
    ['operation', { target: 'ending', operation: 'append', value: 7 }, /replace.*remove/],
  ] as const) await t.test(key, async () => {
    await assert.rejects(generateStructuredOutput('unknown_union', schema, async () => JSON.stringify({ changes: [change] }), '修订'), error => {
      assert.ok(isStructuredOutputError(error))
      assert.match(error.message, new RegExp(`\\$\\.changes\\[0\\]\\.${key}: 字段取值不合法`))
      assert.match(error.message, allowed)
      assert.doesNotMatch(error.message, /\.value|要求 string|要求 object|要求 null/)
      return true
    })
  })
})

test('enveloped union diagnostics resolve referenced branches and retain the wire prefix', async () => {
  const schema = z.union([
    z.object({ action: z.literal('count'), amount: z.number() }).strict().meta({ id: 'count_branch' }),
    z.object({ action: z.literal('text'), content: z.string() }).strict().meta({ id: 'text_branch' }),
  ])
  let calls = 0, diagnostics = ''
  const result = await generateStructuredOutput('referenced_union', schema, async () => JSON.stringify({ result:
    ++calls === 1 ? { action: 'count', amount: 'wrong' } : { action: 'count', amount: 2 } }), '统计',
  { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.match(diagnostics, /\$\.result\.amount: 字段类型不合法，要求 number，当前为 string/)
  assert.doesNotMatch(diagnostics, /content|text|任一允许格式/)
  assert.deepEqual(result, { action: 'count', amount: 2 })
})

test('generic corrections keep their own schema field names and do not introduce workflow-specific aliases', async () => {
  const schema = z.object({ type: z.string(), count: z.number() }).strict()
  let calls = 0
  const result = await generateStructuredOutput('inventory', schema, async text => {
    calls++
    if (calls === 1) return '{"type":8,"count":2}'
    assert.match(text, /\$\.type: 字段类型不合法/)
    assert.doesNotMatch(text, /artifact_type/)
    return '{"type":"copper","count":2}'
  }, '统计铜印')
  assert.equal(calls, 2)
  assert.deepEqual(result, { type: 'copper', count: 2 })
})

test('wrapped result diagnostics include the wire envelope and array index in the exact field path', async () => {
  let calls = 0, diagnostics = ''
  const result = await generateStructuredOutput('count_list', z.array(z.object({ count: z.number() }).strict()), async () => {
    calls++
    return calls === 1 ? '{"result":[{"count":"wrong"}]}' : '{"result":[{"count":2}]}'
  }, '统计数量', { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
  assert.equal(calls, 2)
  assert.match(diagnostics, /\$\.result\[0\]\.count: 字段类型不合法/)
  assert.deepEqual(result, [{ count: 2 }])
})

test('domain validation can correct IDs once; network failures and cancellation never retry', async () => {
  let attempts = 0
  assert.deepEqual(await generateStructuredOutput('ids', z.object({ id: z.string() }), async () => JSON.stringify({ id: ++attempts === 1 ? 'foreign' : 'selected' }), '选定场次', {
    validate: value => { if (value.id !== 'selected') throw new Error('场次不属于所选范围') },
  }), { id: 'selected' })
  attempts = 0
  await assert.rejects(generateStructuredOutput('network', z.object({}), async () => { attempts++; throw new Error('网络断开') }, '分析'), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /网络断开/)
    assert.equal(isStructuredOutputError(error), false)
    return true
  })
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
