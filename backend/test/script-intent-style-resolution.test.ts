import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import type { Project } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'

const directory = await mkdtemp(join(tmpdir(), 'intent-style-resolution-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all } = await import('../src/infrastructure/database/db.js')
const { projectVisualStyle } = await import('../src/modules/visuals/project-visual-style.js')
const { creationState } = await import('../src/modules/script/script-document-tools.js')
const { pendingScriptDraft, claimScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture() {
  const project = await call<Project>('POST', '/api/projects', { name: '画风同步与候选缺口' })
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '缺口回归提供商', base_url: 'https://style-resolution.invalid/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '缺口回归模型', remote_id: 'style-resolution', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  return { project, model }
}
const creatorText = '采用日漫二维画风，开始生成全剧大纲。'
const candidateText = '幕后真相以后再定。'
function modelReply(content: unknown) {
  return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })
}
function intent() {
  return { action: 'draft', operation: 'create', authorization: 'explicit', workflow: { stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: ['outline'] }, creative_brief: creatorText,
    settings_patch: { visual_style: '日漫二维画风' }, visual_style_source: { message_index: 0, quote: '采用日漫二维画风' } }
}
function draft() {
  return { artifacts: [{ artifact_type: 'outline', title: scriptArtifactLabels.outline, content: candidateText }], scenes: [] }
}
function finding() {
  return { checked_artifacts: ['outline'], findings: [{ source_key: 'outline', kind: 'missing_core_setting', quote: candidateText,
    explanation: '作者视角尚无幕后真相。', suggestion: '确定幕后真相及回收。' }] }
}
async function resolutionVersion(projectId: string) {
  const current = await call<Project & { script: ScriptSnapshot }>('GET', `/api/projects/${projectId}`)
  const source = scriptSourceDocument(projectId, false)
  return createHash('sha256').update(JSON.stringify([current.name, current.brief,
    creationState(projectId, current.script).version, source ? scriptDocumentVersion(source) : null])).digest('hex')
}
async function uploadSource(projectId: string, content: string) {
  const boundary = 'style-resolution-source'
  const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="并发原稿.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(response.statusCode, 200, response.body)
}

test('a mixed style and outline request retains real draft findings against the post-save source version', async t => {
  for (const use_tools of [true, false]) {
    const { project, model } = await fixture()
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests++
      const prompt = JSON.parse(String(init.body)).messages[0].content as string
      if (prompt.includes('本次独立调用只理解创作者意图')) return modelReply(intent())
      assert.equal(projectVisualStyle(project.id).label, '日漫二维画风')
      if (prompt.includes('待核对草稿原文（资料）：')) return modelReply(finding())
      return modelReply(draft())
    })
    const result = await call('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools,
      messages: [{ role: 'user', text: creatorText }] })
    assert.equal(requests, 3)
    assert.equal(result.draft_resolution.findings[0].kind, 'missing_core_setting')
    assert.equal(result.draft_resolution.findings[0].quote, candidateText)
    const pending = pendingScriptDraft(project.id)!
    assert.ok(pending)
    assert.equal(pending.id, result.draft_resolution.id)
    assert.equal(pending.version, result.draft_resolution.version)
    assert.deepEqual(pending.draft.artifacts, draft().artifacts)
    const latestVersion = await resolutionVersion(project.id)
    assert.equal(pending.source_version, latestVersion, 'the candidate must bind to the legitimate style save rather than the old settings')
    const claimed = claimScriptDraft(project.id, { id: pending.id, version: pending.version, strategy: 'ai' }, latestVersion)
    claimed.release()
    assert.equal(projectVisualStyle(project.id).label, '日漫二维画风')
    assert.equal(all('SELECT * FROM script_artifacts WHERE project_id=?', project.id).length, 0)
    assert.equal(all('SELECT * FROM script_tool_drafts WHERE project_id=?', project.id).length, 0)
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
    t.mock.restoreAll()
  }
})

test('concurrent document or source changes during intent recognition cannot be absorbed into the style-save baseline', async t => {
  for (const change of ['document', 'source'] as const) for (const use_tools of [true, false]) {
    const { project, model } = await fixture()
    const before = projectVisualStyle(project.id)
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      assert.equal(requests, 1, 'reject the changed input before starting a stage generation or source read')
      if (change === 'document') await call('PUT', `/api/projects/${project.id}/script`, { outline: '另一位创作者已保存的新大纲。', characters: '并发更新的人物。', generation_options: {} })
      else await uploadSource(project.id, '另一位创作者刚上传的原稿。')
      return modelReply(intent())
    })
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools,
      messages: [{ role: 'user', text: creatorText }] } })
    assert.equal(response.statusCode, 409, response.body)
    assert.equal(requests, 1)
    assert.deepEqual(projectVisualStyle(project.id), before, 'an obsolete intent cannot persist any style over changed inputs')
    assert.equal(pendingScriptDraft(project.id), null)
    assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', project.id).length, 0)
    if (change === 'document') {
      const current = await call('GET', `/api/projects/${project.id}`)
      assert.equal(current.script.outline, '另一位创作者已保存的新大纲。')
      assert.equal(current.script.characters, '并发更新的人物。')
    } else assert.equal(scriptSourceDocument(project.id, false)!.content, '另一位创作者刚上传的原稿。')
    t.mock.restoreAll()
  }
})
