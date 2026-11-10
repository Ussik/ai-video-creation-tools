import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-generation-resume-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { buildApp } = await import('../src/app.js')
const { db, run, one, now } = await import('../src/infrastructure/database/db.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { scriptActivitiesSchema } = await import('../src/modules/script/script-activity.js')
assert.ok(db.name.startsWith(dataDir))
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })
async function post(url: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url, payload: payload as object })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

function outlineEnvelope(episodes: number) {
  return { artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
    content: artifact_type === 'episode_outline'
      ? Array.from({ length: episodes }, (_, index) => `第${index + 1}集：林舟调查线索、守护伙伴，最终归还钥匙。`).join('\n')
      : '林舟拾到钥匙，为守护伙伴寻找失物主人，最终归还钥匙。' })), scenes: [] }
}

const outlineWorkflow = { stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: [...scriptStageArtifacts.outline] } as const
const outlineWorkKeys = ['story', 'narrative', 'world', 'payoffs', 'episodes'].map(id => `work:outline:${id}/draft`)
function outlineForContract(contract: { schema: any }, full: ReturnType<typeof outlineEnvelope>) {
  const types = contract.schema.properties.artifacts.items.properties.artifact_type.enum as string[]
  return { artifacts: full.artifacts.filter(document => types.includes(document.artifact_type)), scenes: [] }
}
function assertCompletedOutlineGroups(steps: Record<string, { value: { artifacts: unknown[] } }>, full: ReturnType<typeof outlineEnvelope>) {
  assert.deepEqual(Object.keys(steps).filter(key => key !== 'progress:source').sort(), [...outlineWorkKeys].sort(), 'all completed work groups survive an independent review failure')
  const documents = Object.entries(steps).filter(([key]) => key !== 'progress:source').flatMap(([, step]) => step.value.artifacts)
  assert.deepEqual(full.artifacts.map(document => documents.find(item => (item as { artifact_type: string }).artifact_type === document.artifact_type)), full.artifacts)
}

function assertFullMaterial(prompt: string, content: string, creatorMessage: string) {
  assert.ok(prompt.includes(content) || prompt.includes(JSON.stringify(content).slice(1, -1)), 'each creation/review request must receive the complete source, not selected passages')
  for (const marker of ['START_FACT', 'MIDDLE_FACT', 'END_FACT']) assert.ok(prompt.includes(marker), `missing ${marker}`)
  assert.ok(prompt.includes(creatorMessage), 'creator original wording must survive intent routing and resume')
}

