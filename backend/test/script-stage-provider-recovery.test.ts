import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamText, type GenerationModel } from '../src/infrastructure/providers/providers.js'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation, type StageStreamGenerator } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const provider = { adapter: 'http' as const, base_url: 'https://stage-provider-recovery.invalid/v1' }
const model: GenerationModel = { id: 'stage-recovery-fixture', remote_id: 'fixture', modality: 'text', protocol: 'responses',
  settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' },
    structured_output_mode: 'json_schema', output_reserve_tokens: 128000, context_window_tokens: 1048576 } }
const request = workflowRequest.parse({ stage: 'outline', artifact_types: ['hooks'] })
const prompt = '完整原稿：第一集阿禾保存钥匙；第二集阿禾交还钥匙。创作者要求：保留现实因果，不新增超自然力量。'
const block = (id: string, content: string) => ({ id, title: '钩子预设', content, scenes: [] })
const first = block('hook:ep01', '第1集：阿禾为何保存钥匙？第2集以守夜记录揭晓原因。')
const second = block('hook:ep02', '第2集：阿禾归还钥匙，旧屋真相随账本揭晓，兑现全剧悬念。')
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const eventResponse = (raw: string, terminal: unknown) => new Response(
  frame({ type: 'response.output_text.delta', delta: raw }) + frame(terminal),
  { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'stage-fixture-request' } },
)
function workspace() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return { runner: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    snapshot: () => structuredClone(checkpoint) }
}
function transport(contracts: Array<string | undefined>, signal?: AbortSignal): StageStreamGenerator {
  return (text, contract, onPartial) => {
    contracts.push(contract?.name)
    let raw = ''
    return streamText(model, provider, { prompt: text, structured_output: contract }, undefined,
      event => { if (event.type === 'delta') { raw += event.text; onPartial?.(raw) } }, signal)
  }
}

test('a Responses bad_response_body after a complete continuation block preserves it and resumes without rewriting the target', async t => {
  const store = workspace(), contracts: Array<string | undefined> = [], sent: string[] = []
  const originalSettings = structuredClone(model.settings)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    sent.push(body.input)
    assert.equal(body.max_output_tokens, undefined, 'a local reserve must not become an invented upstream quota')
    if (++calls === 1) return eventResponse('{"artifacts":[{"artifact_type":"hooks","title":"钩子预设","content":"未闭合',
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 100, output_tokens: 8188 } } })
    if (calls === 2) return eventResponse('{"blocks":[' + JSON.stringify(first) + ',{"id":"hook:ep02","content":"未闭合',
      { type: 'response.failed', response: { status: 'failed', error: { code: 'bad_response_body', message: 'upstream private details' } } })
    assert.equal(calls, 3)
    assert.ok(body.input.includes(prompt))
    assert.ok(body.input.includes(JSON.stringify(first)), 'the actual next request includes retained prose verbatim')
    assert.ok(!body.input.includes('未闭合'), 'incomplete strings are never accepted as prior content')
    return eventResponse(JSON.stringify({ blocks: [second], complete: true }),
      { type: 'response.completed', response: { status: 'completed' } })
  })
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, transport(contracts), { steps: store.runner() }), error => {
    assert.ok(error instanceof TextProviderError)
    assert.ok(!(error instanceof TextOutputLimitError), 'a malformed upstream body is distinct from length exhaustion')
    assert.equal(error.upstreamCode, 'bad_response_body')
    return true
  })
  assert.equal(calls, 2, 'the failed transport does not automatically repeat the partially retained request')
  const saved = store.snapshot().steps['draft:stream:state']!.value as { blocks: unknown[] }
  assert.deepEqual(saved.blocks, [first])
  const draft = await generateStageDraftWithContinuation(request, prompt, transport(contracts), { steps: store.runner() })
  assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks', 'script_stage_blocks'])
  assert.equal(draft.artifacts[0]!.content, first.content + '\n\n' + second.content)
  assert.equal(sent.length, 3)
  assert.deepEqual(store.snapshot().steps, {})
  assert.deepEqual(model.settings, originalSettings)
})

