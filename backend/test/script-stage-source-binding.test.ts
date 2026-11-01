import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-stage-source-binding-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { scriptDocumentVersion, effectiveScriptSource } = await import('../src/modules/script/script-source-versions.js')
const { createScriptSourceAnalyzer } = await import('../src/modules/script/script-source-analysis.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const artifacts = scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '主角归乡，保留原结局。' }))
async function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
}
async function upload(id: string) {
  const boundary = 'source-binding'
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="story.txt"\r\nContent-Type: text/plain\r\n\r\n主角归乡。结局与家人团聚。\r\n--${boundary}--\r\n`) })
  assert.equal(response.statusCode, 200, response.body)
}
async function fixture(withSource: boolean) {
  const project = (await request('POST', '/api/projects', { name: '阶段原稿版本保护' })).json()
  const provider = (await request('POST', '/api/providers', { name: '测试', base_url: 'https://source-binding.invalid/v1' })).json()
  const model = (await request('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })).json()
  if (withSource) {
    await upload(project.id)
    const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => sourceAnalysisFixture(prompt)!)
    try { await analyzer.ensure(project.id, model.id) } finally { await analyzer.close() }
  }
  return { project, model }
}
async function generate(projectId: string, modelId: string, useTools: boolean) {
  return request('POST', `/api/projects/${projectId}/script/director/chat`, { model_id: modelId, mode: 'script', use_tools: useTools,
    workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '生成全剧大纲，供我预览。' }] })
}
function mockWriter(t: any, beforeReturn?: () => Promise<void>) {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const review = draftCompletenessFixtureResponse(init); if (review) return review
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content
    const wireType = body.response_format?.json_schema?.schema?.properties?.artifacts?.items?.properties?.artifact_type
    const requestedTypes: string[] = wireType?.enum || (wireType?.const ? [wireType.const] : [])
    const content = prompt.includes('本次独立调用只理解创作者意图')
      ? { action: 'draft', operation: 'create', authorization: 'explicit', workflow: { stage: 'outline' }, creative_brief: '完整生成全剧大纲。' }
      : (await beforeReturn?.(), { artifacts: artifacts.filter(item => requestedTypes.includes(item.artifact_type)), scenes: [] })
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] })
  })
}
test('all generated stage drafts retain the source identity and reject stale saves without writes', async t => {
  for (const useTools of [false, true]) for (const mutation of ['same_upload', 'remove', 'add', 'unchanged'] as const) await t.test(`${useTools ? 'tool' : 'plain'} ${mutation}`, async t => {
    const { project, model } = await fixture(mutation !== 'add')
    const source = effectiveScriptSource(project.id), expected = source ? scriptDocumentVersion(source) : null
    mockWriter(t)
    const response = await generate(project.id, model.id, useTools)
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json(), draft = useTools ? result.tool_draft : result.draft
    assert.equal(draft.source_version, expected)
    if (mutation === 'same_upload' || mutation === 'add') await upload(project.id)
    if (mutation === 'remove') assert.equal((await request('DELETE', `/api/projects/${project.id}/script/source`)).statusCode, 200)
    const before = (await request('GET', `/api/projects/${project.id}`)).json().script
    const saved = useTools
      ? await request('POST', `/api/projects/${project.id}/script/director/tool-drafts/${draft.id}/commit`, { version: draft.version, approved: true })
      : await request('PUT', `/api/projects/${project.id}/script/director/draft`, draft)
    assert.equal(saved.statusCode, mutation === 'unchanged' ? 200 : 409, saved.body)
    if (mutation !== 'unchanged') assert.deepEqual((await request('GET', `/api/projects/${project.id}`)).json().script, before)
  })
})
test('source identity captured before writing rejects an identical replacement during generation', async t => {
  for (const useTools of [false, true]) await t.test(useTools ? 'tool' : 'plain', async t => {
    const { project, model } = await fixture(true)
    mockWriter(t, () => upload(project.id))
    const response = await generate(project.id, model.id, useTools)
    assert.equal(response.statusCode, 409, response.body)
    assert.equal((await request('GET', `/api/projects/${project.id}`)).json().script.artifacts?.length || 0, 0)
  })
})
test('plain historical drafts without source metadata cannot bypass the guard after removal', async () => {
  const { project } = await fixture(true)
  await request('DELETE', `/api/projects/${project.id}/script/source`)
  const response = await request('PUT', `/api/projects/${project.id}/script/director/draft`, { stage: 'outline', artifacts, scenes: [] })
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.json().detail, /历史草稿缺少原稿版本记录/)
  assert.equal((await request('GET', `/api/projects/${project.id}`)).json().script.artifacts?.length || 0, 0)
})