test('stream retry reuses the complete long-source draft after audit failure and reviews before offering a preview', async t => {
  const project = await post('/api/projects', { name: '全文长稿恢复' })
  const provider = await post('/api/providers', { name: 'fixture', base_url: 'https://fixture.invalid' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'fixture', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
    structured_output_mode: 'json_schema', text_path: 'choices.0.message.content',
  } })
  const content = '全剧9集。START_FACT：林舟得到钥匙。\n' + '林舟沿着线索追查并守护伙伴。'.repeat(1000) + '\nMIDDLE_FACT：伙伴向林舟说明钥匙归属。\n' + '林舟护送伙伴返回故乡。'.repeat(1000) + '\nEND_FACT：林舟归还钥匙。'
  assert.ok(content.length > 24000)
  const creatorMessage = '生成全剧大纲，采用水墨画风，保留伙伴身份与归还钥匙的结局。'
  const source: ScriptSourceDocument = { project_id: project.id, filename: 'story.txt', content, updated_at: now() }
  const analysis = { pipeline_version: sourceAnalysisPipelineVersion, id: 'map', source_version: scriptSourceVersion(source), model_id: model.id, status: 'ready', phase: 'ready', completed_chunks: 1, total_chunks: 1, error: null, updated_at: now(),
    sections: [{ offset: 0, length: content.length, title: '完整主线', episode_number: null, summary: '得到并归还钥匙', characters: [], events: [] }],
    story: { summary: '9集得到并归还钥匙', characters: [], timeline: [], threads: [], ending: { summary: '归还钥匙', section_ids: [0] }, uncertainties: [] } }
  run('INSERT INTO script_source_documents (project_id, filename, content, updated_at) VALUES (?,?,?,?)', project.id, source.filename, content, source.updated_at)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', project.id, analysis.id, analysis.source_version, analysis.status, JSON.stringify(analysis), analysis.updated_at)
  let failAudit = true, reviews = 0
  const contracts: string[] = [], draftPrompts: string[] = [], reviewPrompts: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), prompt: string = body.messages[0].content
    if (prompt.includes('本次独立调用只理解创作者意图')) return Response.json({ choices: [{ message: { content: JSON.stringify(prompt.includes('只讨论画风') ? { action: 'discuss', settings_patch: {} } : { action: 'draft', operation: 'create', authorization: 'explicit', workflow: outlineWorkflow, creative_brief: 'BRIEF_FROM_INTENT：水墨风格，保留已确认伙伴身份。', settings_patch: {} }) }, finish_reason: 'stop' }] })
    if (!body.response_format) return Response.json({ choices: [{ message: { content: '水墨画风可以采用淡墨远景。' }, finish_reason: 'stop' }] })
    const contract = body.response_format.json_schema
    contracts.push(contract.name)
    assert.ok(['workflow_draft', 'script_draft_completeness'].includes(contract.name), `source selectors, stage plans and episode batches are forbidden: ${contract.name}`)
    assertFullMaterial(prompt, content, creatorMessage)
    const reviewed = draftCompletenessFixtureResponse(init)
    if (reviewed) {
      reviews++; reviewPrompts.push(prompt)
      const marker = '待核对草稿原文（资料）：'
      const submitted = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.deepEqual(submitted.map((document: { artifact_type: string }) => document.artifact_type), [...scriptStageArtifacts.outline])
      assert.ok(submitted.every((document: { content: string }, index: number) => document.content === outlineEnvelope(9).artifacts[index]!.content), 'audit must inspect complete candidate bodies')
      if (failAudit) return Response.json({ error: { message: 'fixture upstream interrupted', type: 'server_error' } }, { status: 503 })
      return reviewed
    }
    assert.equal(contract.name, 'workflow_draft')
    assert.match(prompt, /BRIEF_FROM_INTENT/)
    draftPrompts.push(prompt)
    return Response.json({ choices: [{ message: { content: JSON.stringify(outlineForContract(contract, outlineEnvelope(9))) }, finish_reason: 'stop' }] })
  })
  const discussion = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { model_id: model.id, mode: 'script', use_tools: false, messages: [{ role: 'user', text: '只讨论画风，不生成文档。' }] } })
  const discussionEvents = discussion.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.ok(discussionEvents.some(event => event.type === 'delta' && event.text.includes('淡墨远景')), 'ordinary discussion must retain streaming text for long uploads')
  assert.equal(getToolDraft(project.id), null, 'discussion must not acquire creation or saving authorization')
  const payload = { model_id: model.id, mode: 'script', use_tools: true, workflow: outlineWorkflow, messages: [{ role: 'user', text: creatorMessage }] }
  const stream = async (explicitWorkflow = true) => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { ...payload, workflow: explicitWorkflow ? payload.workflow : undefined } })
    assert.equal(response.statusCode, 200, response.body)
    return response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  }
  const first = await stream(false)
  assert.match(first.find(event => event.type === 'error')?.message || '', /核对未完成.*fixture upstream interrupted/)
  assert.equal(getToolDraft(project.id), null, 'failed independent review must not publish a candidate')
  assert.equal(draftPrompts.length, 5, 'the declared nine-document contract follows five dependency groups')
  assert.equal(reviews, 2, 'only the interrupted review receives one bounded transport retry')
  const firstActivities = first.filter(event => event.type === 'activity').map(event => event.activity)
  assert.ok(firstActivities.some(entry => entry.step_id === 'work:outline:story' && entry.scope === 'task'))
  assert.ok(firstActivities.some(entry => entry.kind === 'model' && entry.status === 'failed' && entry.parent_id))
  const checkpoint = one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', project.id)!
  assert.ok(checkpoint)
  const savedSteps = JSON.parse(checkpoint.payload).steps
  assertCompletedOutlineGroups(savedSteps, outlineEnvelope(9))
  assert.equal(one<{ content: string }>('SELECT content FROM script_source_documents WHERE project_id=?', project.id)!.content, content)
  const before = contracts.length
  failAudit = false
  const second = await stream(), done = second.find(event => event.type === 'done')
  assert.ok(done, JSON.stringify(second.filter(event => event.type === 'error')))
  assert.deepEqual(contracts.slice(before), ['script_draft_completeness'], 'resume must review the retained complete draft without regenerating it')
  assert.equal(draftPrompts.length, 5)
  assert.equal(reviews, 3)
  assert.equal(reviewPrompts.at(-1), reviewPrompts[0], 'resume must audit the same source, candidate and creator requirements')
  assert.equal(done.tool_draft.documents.length, 9)
  assert.deepEqual(done.activity.filter((entry: { reused?: boolean; step_id?: string }) => entry.reused).map((entry: { step_id: string }) => entry.step_id).sort(), [...outlineWorkKeys].sort())
  const task = done.activity.find((entry: { scope?: string }) => entry.scope === 'task')
  scriptActivitiesSchema.parse(done.activity)
  assert.equal(task.status, 'succeeded')
  assert.ok(done.activity.filter((entry: { kind: string }) => entry.kind === 'model').every((entry: { status: string; parent_id?: string; request_bytes?: number }) => entry.status === 'succeeded' && entry.parent_id && entry.request_bytes! > 0))
  assert.ok(!second.some(event => event.type === 'delta'), 'internal structured JSON must not accumulate in the chat body')
  assert.equal(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', project.id), undefined)
  assert.equal(one<{ count: number }>('SELECT COUNT(*) count FROM script_artifacts WHERE project_id=?', project.id)!.count, 0, 'preview is not a confirmed save')
  assert.equal(one<{ count: number }>('SELECT COUNT(*) count FROM script_source_revisions WHERE project_id=?', project.id)!.count, 0)
  assert.equal(one<{ content: string }>('SELECT content FROM script_source_documents WHERE project_id=?', project.id)!.content, content)
})

