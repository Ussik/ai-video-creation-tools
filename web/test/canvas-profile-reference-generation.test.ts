import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { extractPromptReferenceIds, resolvePromptReferences } from '@video-studio/shared/visuals/prompt-references'
import type { Model, ProjectDetail, VisualProfile } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { enqueueCanvasVisualBoard, prepareCanvasVisualBoard } from '../src/features/canvas/canvas-reference-generation'
import { stripVisualProfileBaseReference, withVisualProfileBaseReference } from '../src/features/canvas/canvas-profile-reference-prompt'
import { imagePreferencePrompt } from '../src/features/canvas/canvas-model-parameters'
import { withVisualProfilePrompt } from '@video-studio/shared/visuals/visual-profile-prompt'
import { tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { parsePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

function fixture(baseAssetId: string | null = 'base-board') {
  const base = { id: 'base', project_id: 'project', kind: 'character', name: '姜望', variant: '落泥前', revision: 1,
    base_profile_id: null, state_delta: '', board_asset_id: baseAssetId, asset_task_id: null,
    definition: '固定脸型、低髻与衣服', view_requirements: '正侧背', board_prompt: '人物设定图' } as VisualProfile
  const profile: VisualProfile = { ...base, id: 'derived', variant: '右手背溅泥', base_profile_id: base.id, state_delta: '仅右手背少量湿泥', board_asset_id: null }
  const node = { id: 'state-node', type: 'generation', title: profile.variant, x: 0, y: 0, width: 400, height: 400,
    text: '补充要求', prompt: '', asset_id: null, shot_id: null, model_id: 'image-model', job_id: null,
    settings: { modality: 'image', visual_profile_id: profile.id, visual_profile_revision: profile.revision } } as CanvasNode
  const graph = { nodes: [node, { ...node, id: 'light-node', type: 'image', asset_id: 'lighting', settings: {} },
    { ...node, id: 'text-node', type: 'text', text: '文字节点要求', settings: {} }],
    edges: [{ id: 'light-edge', source: 'light-node', target: node.id }, { id: 'text-edge', source: 'text-node', target: node.id }],
    revision: 'r1', viewport: { x: 0, y: 0, zoom: 1 } } as CanvasGraph
  const detail = { id: 'project', assets: [...(baseAssetId ? [{ id: baseAssetId, kind: 'image' }] : []), { id: 'lighting', kind: 'image' }],
    jobs: [], asset_tasks: [], visual_profiles: [base, profile], shot_visual_bindings: [] } as unknown as ProjectDetail
  const model = { id: 'image-model', modality: 'image', settings: { request_template: { prompt: '{{prompt}}', images: '{{images}}', ratio: '{{ratio}}' } } } as Model
  return { base, profile, node, graph, detail, model }
}

function mockBoardRequests(t: TestContext, baseAssetId?: string | null) {
  const requests: Array<{ path: string; body: Record<string, any> }> = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = String(url), body = JSON.parse(String(options?.body))
    requests.push({ path, body })
    if (path.endsWith('/board-preview')) {
      const resolved = resolvePromptReferences({ prompt: body.prompt_override || `默认设定图\n${body.prompt_append}`,
        referenceAssetIds: [...(baseAssetId ? [baseAssetId] : []), ...body.reference_asset_ids],
        requiredAssetIds: baseAssetId ? [baseAssetId] : [], overrides: body.prompt_reference_overrides })
      return Response.json({ prompt: resolved.prompt, mode: resolved.referenceAssetIds.length ? 'reference' : 'text',
        reference_asset_ids: resolved.referenceAssetIds, reference_names: resolved.referenceAssetIds,
        reference_signature: 'checked-signature', base_profile_id: baseAssetId ? 'base' : null,
        reference_sources: resolved.referenceAssetIds.map(asset_id => ({ asset_id, role: asset_id === baseAssetId ? 'base' : 'manual' })) })
    }
    assert.equal(path.endsWith('/generate'), true)
    return Response.json({ job: { id: 'mock-job' }, jobs: [{ id: 'mock-job' }], task: { id: 'mock-task' } })
  })
  return requests
}

