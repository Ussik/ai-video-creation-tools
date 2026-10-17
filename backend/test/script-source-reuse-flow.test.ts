import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceDocument, ScriptSourceUpdate } from '@video-studio/shared/script/script-source-document'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-reuse-flow-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, newId, required } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, sourceAnalysisConfiguration, scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { effectiveScriptSource, originalScriptSource, scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
const { documentTools, getToolDraft, attachDraftSourceUpdate } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext, workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
assert.ok(db.name.startsWith(testData), 'HTTP save regression must use an isolated database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function post(url: string, payload: object) {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

for (const path of ['tool-draft', 'workflow-draft'] as const) {
  test(`${path} HTTP confirmation reuses the reviewed revision after generation cleanup and memory eviction with the production configuration`, async t => {
    const project = await post('/api/projects', { name: `保存分析复用 ${path}` })
    const provider = await post('/api/providers', { name: 'isolated-reuse-fixture', base_url: 'https://source-reuse.invalid/v1' })
    const model = await post('/api/models', { provider_id: provider.id, name: 'fixture', remote_id: 'configured-source-model', modality: 'text', protocol: 'chat_completions', settings: {
      request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
      structured_output_mode: 'json_schema', text_path: 'choices.0.message.content',
    } })
    let providerCalls = 0
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      assert.match(String(url), /^https:\/\/source-reuse\.invalid\//)
      providerCalls++
      const body = JSON.parse(String(init?.body))
      const response = sourceAnalysisFixture(body.messages[0].content)
      assert.ok(response, 'the source analyzer may only request its three analysis contracts')
      return Response.json({ choices: [{ message: { content: response }, finish_reason: 'stop' }] })
    })
    const content = '全剧1集。\n林舟得到钥匙，钥匙的来历尚未展开。\n结局林舟返乡，将钥匙还给父亲。'
    const boundary = 'reuse-source-fixture'
    const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source?model_id=${model.id}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="story.md"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    let source: ScriptSourceDocument = uploaded.json()
    for (let attempt = 0; attempt < 100 && source.analysis?.status !== 'ready'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      source = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/source` })).json()
    }
    assert.equal(source.analysis?.status, 'ready', source.analysis?.error || '')
    assert.equal(providerCalls, 3)
    const beforeSaveCalls = providerCalls
    const replacement = { find: '钥匙的来历尚未展开。', replace: '钥匙是父亲临行前所赠，用于打开故乡旧屋。', reason: '落实本轮已确认的钥匙来源' }
    const update: ScriptSourceUpdate = { id: newId(), base_version: scriptDocumentVersion(source), original_content: content,
      content: content.replace(replacement.find, replacement.replace), replacements: [replacement] }
    const storedModel = required<import('../src/infrastructure/database/db.js').Model>('models', model.id)
    const storedProvider = required<import('../src/infrastructure/database/db.js').Provider>('providers', provider.id)
    const configuration = sourceAnalysisConfiguration(storedModel, storedProvider)
    let privateCalls = 0
    const privateAnalysis = await analyzeSourceSnapshot({ ...source, content: update.content }, model.id, async prompt => {
      privateCalls++
      return sourceAnalysisFixture(prompt)!
    }, new AbortController().signal, configuration)
    assert.equal(privateCalls, 3)
    assert.equal(privateAnalysis.quality?.status, 'passed')
    assert.equal(effectiveScriptSource(project.id)!.content, content, 'the proposed revision remains private before confirmation')
    clearGenerationCheckpoint(project.id)
    assert.ok(db.prepare("SELECT 1 FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal'").get(project.id), 'completed generation must retain the privately reviewed revision for its later save')

    // More than ten independent proposals evict the original in-memory entry.
    // Confirmation must therefore recover the durable result, as after restart.
    for (let index = 0; index < 11; index++) {
      const other = await post('/api/projects', { name: `缓存淘汰样本 ${index}` })
      await analyzeSourceSnapshot({ ...source, project_id: other.id, content: `独立样本${index}：林舟最后返乡。` }, model.id,
        async prompt => sourceAnalysisFixture(prompt)!, new AbortController().signal, configuration)
    }
    const stage = workflowGenerationDraftSchema.parse({ stage: 'outline', artifacts: scriptStageArtifacts.outline.map(artifact_type => ({
      artifact_type, title: scriptArtifactLabels[artifact_type], content: artifact_type === 'episode_outline' ? '第1集：林舟携钥匙返乡，最终归还父亲。' : update.content,
    })), scenes: [] })
    if (path === 'tool-draft') {
      const snapshot = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script
      const tools = documentTools({ project, script: () => snapshot, workflow: 'outline',
        stage: directorStageContext(snapshot, { explicit: { stage: 'outline', episode_number: 0 } }),
        messages: [{ role: 'user', text: '生成大纲并落实已确认设定，供我预览保存' }], checkApproval: async () => false, onEvent: () => {} })
      await tools.execute('create_document_draft', stage)
      const draft = attachDraftSourceUpdate(project.id, getToolDraft(project.id)!.id, update)
      await post(`/api/projects/${project.id}/script/director/tool-drafts/${draft.id}/commit`, { version: draft.version, approved: true })
    } else {
      const saved = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/director/draft`,
        payload: { ...stage, source_version: update.base_version, source_update: update } })
      assert.equal(saved.statusCode, 200, saved.body)
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    const savedSource: ScriptSourceDocument = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/source` })).json()
    assert.equal(savedSource.revision, 1)
    assert.equal(savedSource.content, update.content)
    assert.equal(savedSource.analysis?.status, 'ready', 'saving a reviewed revision must not enqueue another full-source analysis')
    assert.equal(savedSource.analysis.started_at, undefined, 'reused results must not display a new execution timer')
    assert.equal(savedSource.analysis.source_version, scriptSourceVersion(savedSource))
    assert.deepEqual(savedSource.analysis.story, privateAnalysis.story)
    assert.deepEqual(savedSource.analysis.quality, privateAnalysis.quality)
    assert.equal(providerCalls, beforeSaveCalls, 'confirmation sends zero additional model requests')
    assert.equal(originalScriptSource(project.id)!.content, content)
    const detail = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json()
    assert.equal(detail.script.artifacts.length, 9)
    assert.equal(getToolDraft(project.id), null)
  })
}