test('whole-source Responses authoring retries once and audit recovery reuses the validated full draft before preview', async t => {
  const project = await post('/api/projects', { name: '完整原文与核对恢复' })
  const provider = await post('/api/providers', { name: 'medium fixture', base_url: 'https://fixture.invalid' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'medium', remote_id: 'medium', modality: 'text', protocol: 'responses', settings: {
    request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, structured_output_mode: 'json_schema', text_path: 'output_text',
  } })
  const content = '全剧1集。START_FACT：林舟拾到钥匙。\n' + '林舟为守护伙伴寻找失物的主人。'.repeat(600) + '\nMIDDLE_FACT：伙伴解释钥匙属于故乡。\n' + '林舟陪同伙伴回乡。'.repeat(600) + '\nEND_FACT：林舟把钥匙归还伙伴。'
  assert.ok(content.length > 12000 && content.length <= 24000)
  const creatorMessage = '生成全剧大纲。CREATOR_STYLE：水墨，保留伙伴身份和钥匙归还结局。'
  const source: ScriptSourceDocument = { project_id: project.id, filename: 'medium.txt', content, updated_at: now() }
  const analysis = { pipeline_version: sourceAnalysisPipelineVersion, id: 'medium-map', source_version: scriptSourceVersion(source), model_id: model.id, status: 'ready', phase: 'ready', completed_chunks: 1, total_chunks: 1, error: null, updated_at: now(),
    sections: [{ offset: 0, length: content.length, title: 'DIRECTORY_ONLY_MARKER', episode_number: 1, summary: '完整主线', characters: [], events: [] }],
    story: { summary: 'GLOBAL_FACT：全剧1集，拾到并归还钥匙', characters: [], timeline: [], threads: [], ending: { summary: '归还伙伴', section_ids: [0] }, uncertainties: [] } }
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', project.id, source.filename, content, source.updated_at)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', project.id, analysis.id, analysis.source_version, analysis.status, JSON.stringify(analysis), analysis.updated_at)
  const contracts: string[] = [], authoring: string[] = [], auditPrompts: string[] = []
  let failAuthor = true, failAudit = true, auditFailures = 0
  const failure = () => Response.json({ status: 'failed', error: { code: 'server_error' } })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), prompt: string = body.input, contract = body.text.format
    contracts.push(contract.name)
    assert.ok(['workflow_draft', 'script_draft_completeness'].includes(contract.name), `source selectors, stage plans and episode batches are forbidden: ${contract.name}`)
    assertFullMaterial(prompt, content, creatorMessage)
    const reviewed = draftCompletenessFixtureResponse(init)
    if (reviewed) {
      assert.ok(prompt.includes('GLOBAL_FACT'), 'review retains source analysis alongside the complete original source')
      auditPrompts.push(prompt)
      const marker = '待核对草稿原文（资料）：'
      const submitted = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.deepEqual(submitted.map((document: { artifact_type: string }) => document.artifact_type), [...scriptStageArtifacts.outline])
      assert.ok(submitted.every((document: { content: string }, index: number) => document.content === outlineEnvelope(1).artifacts[index]!.content))
      if (failAudit) { auditFailures++; return failure() }
      return reviewed
    }
    assert.equal(contract.name, 'workflow_draft')
    authoring.push(prompt)
    if (failAuthor) { failAuthor = false; return failure() }
    return Response.json({ status: 'completed', output_text: JSON.stringify(outlineForContract(contract, outlineEnvelope(1))) })
  })
  const payload = { model_id: model.id, mode: 'script', use_tools: true, workflow: outlineWorkflow, messages: [{ role: 'user', text: creatorMessage }] }
  const stream = async () => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload })
    assert.equal(response.statusCode, 200, response.body)
    return response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  }
  const first = await stream()
  assert.match(first.find(event => event.type === 'error')?.message || '', /核对未完成.*模型服务中断/)
  assert.equal(auditFailures, 2, 'one retry, then preserve the failure instead of looping')
  assert.equal(authoring.length, 6, 'five work groups and the interrupted first group retry complete the declared task')
  assert.equal(authoring[0], authoring[1], 'transient failure retry must retain all original inputs')
  assert.equal(getToolDraft(project.id), null)
  const payloadRow = one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', project.id)!
  assertCompletedOutlineGroups(JSON.parse(payloadRow.payload).steps, outlineEnvelope(1))
  const authoringBefore = authoring.length, callsBefore = contracts.length
  failAudit = false
  const second = await stream(), done = second.find(event => event.type === 'done')
  assert.ok(done, JSON.stringify(second.filter(event => event.type === 'error')))
  assert.equal(authoring.length, authoringBefore, 'retry after audit failure must not regenerate completed documents')
  assert.deepEqual(contracts.slice(callsBefore), ['script_draft_completeness'])
  assert.equal(auditPrompts.length, 3)
  assert.ok(auditPrompts.every(prompt => prompt === auditPrompts[0]), 'all review attempts must see the same complete source and candidate')
  assert.deepEqual(done.activity.filter((entry: { reused?: boolean }) => entry.reused).map((entry: { step_id: string }) => entry.step_id).sort(), [...outlineWorkKeys].sort())
  const entries = first.filter(event => event.type === 'activity').map(event => event.activity)
  assert.ok(entries.some(entry => entry.label === '当前步骤自动重试' && entry.scope === 'step' && entry.summary.includes('此前完成结果保留')))
  assert.ok(entries.some(entry => entry.kind === 'model' && entry.status === 'failed'))
  scriptActivitiesSchema.parse(done.activity)
  assert.equal(done.tool_draft.documents.length, 9)
  assert.equal(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', project.id), undefined)
  for (const table of ['script_artifacts', 'script_source_revisions']) assert.equal(one<{ count: number }>(`SELECT COUNT(*) count FROM ${table} WHERE project_id=?`, project.id)!.count, 0)
  assert.equal(one<{ content: string }>('SELECT content FROM script_source_documents WHERE project_id=?', project.id)!.content, content)
})