test('default derived board preview and enqueue carry a visible base token while the backend owns required reference injection', async t => {
  const f = fixture(), requests = mockBoardRequests(t, 'base-board')
  const prepared = await prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model)
  await enqueueCanvasVisualBoard(prepared.board, prepared.request, 1)
  assert.equal(requests.length, 2)
  for (const { body } of requests) {
    assert.equal(body.prompt_override, undefined)
    assert.equal(stripVisualProfileBaseReference(body.prompt_append), '文字节点要求\n\n补充要求')
    assert.deepEqual(extractPromptReferenceIds(body.prompt_append), ['base-board'])
    assert.deepEqual(body.reference_asset_ids, ['lighting'])
    assert.deepEqual(body.reference_profile_ids, [])
    assert.equal(body.expected_revision, f.profile.revision)
  }
  assert.deepEqual(prepared.request.reference_asset_ids, ['base-board', 'lighting'])
  for (const key of ['ratio', 'resolution', 'clarity', 'quality', 'background'] as const) {
    assert.equal(requests[0].body[key], prepared.request[key], `preview validates the current ${key}`)
  }
  assert.equal(prepared.request.mode, 'reference')
  assert.equal(prepared.board.preview.reference_sources[0].role, 'base')
  assert.equal(prepared.request.prompt.includes('[[ref:'), false)
  assert.equal(requests[1].body.reference_signature, 'checked-signature')
  assert.equal(requests[1].body.prompt, prepared.request.prompt)
})

test('custom derived prompts keep user prose and other manual mentions through preview and enqueue', async t => {
  const f = fixture(), requests = mockBoardRequests(t, 'base-board')
  const body = '  保持布料纹理。\n光线参考[[ref:lighting]]，只让右手背溅泥。\n'
  f.node.settings.profile_prompt_override = body
  const prepared = await prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model)
  await enqueueCanvasVisualBoard(prepared.board, prepared.request, 2)
  for (const { body: input } of requests) {
    assert.equal(stripVisualProfileBaseReference(input.prompt_override), body)
    assert.deepEqual(extractPromptReferenceIds(input.prompt_override), ['lighting', 'base-board'])
    assert.deepEqual(extractPromptReferenceIds(input.prompt_append), [])
    assert.deepEqual(input.reference_asset_ids, ['lighting'])
  }
  assert.deepEqual(prepared.request.reference_asset_ids, ['base-board', 'lighting'])
  assert.equal(requests[1].body.candidate_count, 2)
})

test('a newly confirmed base replaces stale automatic context before disconnected-reference validation', async t => {
  const f = fixture('new-base'), requests = mockBoardRequests(t, 'new-base')
  const body = '保留[[ref:lighting]]光线。'
  f.node.settings.profile_prompt_override = withVisualProfileBaseReference(body, 'old-base')
  const prepared = await prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model)
  await enqueueCanvasVisualBoard(prepared.board, prepared.request, 1)
  for (const { body: input } of requests) {
    assert.equal(stripVisualProfileBaseReference(input.prompt_override), body)
    assert.deepEqual(extractPromptReferenceIds(input.prompt_override), ['lighting', 'new-base'])
    assert.equal(input.prompt_override.includes('old-base'), false)
  }
  assert.deepEqual(prepared.request.reference_asset_ids, ['new-base', 'lighting'])
})

test('independent boards clear stale managed context without inventing a base or discarding manual references', async t => {
  const f = fixture(), requests = mockBoardRequests(t)
  f.profile.base_profile_id = null
  f.detail.visual_profiles = [f.profile]
  const body = '人物设定保持[[ref:lighting]]的光线。'
  f.node.settings.profile_prompt_override = withVisualProfileBaseReference(body, 'old-base')
  const prepared = await prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model)
  await enqueueCanvasVisualBoard(prepared.board, prepared.request, 1)
  for (const { body: input } of requests) {
    assert.equal(input.prompt_override, body)
    assert.equal(input.prompt_append, '文字节点要求\n\n补充要求')
    assert.deepEqual(extractPromptReferenceIds(input.prompt_override), ['lighting'])
  }
  assert.deepEqual(prepared.request.reference_asset_ids, ['lighting'])
})

