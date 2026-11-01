import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { workflowGenerationDraftSchema } from '../src/modules/script/script-workflow.js'

const directory = await mkdtemp(join(tmpdir(), 'native-review-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'native review fixtures must never open the workspace database')
const { getToolDraft, projectDocuments } = await import('../src/modules/script/script-document-tools.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const result = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json() as T
}
const response = (content: unknown) => Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }] })

test('native supplementation tasks durably resume unfinished review dimensions without repeating completed generation', async t => {
  const project = await api('POST', '/api/projects', { name: '原生工具核对恢复' })
  const provider = await api('POST', '/api/providers', { name: '核对模型', base_url: 'https://fixture.invalid/v1', auth_header: 'X-Test-Key', auth_prefix: '' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '核对模型', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', structured_output_mode: 'prompt',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  await api('PUT', `/api/projects/${project.id}/script`, { outline: '历史大纲：全剧60集，林晚最终归还铜钥匙。', characters: '' })
  const before = await api('GET', `/api/projects/${project.id}`)
  const historical = projectDocuments(project.id, before.script).find(document => document.artifact_type === 'outline')!
  const sourceText = '开场：十七个位置已满，第一批十七张签已用尽。\n' + '完整有效稿中的因果。'.repeat(200) + '\n结局：林晚归还铜钥匙。'
  const boundary = 'native-review-source'
  const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original.txt"\r\nContent-Type: text/plain\r\n\r\n${sourceText}\r\n--${boundary}--\r\n`) })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const source = uploaded.json()
  const analysis = { pipeline_version: sourceAnalysisPipelineVersion, id: crypto.randomUUID(), source_version: scriptSourceVersion(source), model_id: model.id,
    status: 'ready', phase: 'ready', completed_chunks: 1, total_chunks: 1, error: null, updated_at: source.updated_at,
    sections: [{ offset: 0, length: source.content.length, title: '完整原文', episode_number: null, summary: source.content, characters: [], events: [] }],
    story: { summary: source.content, characters: [], timeline: [], threads: [], ending: { summary: '林晚归还铜钥匙。', section_ids: [0] }, uncertainties: [] } }
  db.prepare('INSERT OR REPLACE INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(project.id, analysis.id, analysis.source_version, 'ready', JSON.stringify(analysis), source.updated_at)
  const draft = workflowGenerationDraftSchema.parse({ stage: 'outline', operation: 'supplement', artifacts: scriptStageArtifacts.outline.map((artifact_type, index) => ({
    artifact_type, title: artifact_type === 'outline' ? historical.title : scriptArtifactLabels[artifact_type],
    content: artifact_type === 'outline' ? historical.content : `第${index}份完整候选文档开头。` + '全部人物动机与因果。'.repeat(100) + `第${index}份文档结尾。`,
  })), scenes: [] })
  const expected = scriptStageArtifacts.outline.filter(type => type !== 'outline')
  const audits: string[] = [], requestPrompts: string[] = []
  let failConsistency = true, generations = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
    if (prompt.includes('待核对草稿原文（资料）：')) {
      const scope = /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
      audits.push(scope); requestPrompts.push(prompt)
      const start = '既有事实与创作要求（资料）：', end = '\n待核对草稿原文（资料）：'
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf(start) + start.length, prompt.lastIndexOf(end)))
      const submitted = JSON.parse(prompt.slice(prompt.lastIndexOf(end) + end.length))
      assert.equal(context.uploaded_script.content, source.content)
      assert.deepEqual(context.uploaded_script.analysis.story, analysis.story)
      assert.equal(Object.hasOwn(context.uploaded_script.analysis, 'work'), false)
      assert.equal(Object.hasOwn(context.uploaded_script.analysis, 'sections'), false)
      assert.ok(context.saved_documents.some((document: { content: string }) => document.content === historical.content))
      assert.deepEqual(submitted.map((item: { artifact_type: string; content: string }) => ({ artifact_type: item.artifact_type, content: item.content })),
        draft.artifacts.filter(item => item.artifact_type !== 'outline').map(({ artifact_type, content }) => ({ artifact_type, content })))
      if (scope === 'whole') return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 66_323, completion_tokens: 65_535, completion_tokens_details: { reasoning_tokens: 65_535 } } })
      if (scope === 'consistency' && failConsistency) return Response.json({ error: { code: 'invalid_request', message: '独立一致性核对暂不可用' } }, { status: 400 })
      return response({ facts: [], checked_artifacts: expected, findings: [] })
    }
    const schema = JSON.parse(prompt.split('\n').find(line => line.startsWith('{') && line.includes('"properties"'))!)
    const type = schema.properties.artifacts.items.properties.artifact_type
    const selected = type.enum || [type.const]
    assert.ok(selected.every((item: string) => scriptStageArtifacts.outline.includes(item as typeof scriptStageArtifacts.outline[number])))
    generations++
    return response({ artifacts: draft.artifacts.filter(artifact => selected.includes(artifact.artifact_type)), scenes: [] })
  })
  const payload = { model_id: model.id, mode: 'script', use_tools: true, workflow: { stage: 'outline', operation: 'supplement' },
    messages: [{ role: 'user', text: '补齐完整全剧大纲，原稿全部事实和历史大纲保留。' }] }
  const url = `/api/projects/${project.id}/script/director/chat`
  const first = await app.inject({ method: 'POST', url, payload })
  assert.equal(first.statusCode, 502, first.body)
  assert.match(first.body, /阶段设定核对未完成/)
  assert.deepEqual(audits, ['whole', 'settings', 'consistency'], first.body)
  assert.equal(generations, 4, 'the historical outline is reused and four missing design work items are generated')
  assert.equal(getToolDraft(project.id), null)
  const row = () => db.prepare('SELECT cache_key, payload FROM script_generation_checkpoints WHERE project_id=?').get(project.id) as { cache_key: string; payload: string } | undefined
  assert.ok(row(), 'completed generation remains available while its independent review is unfinished')
  const reviewRow = () => db.prepare("SELECT cache_key, payload FROM script_step_checkpoints WHERE project_id=? AND namespace='draft-review'").get(project.id) as { cache_key: string; payload: string } | undefined
  const saved = JSON.parse(reviewRow()!.payload)
  assert.equal(saved.steps['review:recovery'].value, 'dimensions')
  assert.ok(saved.steps['review:dimension:settings'])
  assert.equal(saved.steps['review:dimension:consistency'], undefined)
  assert.equal(saved.steps['review:whole'], undefined)
  assert.deepEqual((await api('GET', `/api/projects/${project.id}`)).script, before.script)
  failConsistency = false
  const resumed = await api('POST', url, payload)
  assert.deepEqual(audits, ['whole', 'settings', 'consistency', 'consistency', 'requirements'])
  assert.equal(generations, 4, 'completed work items and reviewed dimensions are reused without generating again')
  assert.equal(requestPrompts[2], requestPrompts[3], 'the unfinished dimension resumes with the exact complete input')
  assert.ok(resumed.tool_draft)
  assert.ok(resumed.activity.some((entry: { step_id?: string; reused?: boolean }) => entry.step_id === 'review:dimension:settings' && entry.reused))
  assert.equal(row(), undefined, 'confirmed preview clears finished generation recovery state')
  assert.equal(reviewRow(), undefined, 'confirmed preview clears finished review recovery state')
  assert.deepEqual((await api('GET', `/api/projects/${project.id}`)).script, before.script, 'a passed independent review still only creates a preview')
  assert.equal((await api('GET', `/api/projects/${project.id}/script/source`)).content, source.content)
})