test('Responses output-limit continuation preserves eight complete documents and resumes only audit after its failure', async t => {
  const project = await post('/api/projects', { name: '输出截断语义接续与核对恢复' })
  const provider = await post('/api/providers', { name: 'continuation fixture', base_url: 'https://fixture.invalid' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'continuation', remote_id: 'continuation', modality: 'text', protocol: 'responses', settings: {
    request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, structured_output_mode: 'json_schema', text_path: 'output_text',
  } })
  const content = '全剧9集。START_FACT：林舟拾到钥匙。\n' + '林舟为守护伙伴沿着线索寻找钥匙主人。'.repeat(900)
    + '\nMIDDLE_FACT：伙伴解释钥匙属于故乡。\n' + '林舟与伙伴护送钥匙返回故乡。'.repeat(900) + '\nEND_FACT：林舟把钥匙归还伙伴。'
  assert.ok(content.length > 24000 && content.length < 100000)
  const creatorMessage = '生成全剧九集故事大纲。CREATOR_CONTINUITY：水墨画风，保留伙伴身份、因果和归还钥匙的结局，每集完整展开。'
  const source: ScriptSourceDocument = { project_id: project.id, filename: 'continuation.txt', content, updated_at: now() }
  const analysis = { pipeline_version: sourceAnalysisPipelineVersion, id: 'continuation-map', source_version: scriptSourceVersion(source), model_id: model.id,
    status: 'ready', phase: 'ready', completed_chunks: 1, total_chunks: 1, error: null, updated_at: now(),
    sections: [{ offset: 0, length: content.length, title: '完整九集主线', episode_number: null, summary: '拾到并归还钥匙', characters: [], events: [] }],
    story: { summary: 'GLOBAL_CONTINUITY：全剧九集，伙伴身份已确认，钥匙最终归还', characters: [], timeline: [], threads: [],
      ending: { summary: '归还伙伴', section_ids: [0] }, uncertainties: [] } }
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', project.id, source.filename, content, source.updated_at)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', project.id, analysis.id, analysis.source_version, analysis.status, JSON.stringify(analysis), analysis.updated_at)
  const sourceBefore = one('SELECT * FROM script_source_documents WHERE project_id=?', project.id)
  const full = outlineEnvelope(9)
  const blocks = full.artifacts[8]!.content.split('\n').map((content, index) => ({ id: `episode:${index + 1}`, title: scriptArtifactLabels.episode_outline, content, scenes: [] }))
  full.artifacts[8]!.content = blocks.map(block => block.content).join('\n\n')
  const truncated = '{"artifacts":[{"artifact_type":"episode_outline","title":"分集大纲","content":"TRUNCATED_TAIL_MUST_NOT_SURVIVE'
  const contracts: string[] = [], authoring: string[] = [], continuations: string[] = [], reviewPrompts: string[] = []
  let failReview = true
  const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), prompt: string = body.input, contract = body.text?.format
    assert.ok(contract, 'explicit workflow must use structured stage contracts')
    assert.equal(body.max_output_tokens, undefined, 'authoring and continuation must not invent or overwrite the model output budget')
    contracts.push(contract.name)
    assert.ok(['workflow_draft', 'script_stage_blocks', 'script_draft_completeness'].includes(contract.name), `input splitting and selectors must not return: ${contract.name}`)
    assertFullMaterial(prompt, content, creatorMessage)
    const reviewed = draftCompletenessFixtureResponse(init)
    if (reviewed) {
      assert.ok(prompt.includes('GLOBAL_CONTINUITY'), 'review retains whole-story analysis without replacing the full source')
      reviewPrompts.push(prompt)
      const marker = '待核对草稿原文（资料）：'
      const submitted = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.deepEqual(submitted.map((document: { artifact_type: string; content: string }) => ({ artifact_type: document.artifact_type, content: document.content })), full.artifacts.map(({ artifact_type, content }) => ({ artifact_type, content })),
        'independent audit must receive all nine complete documents in their original order')
      assert.ok(!prompt.includes('TRUNCATED_TAIL_MUST_NOT_SURVIVE'), 'unclosed JSON tail must never enter review')
      if (failReview) return Response.json({ status: 'failed', error: { code: 'server_error' } })
      return reviewed
    }
    if (contract.name === 'workflow_draft') {
      authoring.push(prompt)
      const output = outlineForContract(contract, full)
      if (output.artifacts[0]?.artifact_type !== 'episode_outline') return Response.json({ status: 'completed', output_text: JSON.stringify(output) })
      assert.equal(authoring.length, 5, 'the first four successful groups must precede episode continuation')
      const cut = Math.floor(truncated.length / 2)
      return sse([{ type: 'response.output_text.delta', delta: truncated.slice(0, cut) }, { type: 'response.output_text.delta', delta: truncated.slice(cut) },
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'message', content: [{ type: 'output_text', text: truncated }] }], usage: { input_tokens: 40000, output_tokens: 16000, output_tokens_details: { reasoning_tokens: 8000 } } } }])
    }
    assert.equal(contract.name, 'script_stage_blocks')
    continuations.push(prompt)
    assert.ok(prompt.includes('episode_outline'), 'only the ninth document should remain as the continuation target')
    for (const document of full.artifacts.slice(0, 8)) assert.ok(prompt.includes(JSON.stringify(document)), 'every retained complete document must inform continuation')
    assert.ok(!prompt.includes('TRUNCATED_TAIL_MUST_NOT_SURVIVE'), 'partial document content must be regenerated as complete semantic units')
    const raw = JSON.stringify({ blocks, complete: true })
    return sse([{ type: 'response.output_text.delta', delta: raw }, { type: 'response.completed', response: { status: 'completed', output_text: raw } }])
  })
  const payload = { model_id: model.id, mode: 'script', use_tools: true, workflow: outlineWorkflow, messages: [{ role: 'user', text: creatorMessage }] }
  const stream = async () => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload })
    assert.equal(response.statusCode, 200, response.body)
    return response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  }
  const assertUncommitted = () => {
    assert.deepEqual(one('SELECT * FROM script_source_documents WHERE project_id=?', project.id), sourceBefore, 'creation and review must preserve the effective source until confirmation')
    for (const table of ['script_artifacts', 'script_source_revisions']) assert.equal(one<{ count: number }>(`SELECT COUNT(*) count FROM ${table} WHERE project_id=?`, project.id)!.count, 0)
  }
  const first = await stream()
  assert.match(first.find(event => event.type === 'error')?.message || '', /核对未完成.*模型服务中断/)
  assert.equal(authoring.length, 5); assert.equal(continuations.length, 1); assert.equal(reviewPrompts.length, 2)
  assert.ok(!first.some(event => event.type === 'delta'), 'initial and continuation JSON must not leak into chat text even when the independent audit fails')
  assert.deepEqual(contracts, [...Array(5).fill('workflow_draft'), 'script_stage_blocks', 'script_draft_completeness', 'script_draft_completeness'])
  const activities = scriptActivitiesSchema.parse([...new Map(first.filter(event => event.type === 'activity').map(event => [event.activity.id, event.activity] as const)).values()])
  const draftStep = activities.find(entry => entry.kind === 'context' && entry.scope === 'task' && entry.step_id === 'work:outline:episodes')
  assert.ok(draftStep)
  assert.ok(first.some(event => event.type === 'activity' && event.activity.id === draftStep.id && /正在从已保留内容继续/.test(event.activity.summary)),
    'continuation updates the existing episode task while the eight dependency documents remain intact')
  const draftCalls = activities.filter(entry => entry.kind === 'model' && entry.parent_id === draftStep.id)
  assert.deepEqual(draftCalls.map(entry => ({ label: entry.label, status: entry.status })), [
    { label: '模型编写完整阶段草稿', status: 'failed' },
    { label: '模型继续编写未完成内容', status: 'succeeded' },
  ], 'both actual model calls remain under the same draft step')
  assert.equal(activities.filter(entry => entry.scope === 'task' && entry.step_id === 'work:outline:episodes').length, 1,
    'output-limit continuation must retain one business task')
  assert.equal(getToolDraft(project.id), null, 'failed independent audit must not publish a candidate')
  const checkpoint = JSON.parse(one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', project.id)!.payload)
  assertCompletedOutlineGroups(checkpoint.steps, full)
  assertUncommitted()
  const callsBefore = contracts.length
  failReview = false
  const second = await stream(), done = second.find(event => event.type === 'done')
  assert.ok(done, JSON.stringify(second.filter(event => event.type === 'error')))
  assert.deepEqual(contracts.slice(callsBefore), ['script_draft_completeness'], 'recovery must only repeat the independent audit')
  assert.equal(authoring.length, 5); assert.equal(continuations.length, 1); assert.equal(reviewPrompts.length, 3)
  assert.ok(reviewPrompts.every(prompt => prompt === reviewPrompts[0]))
  const documents = done.tool_draft.documents.map((document: { artifact_type: string; title: string; content: string }) => ({ artifact_type: document.artifact_type, title: document.title, content: document.content }))
  assert.deepEqual(documents, full.artifacts, 'eight retained originals and the complete ninth document must appear exactly once')
  assert.equal(new Set(documents.map((document: { artifact_type: string }) => document.artifact_type)).size, 9)
  assert.ok(!JSON.stringify(documents).includes('TRUNCATED_TAIL_MUST_NOT_SURVIVE'))
  assert.deepEqual(done.activity.filter((entry: { reused?: boolean }) => entry.reused).map((entry: { step_id: string }) => entry.step_id).sort(), [...outlineWorkKeys].sort())
  assert.ok(!second.some(event => event.type === 'delta'), 'internal structured outputs must not leak into chat text')
  assert.equal(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', project.id), undefined)
  scriptActivitiesSchema.parse(done.activity)
  assertUncommitted()
})