test('waiting for a base and disconnected manual references still prevent every preview or generation request', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; assert.fail('blocked boards must not send a request') })
  const f = fixture(null)
  await assert.rejects(prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model), /先生成并确认.*基础/)
  const ready = fixture()
  ready.node.settings.profile_prompt_override = '保持[[ref:disconnected]]光线。'
  await assert.rejects(prepareCanvasVisualBoard(ready.node, ready.profile, ready.graph, ready.detail, ready.model), /参考已断开/)
  assert.equal(requests, 0)
})

test('an empty custom body cannot become a nonempty identity block or silently restore the default prompt', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; assert.fail('cleared custom prompts must not send a request') })
  for (const prompt of ['', '  \n\t', withVisualProfileBaseReference('', 'base-board')]) {
    const f = fixture()
    f.node.settings.profile_prompt_override = prompt
    await assert.rejects(prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model), /请输入信息图提示词/)
  }
  assert.equal(requests, 0)
})

test('complete board documents keep edited reference sections while batch preparation refreshes untouched parameter sections', async t => {
  const f = fixture(), requests = mockBoardRequests(t, 'base-board')
  const template = tokenizePromptReferenceNumbers(imagePreferencePrompt(f.model, `保留手部湿泥细节。\n\n${withVisualProfilePrompt('', f.profile, [
    { asset_id: 'base-board', name: f.base.name, variant: f.base.variant, definition: f.base.definition, role: 'base' },
    { asset_id: 'lighting', name: 'light-node', role: 'manual' },
  ])}`, {
    ratio: '9:16', resolution: null, clarity: null, quality: null, background: null,
  }, 'reference'), ['base-board', 'lighting'])
  f.node.settings = { ...f.node.settings, prompt_document: true, prompt_template: template,
    profile_prompt_override: template.replace('【生成参考图结束】', '用户补充暗银色衣扣，侧光参考[[ref:lighting]]。\n【生成参考图结束】'),
    prompt_body: '过期的单独正文不应使用', ratio: '16:9' }
  const prepared = await prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model)
  await enqueueCanvasVisualBoard(prepared.board, prepared.request, 1)
  for (const { body: input } of requests) {
    assert.equal(input.prompt_document, true)
    assert.match(input.prompt_override, /暗银色衣扣/)
    assert.match(input.prompt_override, /画面比例：16:9/)
    assert.doesNotMatch(input.prompt_override, /画面比例：9:16|过期的单独正文/)
  }
  assert.match(prepared.request.prompt, /侧光参考参考图 2/)
  assert.deepEqual(prepared.request.reference_asset_ids, ['base-board', 'lighting'])
  assert.equal(prepared.request.prompt, requests[1].body.prompt)
})

test('batch boards block unresolved source changes and explicit parameter conflicts before any API request', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; assert.fail('conflicted boards must not request a preview') })
  const source = '【设定图固定要求】\n服装蓝色\n【设定图固定要求结束】'
  const f = fixture()
  f.node.settings.prompt_document = true
  f.node.settings.prompt_sections = parsePromptSectionDocument(`保留手部细节。\n\n${source.replace('蓝色', '红色')}`, { sourceText: source })
  await assert.rejects(prepareCanvasVisualBoard(f.node, f.profile, f.graph, f.detail, f.model), /设定来源已更新/)
  const parameter = fixture()
  parameter.node.settings = { ...parameter.node.settings, prompt_document: true, ratio: '9:16',
    profile_prompt_override: '保留手部湿泥。\n画面比例：4:3' }
  await assert.rejects(prepareCanvasVisualBoard(parameter.node, parameter.profile, parameter.graph, parameter.detail, parameter.model), /画面比例.*4:3.*9:16/)
  assert.equal(requests, 0)
})
