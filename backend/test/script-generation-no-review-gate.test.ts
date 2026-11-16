import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const directory = await mkdtemp(join(tmpdir(), 'generation-no-review-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer } = await import('../src/modules/script/script-source-analysis.js')
const { retainScriptDraft, pendingScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as any
}

test('uploaded source supports all saved stages through episode one without automatic quality-review dispatches', async t => {
  const project = await api('POST', '/api/projects', { name: '分析后直接创作' })
  const provider = await api('POST', '/api/providers', { name: 'isolated', base_url: 'https://no-review.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: 'fixture', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    structured_output_mode: 'json_schema', request_path: 'chat/completions', text_path: 'choices.0.message.content',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
  } })
  const content = '背景设定：午夜才能巡夜。人物：林舟，持灯调查者。\n第1集：林舟在街口点灯，发现伙伴并归还钥匙。'
  const boundary = 'no-review'
  const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="story.md"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => sourceAnalysisFixture(prompt)!)
  try { await analyzer.ensure(project.id, model.id) } finally { await analyzer.close() }
  const source = await api('GET', `/api/projects/${project.id}/script/source`)
  assert.equal(source.analysis.status, 'ready'); assert.equal(source.analysis.quality, undefined)
  const historical = retainScriptDraft(project.id, {
    draft: workflowGenerationDraftSchema.parse({ stage: 'outline', intent: 'source_outline', artifact_types: ['outline'],
      artifacts: [{ artifact_type: 'outline', title: '历史候选稿', content: '林舟在街口点灯。' }], scenes: [] }),
    request: { model_id: model.id, mode: 'script', use_tools: false, messages: [{ role: 'user', text: '历史任务' }] },
    source_version: 'historical-source-version', findings: [{ source_key: 'outline', kind: 'contradiction',
      quote: '林舟在街口点灯。', explanation: '历史诊断仍保留', suggestion: '供后续参考' }],
  })
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/no-review\.invalid\//)
    const body = JSON.parse(String(init?.body)), contract = body.response_format?.json_schema
    calls.push(contract?.name || 'unstructured')
    assert.equal(contract?.name, 'workflow_draft', 'ordinary creation must never dispatch audit/repair/recheck')
    const prompt: string = body.messages[0].content
    assert.ok(prompt.includes(JSON.stringify(content).slice(1, -1)), 'authoring still receives the original manuscript')
    const field = contract.schema.properties.artifacts.items.properties.artifact_type
    const types: string[] = field.enum || [field.const]
    const episode = types.includes('episode_script')
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      artifacts: types.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type as keyof typeof scriptArtifactLabels],
        content: artifact_type === 'episode_outline' ? '第1集：林舟在街口点灯，找到伙伴，归还钥匙。' : '林舟在午夜街口点灯，发现伙伴并归还钥匙。' })),
      scenes: episode ? [{ heading: '街口点灯', location: '街口', time_of_day: '夜', characters: '林舟', action: '林舟点灯，发现伙伴并归还钥匙。', dialogue: '林舟：钥匙还给你。', narration: '', duration: 15 }] : [],
    }) }, finish_reason: 'stop' }] })
  })
  for (const stage of ['outline', 'characters', 'locations', 'props', 'episode'] as const) {
    const episode_number = stage === 'episode' ? 1 : 0
    const generated = await api('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, use_tools: true, mode: 'script',
      workflow: { stage, episode_number, intent: 'stage_design', artifact_types: [...scriptStageArtifacts[stage]] }, messages: [{ role: 'user', text: `生成${stage}阶段，先预览，不自动保存。` }] })
    assert.ok(generated.tool_draft, `${stage} supplies a review-free preview`)
    const draft = generated.tool_draft
    assert.equal(draft.status, 'pending')
    const before = await api('GET', `/api/projects/${project.id}`)
    assert.equal((before.script.artifacts || []).filter((item: any) => scriptStageArtifacts[stage].includes(item.artifact_type as never)).length, 0)
    await api('POST', `/api/projects/${project.id}/script/director/tool-drafts/${draft.id}/commit`, { version: draft.version, approved: true })
  }
  const final = await api('GET', `/api/projects/${project.id}`)
  assert.deepEqual(pendingScriptDraft(project.id), historical, 'historical audit candidates are preserved without blocking any production stage')
  assert.equal(final.script.artifacts.length, Object.values(scriptStageArtifacts).flat().length)
  assert.equal(final.script.scenes.length, 1); assert.equal(final.script.scenes[0].episode_number, 1)
  assert.equal(calls.length, Object.values(scriptStageArtifacts).flat().length)
  assert.deepEqual((await api('GET', `/api/projects/${project.id}/script/source`)).analysis.story, source.analysis.story)
  assert.equal((await api('GET', `/api/projects/${project.id}/script/source`)).content, content)
})