test('Responses disconnected streams checkpoint complete documents through onPartial and explicit resume writes only missing documents', async t => {
  const project = await post('/api/projects', { name: '流断连完整单元恢复' })
  const provider = await post('/api/providers', { name: 'disconnected fixture', base_url: 'https://fixture.invalid' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'disconnected', remote_id: 'disconnected', modality: 'text', protocol: 'responses', settings: {
    request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, structured_output_mode: 'json_schema', text_path: 'output_text',
  } })
  const content = '全剧9集。START_FACT：林舟拾到钥匙。\n' + '林舟调查线索并与伙伴共同守护钥匙。'.repeat(1000)
    + '\nMIDDLE_FACT：伙伴解释钥匙的归属。\n' + '林舟与伙伴一起护送钥匙。'.repeat(1000) + '\nEND_FACT：林舟归还钥匙。'
  assert.ok(content.length > 24000 && content.length < 100000)
  const creatorMessage = '生成完整九集大纲。CREATOR_DISCONNECT：采用水墨画风，伙伴身份和归还钥匙的结局都必须保留，已完整写出的文档原样复用。'
  const source: ScriptSourceDocument = { project_id: project.id, filename: 'disconnected.txt', content, updated_at: now() }
  const analysis = { pipeline_version: sourceAnalysisPipelineVersion, id: 'disconnected-map', source_version: scriptSourceVersion(source), model_id: model.id,
    status: 'ready', phase: 'ready', completed_chunks: 1, total_chunks: 1, error: null, updated_at: now(),
    sections: [{ offset: 0, length: content.length, title: '完整主线', episode_number: null, summary: '伙伴与钥匙的归属', characters: [], events: [] }],
    story: { summary: 'GLOBAL_DISCONNECT：全剧九集，保留伙伴身份，林舟最终归还钥匙', characters: [], timeline: [], threads: [],
      ending: { summary: '归还钥匙', section_ids: [0] }, uncertainties: [] } }
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', project.id, source.filename, content, source.updated_at)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', project.id, analysis.id, analysis.source_version, analysis.status, JSON.stringify(analysis), analysis.updated_at)
  const sourceBefore = one('SELECT * FROM script_source_documents WHERE project_id=?', project.id)
  const full = outlineEnvelope(9)
  full.artifacts[0]!.content = 'RETAINED_OUTLINE：林舟拾到钥匙，为守护伙伴沿线索返乡，结局将钥匙归还伙伴。'
  full.artifacts[1]!.content = 'RETAINED_SYNOPSIS：伙伴说出钥匙归属，林舟因此护送伙伴返乡，最终归还钥匙，伙伴身份全程不变。'
  const firstDocument = '{"artifacts":[' + JSON.stringify(full.artifacts[1])
  const partial = firstDocument + ',{"artifact_type":"structure","title":"叙事结构","content":"DISCONNECTED_TAIL_MUST_NOT_SURVIVE'
  const contracts: string[] = [], continuationTargets: string[] = []
  const groupCalls = new Map<string, number>()
  let reviews = 0
  const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), prompt: string = body.input, contract = body.text?.format
    assert.ok(contract)
    contracts.push(contract.name)
    assert.equal(body.max_output_tokens, undefined)
    assertFullMaterial(prompt, content, creatorMessage)
    const reviewed = draftCompletenessFixtureResponse(init)
    if (reviewed) {
      assert.ok(prompt.includes('GLOBAL_DISCONNECT'))
      reviews++
      const marker = '待核对草稿原文（资料）：'
      const submitted = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.deepEqual(submitted.map((document: { artifact_type: string; content: string }) => ({ artifact_type: document.artifact_type, content: document.content })),
        full.artifacts.map(({ artifact_type, content }) => ({ artifact_type, content })))
      assert.ok(!prompt.includes('DISCONNECTED_TAIL_MUST_NOT_SURVIVE'))
      return reviewed
    }
    if (contract.name === 'workflow_draft') {
      const output = outlineForContract(contract, full)
      const group = output.artifacts.map(document => document.artifact_type).join(',')
      groupCalls.set(group, (groupCalls.get(group) || 0) + 1)
      assert.equal(groupCalls.get(group), 1, 'once complete units exist, a disconnected request must stop instead of replaying competing prose')
      if (group !== 'synopsis,structure') return Response.json({ status: 'completed', output_text: JSON.stringify(output) })
      // No response.incomplete or terminal partialText exists here. The app's
      // real third callback must retain the closed objects before SSE EOF.
      return sse([{ type: 'response.output_text.delta', delta: firstDocument }, { type: 'response.output_text.delta', delta: partial.slice(firstDocument.length) }])
    }
    assert.equal(contract.name, 'script_stage_blocks')
    const target = /当前目标：([a-z_]+)（/.exec(prompt)?.[1]
    assert.ok(target)
    continuationTargets.push(target)
    assert.ok(!['outline', 'synopsis'].includes(target), 'retained complete documents must never be regenerated')
    for (const document of full.artifacts.slice(0, 2)) assert.ok(prompt.includes(JSON.stringify(document)), 'original retained text must inform every continuation')
    assert.ok(!prompt.includes('DISCONNECTED_TAIL_MUST_NOT_SURVIVE'))
    const document = full.artifacts.find(document => document.artifact_type === target)!
    assert.ok(document)
    const raw = JSON.stringify({ blocks: [{ id: `artifact:${target}`, title: document.title, content: document.content, scenes: [] }], complete: true })
    return sse([{ type: 'response.output_text.delta', delta: raw }, { type: 'response.completed', response: { status: 'completed', output_text: raw } }])
  })
  const payload = { model_id: model.id, mode: 'script', use_tools: true, workflow: outlineWorkflow, messages: [{ role: 'user', text: creatorMessage }] }
  const stream = async () => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload })
    assert.equal(response.statusCode, 200, response.body)
    return response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  }
  const assertUncommitted = () => {
    assert.deepEqual(one('SELECT * FROM script_source_documents WHERE project_id=?', project.id), sourceBefore)
    for (const table of ['script_artifacts', 'script_source_revisions']) assert.equal(one<{ count: number }>(`SELECT COUNT(*) count FROM ${table} WHERE project_id=?`, project.id)!.count, 0)
  }
  const first = await stream()
  assert.match(first.find(event => event.type === 'error')?.message || '', /连接提前结束/)
  assert.ok(!first.some(event => event.type === 'delta'), 'checkpointing streamed JSON must not expose internal text before a disconnect')
  assert.ok(!first.some(event => event.type === 'done'))
  assert.deepEqual([...groupCalls.keys()].sort(), ['outline', 'synopsis,structure', 'world,constraints'].sort())
  assert.equal(continuationTargets.length, 0); assert.equal(reviews, 0)
  assert.equal(getToolDraft(project.id), null)
  const checkpoint = JSON.parse(one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', project.id)!.payload)
  assert.deepEqual(Object.keys(checkpoint.steps).filter(key => key !== 'progress:source').sort(), ['work:outline:story/draft', 'work:outline:world/draft', 'work:outline:narrative/draft:stream:state'].sort(),
    'independent successful world work is saved even when its concurrent narrative sibling disconnects')
  assert.deepEqual(checkpoint.steps['work:outline:narrative/draft:stream:state'].value.artifacts, [full.artifacts[1]], 'SSE progress must be synchronously checkpointed before EOF rejects')
  assert.deepEqual(checkpoint.steps['work:outline:story/draft'].value.artifacts, [full.artifacts[0]])
  assert.deepEqual(checkpoint.steps['work:outline:world/draft'].value.artifacts, full.artifacts.filter(document => ['world', 'constraints'].includes(document.artifact_type)))
  assert.ok(!JSON.stringify(checkpoint).includes('DISCONNECTED_TAIL_MUST_NOT_SURVIVE'))
  assertUncommitted()
  const callsBefore = contracts.length
  const second = await stream(), done = second.find(event => event.type === 'done')
  assert.ok(done, JSON.stringify(second.filter(event => event.type === 'error')))
  assert.deepEqual([...groupCalls.values()], [1, 1, 1, 1, 1], 'completed story/world groups and retained narrative content are never regenerated')
  assert.deepEqual(contracts.slice(callsBefore), ['script_stage_blocks', 'workflow_draft', 'workflow_draft', 'script_draft_completeness'])
  assert.deepEqual(continuationTargets, ['structure'])
  assert.equal(reviews, 1)
  const documents = done.tool_draft.documents.map((document: { artifact_type: string; title: string; content: string }) => ({ artifact_type: document.artifact_type, title: document.title, content: document.content }))
  assert.deepEqual(documents, full.artifacts)
  assert.equal(new Set(documents.map((document: { artifact_type: string }) => document.artifact_type)).size, 9)
  assert.ok(!JSON.stringify(documents).includes('DISCONNECTED_TAIL_MUST_NOT_SURVIVE'))
  assert.ok(!second.some(event => event.type === 'delta'))
  assert.equal(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', project.id), undefined)
  scriptActivitiesSchema.parse(done.activity)
  assertUncommitted()
})
