import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { workflowRequest } from '../src/modules/script/script-workflow.js'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-workflow-format-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, one, run } = await import('../src/infrastructure/database/db.js')
const { scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<any> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const documents = (stage: keyof typeof scriptStageArtifacts) => scriptStageArtifacts[stage].map(artifact_type => ({
  artifact_type, title: scriptArtifactLabels[artifact_type], content: `${scriptArtifactLabels[artifact_type]}完整原文，含 type/status 原样对白。`,
}))

test('actual workflow retries upgrade empty legacy requests and preserve nonempty legacy continuation', async t => {
  for (const useTools of [true, false]) for (const retained of [false, true]) await t.test(`${useTools ? 'tool button' : 'JSON workflow'} / ${retained ? 'keep accepted prose' : 'refresh empty failed attempt'}`, async t => {
    const provider = await call('POST', '/api/providers', { name: '格式回归', base_url: 'https://workflow-format.example.invalid/v1' })
    const model = await call('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'responses',
      settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } })
    const project = await call('POST', '/api/projects', { name: '道具格式恢复回归' })
    await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
      ...documents('outline'), ...documents('characters'), ...documents('locations'),
    ].map(artifact => ({ ...artifact, status: 'ready' })) })
    const before = await call('GET', `/api/projects/${project.id}`)
    const messages = [{ role: 'user', text: '生成完整全剧道具设计，保留原剧情，先提供草稿。' }]
    const workflow = workflowRequest.parse({ stage: 'props' })
    const payload = { model_id: model.id, mode: 'script', use_tools: useTools, workflow: { stage: 'props' }, messages }
    const url = `/api/projects/${project.id}/script/director/chat`
    let succeed = false, calls = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const review = draftCompletenessFixtureResponse(init)
      if (review) return review
      const body = JSON.parse(String(init?.body)), text = body.input as string
      if (text.includes('本次独立调用只理解创作者意图')) return Response.json({ output_text: JSON.stringify({
        action: 'draft', operation: 'create', authorization: 'explicit', workflow: { stage: 'props' }, creative_brief: '保留既有故事，仅生成道具草稿。',
      }) })
      calls++
      if (!succeed) return Response.json({ output_text: JSON.stringify({ artifacts: documents('props').map(({ artifact_type, ...artifact }) => ({ ...artifact, type: artifact_type, status: 'ready' })), scenes: [] }) })
      if (retained) {
        assert.equal(body.text.format.name, 'script_stage_blocks')
        assert.match(text, /旧版已接收外观正文/)
        return Response.json({ output_text: JSON.stringify({ blocks: [{ id: 'visual:new', title: '不同条目名', content: '新道具完整外观正文。', scenes: [] }], complete: true }) })
      }
      assert.equal(body.text.format.name, 'workflow_draft')
      const context = JSON.parse(text.split('项目与剧本上下文：\n')[1]!.split('\n')[0]!)
      assert.equal(context.script.artifacts.length, 15)
      assert.deepEqual(Object.keys(context.script.artifacts[0]), ['artifact_type', 'title', 'content'])
      assert.equal(context.script.saved_document_metadata[0].status, 'ready')
      assert.match(context.script.artifacts[0].content, /type\/status 原样对白/)
      assert.deepEqual(body.text.format.schema.properties.artifacts.items.properties.artifact_type.enum, scriptStageArtifacts.props)
      return Response.json({ output_text: JSON.stringify({ artifacts: documents('props'), scenes: [] }) })
    })
    const failed = await app.inject({ method: 'POST', url, payload })
    assert.equal(failed.statusCode, 422, failed.body)
    assert.equal(calls, 2)
    const row = one<{ cache_key: string; payload: string }>('SELECT cache_key,payload FROM script_generation_checkpoints WHERE project_id=?', project.id)!
    const checkpoint = JSON.parse(row.payload), currentPrompt = checkpoint.prompt as string
    const currentContextJson = currentPrompt.split('项目与剧本上下文：\n')[1]!.split('\n')[0]!
    const legacyContext = JSON.parse(currentContextJson)
    legacyContext.script.artifacts = legacyContext.script.artifacts.map((artifact: any, index: number) => ({
      type: artifact.artifact_type, episode_number: legacyContext.script.saved_document_metadata[index].episode_number,
      title: artifact.title, content: artifact.content, status: legacyContext.script.saved_document_metadata[index].status,
    }))
    delete legacyContext.script.saved_document_metadata
    const legacyPrompt = currentPrompt.replace(currentContextJson, JSON.stringify(legacyContext))
    const storedModel = one<any>('SELECT * FROM models WHERE id=?', model.id)!
    const storedProvider = one<any>('SELECT * FROM providers WHERE id=?', provider.id)!
    const identity = { strategy: 'whole-source-v1', prompt: currentPrompt, messages, workflow, source: scriptSourceDocument(project.id),
      model: { id: storedModel.id, remote_id: storedModel.remote_id, protocol: storedModel.protocol, settings: storedModel.settings },
      provider: { id: storedProvider.id, adapter: storedProvider.adapter, base_url: storedProvider.base_url, auth_header: storedProvider.auth_header, auth_prefix: storedProvider.auth_prefix } }
    assert.equal(hash({ version: 1, identity }), row.cache_key, 'fixture reproduces the exact live checkpoint identity')
    checkpoint.prompt = legacyPrompt
    const completed = documents('props').filter(artifact => artifact.artifact_type !== 'prop_visuals')
    checkpoint.steps['draft:stream:state'] = { input_hash: hash({ strategy: 'stage-semantic-stream-v1', request: workflow, prompt: legacyPrompt }), duration_ms: 0,
      value: { version: 1, round: 2, initialEnded: retained, artifacts: retained ? completed : [], scenes: [], target: retained ? 'prop_visuals' : null,
        mode: 'document', blocks: retained ? [{ id: 'visual:old', title: '外观与辨识', content: '旧版已接收外观正文。', scenes: [] }] : [], noProgress: 0 } }
    run('UPDATE script_generation_checkpoints SET cache_key=?,payload=? WHERE project_id=?', hash({ version: 1, identity: { ...identity, prompt: legacyPrompt } }), JSON.stringify(checkpoint), project.id)
    succeed = true; calls = 0
    const generated = await call('POST', url, payload)
    assert.equal(calls, 1, 'retry does not replay a complete stage against preserved prose')
    assert.ok(useTools ? generated.tool_draft : generated.draft)
    if (retained) {
      const draftDocuments = (useTools ? generated.tool_draft.documents : generated.draft.artifacts) as Array<{ artifact_type: string; content: string }>
      assert.equal(draftDocuments.find(artifact => artifact.artifact_type === 'prop_visuals')!.content, '旧版已接收外观正文。\n\n新道具完整外观正文。')
      for (const artifact of completed) assert.equal(draftDocuments.find(item => item.artifact_type === artifact.artifact_type)!.content, artifact.content)
    }
    const afterGeneration = await call('GET', `/api/projects/${project.id}`)
    assert.deepEqual(afterGeneration.script, before.script, 'formal documents and manuscript are untouched until confirmation')
  })
})