test('an initial Responses failure retains closed documents but cannot approve a damaged response or replace its accepted prose', async t => {
  const store = workspace(), contracts: Array<string | undefined> = []
  const source = { artifact_type: 'outline', title: '概要设计', content: '阿禾保存并归还钥匙，以守夜记录澄清旧屋真相。' }
  const req = workflowRequest.parse({ stage: 'outline', artifact_types: ['outline', 'hooks'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (++calls === 1) return eventResponse('{"artifacts":[' + JSON.stringify(source) + ',{"artifact_type":"hooks","content":"未闭合',
      { type: 'response.failed', response: { status: 'failed', error: { code: 'bad_response_body' } } })
    const body = JSON.parse(String(init?.body))
    assert.equal(calls, 2)
    assert.ok(body.input.includes(JSON.stringify(source)))
    return eventResponse(JSON.stringify({ blocks: [first, second], complete: true }),
      { type: 'response.completed', response: { status: 'completed' } })
  })
  await assert.rejects(generateStageDraftWithContinuation(req, prompt, transport(contracts), { steps: store.runner() }), error => {
    assert.ok(error instanceof TextProviderError)
    assert.equal(error.upstreamCode, 'bad_response_body')
    return true
  })
  const saved = store.snapshot().steps['draft:stream:state']!.value as { artifacts: unknown[] }
  assert.deepEqual(saved.artifacts, [source])
  const draft = await generateStageDraftWithContinuation(req, prompt, transport(contracts), { steps: store.runner() })
  assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks'])
  assert.deepEqual(draft.artifacts[0], source)
  assert.equal(draft.artifacts[1]!.content, first.content + '\n\n' + second.content)
})

test('a successful Responses body with malformed block metadata repairs through the real provider without resending the source', async t => {
  const store = workspace(), contracts: Array<string | undefined> = []
  const req = workflowRequest.parse({ stage: 'locations', artifact_types: ['location_layouts'] })
  const prefix = { id: 'layout:south', title: '空间与动线', content: '南门经天井通向正房，西厢可绕至后院。', scenes: [] }
  const malformed = { id: 'layout:north', title: prefix.title, content: '北门通向河岸；封门后必须从西侧绕行。', scenes: null }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls++
    if (calls === 1) return eventResponse('{"artifacts":[', { type: 'response.incomplete', response: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })
    if (calls === 2) return eventResponse(JSON.stringify({ blocks: [prefix, malformed], complete: true }),
      { type: 'response.completed', response: { status: 'completed', usage: { output_tokens: 1082 } } })
    assert.equal(calls, 3)
    assert.equal(contracts.at(-1), 'script_stage_block_repair')
    assert.ok(!body.input.includes(prompt)); assert.ok(body.input.includes(malformed.content))
    assert.deepEqual((store.snapshot().steps['draft:stream:state']!.value as { blocks: unknown[] }).blocks, [prefix])
    return eventResponse(JSON.stringify({ repairs: [{ candidate_id: 'block:1', id: malformed.id, title: malformed.title,
      add_empty_scenes: true, removed_fields: [] }] }), { type: 'response.completed', response: { status: 'completed' } })
  })
  const draft = await generateStageDraftWithContinuation(req, prompt, transport(contracts), { steps: store.runner() })
  assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks', 'script_stage_block_repair'])
  assert.equal(draft.artifacts[0]!.content, prefix.content + '\n\n' + malformed.content)
  assert.equal(calls, 3); assert.deepEqual(store.snapshot().steps, {})
})

test('the Responses provider repairs a mixed props page but needs a separate valid completion after empty-structure confirmation', async t => {
  const store = workspace(), contracts: Array<string | undefined> = []
  const req = workflowRequest.parse({ stage: 'props', artifact_types: ['prop_functions'] })
  const retained = Array.from({ length: 12 }, (_, index) => ({ id: `prop:${index}`, title: '剧情功能与使用规则', content: `道具${index}的既定使用限制与剧情功能。`, scenes: [] }))
  const pending = { id: 'prop:remaining', title: retained[0]!.title, content: '钥匙开启库房后交还原主，没有新增功能。' }
  store.runner().retain('draft:stream:state', '保留道具单元', { strategy: 'stage-semantic-stream-v1', request: req, prompt }, {
    version: 1, round: 10, initialEnded: true, artifacts: [], scenes: [], target: 'prop_functions', mode: 'document', blocks: retained, noProgress: 0,
  }, value => value)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); calls++
    if (calls === 1) return eventResponse(JSON.stringify({ blocks: [pending, { scenes: [] }], complete: true }),
      { type: 'response.completed', response: { status: 'completed' } })
    if (calls === 2) {
      assert.equal(contracts.at(-1), 'script_stage_block_repair'); assert.ok(!body.input.includes(prompt))
      return eventResponse(JSON.stringify({ repairs: [{ candidate_id: 'block:0', id: pending.id, title: pending.title,
        add_empty_scenes: true, removed_fields: [] }], empty_units: [{ candidate_id: 'block:1', disposition: 'discard_empty_structure' }] }),
      { type: 'response.completed', response: { status: 'completed' } })
    }
    assert.equal(calls, 3); assert.equal(contracts.at(-1), 'script_stage_blocks')
    assert.ok(body.input.includes(prompt)); assert.ok(body.input.includes(pending.content)); assert.match(body.input, /空结构纠正/)
    const state = store.snapshot().steps['draft:stream:state']!.value as { blocks: unknown[]; blockStructureCorrections: unknown[] }
    assert.equal(state.blocks.length, 13); assert.equal(state.blockStructureCorrections.length, 1)
    return eventResponse(JSON.stringify({ blocks: [], complete: true }), { type: 'response.completed', response: { status: 'completed' } })
  })
  const draft = await generateStageDraftWithContinuation(req, prompt, transport(contracts), { steps: store.runner() })
  assert.deepEqual(contracts, ['script_stage_blocks', 'script_stage_block_repair', 'script_stage_blocks'])
  assert.equal(draft.artifacts[0]!.content, [...retained, pending].map(item => item.content).join('\n\n'))
  assert.equal(calls, 3); assert.deepEqual(store.snapshot().steps, {})
})
