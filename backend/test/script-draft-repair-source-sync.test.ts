import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const directory = await mkdtemp(join(tmpdir(), 'repair-source-sync-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, one, run, now } = await import('../src/infrastructure/database/db.js')
const { retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { creationState } = await import('../src/modules/script/script-document-tools.js')
const { workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
const { scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
assert.equal(db.name, join(directory, 'studio.db'), 'source sync integration must use a temporary isolated database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}

async function fixture(t: TestContext, updateSource: boolean) {
  const project = await api('POST', '/api/projects', { name: '候选修补来源同步范围' })
  const provider = await api('POST', '/api/providers', { name: '离线工具提供商', base_url: 'https://source-sync-fixture.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '离线文本模型', remote_id: 'configured', modality: 'text', protocol: 'chat_completions',
    settings: { stream: false, request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const original = '全剧十七集。林晚使用铜钥匙，每次失去三天记忆。结局林晚归还钥匙回家。'
  const revised = original.replace('每次失去三天记忆', '每次失去一天记忆')
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', project.id, 'original.md', original, now())
  const state = await api('GET', `/api/projects/${project.id}`), source = scriptSourceDocument(project.id)!
  const quote = '钥匙代价：待定。', fixed = '钥匙代价：每次失去一天记忆。'
  const draft = workflowGenerationDraftSchema.parse({ stage: 'outline', episode_number: 0, scenes: [],
    artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: original + quote })) })
  const originalRequest = { model_id: model.id, mode: 'script', use_tools: false,
    messages: [{ role: 'user', text: '生成全剧大纲，保留原稿。' }], workflow: { stage: 'outline' } }
  const pending = retainScriptDraft(project.id, { draft,
    findings: [{ source_key: 'outline', kind: 'unresolved_setting', quote, explanation: '候选代价没有展开', suggestion: '落实已经授权的具体决定' }],
    request: originalRequest, source_version: createHash('sha256').update(JSON.stringify([project.name, project.brief,
      creationState(project.id, state.script).version, scriptDocumentVersion(source)])).digest('hex') })
  let repairs = 0
  const reviews: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
    const analysis = sourceAnalysisFixture(prompt)
    let output: unknown
    if (analysis) output = analysis
    else if (prompt.includes('待核对草稿原文（资料）：')) {
      reviews.push(prompt); output = { checked_artifacts: scriptStageArtifacts.outline, findings: [] }
    } else {
      assert.ok(body.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'submit_repair_patch'), 'repairs must exercise the native candidate tool path')
      repairs++
      output = { decisions: ['能力代价采用每次失去一天记忆。'], summary: '落实记忆代价',
        source_edits: updateSource ? [{ find: '每次失去三天记忆', replace: '每次失去一天记忆', reason: '创作者明确调整代价，同步直接冲突原文' }] : [],
        edits: [{ source_key: 'outline', find: quote, replace: fixed, reason: '落实候选决定' }] }
    }
    return Response.json({ choices: [{ message: { content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
  })
  const result = await api('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: false,
    messages: [...originalRequest.messages, { role: 'user', text: '本项由我决定为失去一天记忆，必要时同步直接冲突的文稿。' }],
    draft_resolution: { id: pending.id, version: pending.version, strategy: 'manual', answers: ['每次失去一天记忆，必要时同步直接冲突原文。'] } })
  return { project, result, repairs, reviews, original, revised }
}

test('candidate-only repair keeps full independent review without requiring source synchronization', async t => {
  const f = await fixture(t, false)
  assert.equal(f.repairs, 1); assert.equal(f.reviews.length, 1)
  assert.ok(!f.reviews[0]!.includes('本轮同时预览文稿修订：'))
  assert.ok(f.reviews[0]!.includes(f.original), 'the complete current source remains part of the independent review')
  assert.equal(f.result.source_update, undefined)
  assert.equal(f.result.draft_resolution, null)
  assert.equal(scriptSourceDocument(f.project.id)!.content, f.original)
  assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM script_artifacts WHERE project_id=?', f.project.id)!.n, 0)
})

test('an actual source patch enables synchronization review of the full proposed manuscript while leaving saved text intact', async t => {
  const f = await fixture(t, true)
  assert.equal(f.repairs, 1); assert.equal(f.reviews.length, 1)
  assert.ok(f.reviews[0]!.includes('本轮同时预览文稿修订：'))
  assert.ok(f.reviews[0]!.includes(f.revised))
  assert.equal(f.result.source_update.content, f.revised)
  assert.equal(f.result.source_update.original_content, f.original)
  assert.equal(scriptSourceDocument(f.project.id)!.content, f.original)
  assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM script_source_revisions WHERE project_id=?', f.project.id)!.n, 0)
  assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM script_artifacts WHERE project_id=?', f.project.id)!.n, 0)
})
