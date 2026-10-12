import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptStageArtifacts, scriptArtifactLabels, type ScriptStage } from '@video-studio/shared/script/script-stage-content'
import { creativeReviewCategories, scriptReviewGuidance } from '@video-studio/shared/script/script-quality'
import type { DocumentReview } from '@video-studio/shared/script/script-review-types'
import type { Project, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot, ScriptToolDraft } from '../src/modules/script/script-document-tools.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-script-tools-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, run, one, all } = await import('../src/infrastructure/database/db.js')
const { documentTools, scriptFunctions, getToolDraft, commitToolDraft, discardToolDraft, editToolDraft, storyDecisions, replacePassages, toolConversationStage, creationState, acceptCreationStep } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const { installSkillBundle, configureSkill } = await import('../src/modules/skills/skills.js')
function stageArtifacts(stage: ScriptStage, content: string) {
  return scriptStageArtifacts[stage].map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: `${scriptArtifactLabels[artifact_type]}：${content}` }))
}
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
function discussionIntent(init?: RequestInit): Response | undefined {
  const body = JSON.parse(String(init?.body || '{}'))
  const prompt = JSON.stringify(body.messages || body.input || '')
  if (prompt.includes('本次独立调用只理解创作者意图')) return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'discuss', settings_patch: {} }) }, finish_reason: 'stop' }], output_text: JSON.stringify({ action: 'discuss', settings_patch: {} }) })
}
async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) })
  assert.equal(response.statusCode, 200, response.body); return response.json() as T
}
async function fixture() {
  const project = await call<Project>('POST', '/api/projects', { name: '工具测试故事' })
  const script = (): ScriptSnapshot => {
    const row = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', project.id)
    return { outline: row?.outline || '', characters: row?.characters || '', generation_options: JSON.parse(row?.generation_options || '{}'),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', project.id), scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', project.id) }
  }
  const makeTools = (extra: Partial<Parameters<typeof documentTools>[0]> = {}) => documentTools({ project, script, stage: directorStageContext(script()), messages: [{ role: 'user', text: '林晚是记者，修改她的待定设定' }], checkApproval: async () => false, onEvent: () => {}, ...extra })
  return { project, script, makeTools }
}
async function artifact(projectId: string, type = 'characters', content = '林晚：身份待定。\n陈默：外科医生。') {
  await call('PUT', `/api/projects/${projectId}/script/artifacts`, { artifacts: [{ artifact_type: type, episode_number: type === 'episode_script' ? 1 : 0, title: type, content, status: 'ready' }] })
}
async function readDoc(tools: ReturnType<typeof documentTools>, id: string) {
  const result = await tools.execute('read_documents', { document_ids: [id] }) as { documents: Array<{ id: string; version: string; content: string; scenes?: Array<{ id: string; version: string }> }> }
  return result.documents[0]
}

test('design tool schemas include all subdocuments and complete historical stages without changing original documents', async () => {
  const parameters = scriptFunctions.find(tool => tool.name === 'create_document_draft')!.parameters as {
    properties: { artifacts: { items: { required: string[]; properties: { artifact_type: { enum: string[] } } } } }
  }
  assert.ok(parameters.properties.artifacts.items.required.includes('title'))
  for (const stage of ['locations', 'props'] as const) {
    const { project, script, makeTools } = await fixture()
    await artifact(project.id, stage, '\n# 模型原有标题\n已确认的完整设计原文\n')
    await artifact(project.id, 'episode_script', '已保存的分集正文')
    const before = script(), original = before.artifacts!.find(doc => doc.artifact_type === stage)!
    const tools = makeTools({ workflow: stage, operation: 'supplement', stage: directorStageContext(script(), { explicit: { stage, episode_number: 0 } }) })
    const artifacts = stageArtifacts(stage, '具体设计内容').map(doc => doc.artifact_type === stage ? { ...doc, title: original.title, content: original.content } : doc)
    for (const type of scriptStageArtifacts[stage]) assert.ok(parameters.properties.artifacts.items.properties.artifact_type.enum.includes(type))
    await assert.rejects(tools.execute('create_document_draft', { stage, artifacts: artifacts.slice(0, 1), scenes: [] }), /当前阶段缺少完整文档/)
    await assert.rejects(tools.execute('create_document_draft', { stage, artifacts, scenes: [] }), /读完/)
    assert.equal(getToolDraft(project.id), null)
    await readDoc(tools, original.id)
    await assert.rejects(tools.execute('create_document_draft', { stage, artifacts: artifacts.map((doc, i) => i === 0 ? { ...doc, content: '覆盖旧设计' } : doc), scenes: [] }), /原样保留/)
    await tools.execute('create_document_draft', { stage, artifacts, scenes: [] })
    const generated = getToolDraft(project.id)!
    assert.equal(generated.documents.length, 4)
    assert.deepEqual(script(), before, 'generation never writes documents')
    commitToolDraft(project.id, generated.id, generated.version, script)
    assert.equal(script().artifacts!.length, 5)
    for (const doc of before.artifacts!) assert.deepEqual(script().artifacts!.find(item => item.id === doc.id), doc)
    for (const type of scriptStageArtifacts[stage]) assert.ok(script().artifacts!.find(item => item.artifact_type === type)?.content.trim())
  }
})

test('creative quality reviews require full source evidence, persist all dimensions and preserve script data', async () => {
  const { project, script, makeTools } = await fixture()
  await artifact(project.id, 'characters', '林晚主动放弃追查。\n她下一场仍继续追查，却没有作出新决定。')
  await artifact(project.id, 'relationships', '林晚向陈默索取线索，陈默隐瞒弟弟的下落。')
  const before = script(), doc = before.artifacts![0], relationship = before.artifacts![1]
  const tools = makeTools({ action: { operation: 'review', document_ids: [doc.id] } })
  const context = await tools.execute('get_document_review_context', { document_ids: [doc.id] }) as { review_guidance: string }
  assert.equal(context.review_guidance, scriptReviewGuidance)
  const read = await readDoc(tools, doc.id)
  const report = { summary: '核查了人物行为与关系，以下为创作建议，不改正文。', documents: [{ id: doc.id, version: read.version }], findings: creativeReviewCategories.map(category => ({
    document_id: doc.id, document_version: read.version, category, severity: 'info', quote: '林晚主动放弃追查。',
    explanation: '需结合后续场次说明行动变化的依据。', suggestion: '补充促使她重新追查的具体事件和选择。', related: [{ kind: 'document', id: relationship.id, title: '人物关系' }],
  })) }
  await assert.rejects(makeTools().execute('submit_document_review', report), /读完/)
  const incomplete = makeTools(); await incomplete.execute('read_documents', { document_ids: [doc.id], length: 5 })
  await assert.rejects(incomplete.execute('submit_document_review', report), /读完/)
  await assert.rejects(tools.execute('submit_document_review', { ...report, findings: [{ ...report.findings[0], quote: '原文没有这句' }] }), /逐字/)
  await assert.rejects(tools.execute('submit_document_review', { ...report, documents: [{ id: doc.id, version: 'stale' }] }), /读完/)
  await readDoc(tools, relationship.id)
  const result = await tools.execute('submit_document_review', report) as { review: DocumentReview; document_saved: boolean }
  assert.deepEqual(result.review.findings.map(item => item.category), [...creativeReviewCategories])
  assert.equal(result.document_saved, false)
  assert.deepEqual(script(), before)
  assert.equal(getToolDraft(project.id), null)
  assert.equal(storyDecisions(project.id).length, 0)
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'quality-review-conversation', label: '作品质量审读', messages: [{
    role: 'assistant', text: '专业审读建议', reply_metadata: { review: result.review },
  }] })
  const restored = await call<{ conversations: Array<{ messages: Array<{ review: DocumentReview }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.deepEqual(restored.conversations[0].messages[0].review, result.review)
  const health = await tools.execute('get_document_review_context', {}) as { document_health: Array<{ document_id: string; findings: unknown[] }> }
  assert.equal(health.document_health.find(item => item.document_id === doc.id)?.findings.length, 5)
  run('UPDATE script_artifacts SET content=? WHERE id=?', '人物作出了新的选择。', doc.id)
  const refreshed = await tools.execute('get_document_review_context', {}) as { document_health: Array<{ document_id: string; status: string; findings: unknown[] }> }
  assert.equal(refreshed.document_health.find(item => item.document_id === doc.id)?.status, 'stale')
  assert.equal(refreshed.document_health.find(item => item.document_id === doc.id)?.findings.length, 0)
})

test('creative reviews cannot submit another project or expand a selected review scope', async () => {
  const a = await fixture(), b = await fixture()
  await artifact(a.project.id, 'characters'); await artifact(a.project.id, 'relationships'); await artifact(b.project.id)
  const [first, second] = a.script().artifacts!, outside = b.script().artifacts![0]
  const tools = a.makeTools({ action: { operation: 'review', document_ids: [first.id] } })
  const read = await readDoc(tools, second.id)
  await assert.rejects(tools.execute('submit_document_review', { summary: '越界报告', documents: [{ id: second.id, version: read.version }], findings: [] }), /只评审选定/)
  await assert.rejects(tools.execute('read_documents', { document_ids: [outside.id] }), /当前项目/)
})
const patch = (id: string, version: string) => ({ summary: '补齐林晚身份', changes: [{ document_id: id, base_version: version, replacements: [{ find: '林晚：身份待定。', replace: '林晚：调查记者，追查失踪案。', reason: '创作者已确定职业与剧情目标' }] }] })

async function startRevision(tools: ReturnType<typeof documentTools>, documentIds?: string[]) {
  return tools.execute('manage_revision_task', { operation: 'start', summary: '由模型补齐全部待定设定并统一核对', source_message_index: 0, ...(documentIds ? { document_ids: documentIds } : { scope: 'all_documents' }) }) as Promise<{ task: NonNullable<ScriptToolDraft['revision_task']>; draft_id: string; version: string }>
}
async function readEffective(tools: ReturnType<typeof documentTools>, id: string, extra = {}) {
  const result = await tools.execute('read_documents', { source: 'draft', document_ids: [id], ...extra }) as { documents: Array<{ id: string; version: string; content: string; scenes?: Array<{ id: string; version: string }> }> }
  return result.documents[0]
}
async function verifyRevision(tools: ReturnType<typeof documentTools>, projectId: string) {
  const task = getToolDraft(projectId)!.revision_task!
  for (let offset = 0; offset < task.documents.length; offset += 8) {
    const documents = []
    for (const doc of task.documents.slice(offset, offset + 8)) {
      const read = await readEffective(tools, doc.id)
      documents.push({ document_id: doc.id, version: read.version, conclusion: 'resolved', explanation: '核对全组有效草稿与统一决定，作者待定已补齐，保留主线。', findings: [] })
    }
    const current = getToolDraft(projectId)!
    await tools.execute('review_revision_batch', { task_id: task.id, version: current.version, documents })
  }
}

test('more than eight document edits are merged and accumulated atomically across resumed sessions', async () => {
  const { project, script, makeTools } = await fixture()
  for (const type of ['outline', 'synopsis', 'world', 'characters', 'relationships', 'locations', 'props', 'episode_outline', 'structure']) await artifact(project.id, type)
  const source = script(), tools = makeTools(), started = await startRevision(tools)
  assert.equal(started.task.documents.length, 9)
  const changes = []
  for (const doc of source.artifacts!) { const read = await readDoc(tools, doc.id); changes.push(patch(doc.id, read.version).changes[0]) }
  // Two entries for the same document are normalized before the eight-doc grouping.
  changes.push({ ...changes[0], replacements: [{ find: '陈默：外科医生。', replace: '陈默：急诊外科医生。', reason: '补齐救援职责' }] })
  changes.push(changes[0])
  const bad = { summary: '第一批', task_id: started.task.id, draft_version: started.version, changes: changes.map((change, index) => index === 8 ? { ...change, replacements: [{ find: '不存在的原文', replace: '记者', reason: '测试' }] } : change) }
  await assert.rejects(tools.execute('propose_document_patch', bad), /找不到/)
  assert.equal(getToolDraft(project.id)!.documents.length, 0, 'a failing item cannot save the other eight documents')
  const first = await tools.execute('propose_document_patch', { ...bad, changes }) as { batches: number; version: string }
  assert.equal(first.batches, 2); assert.equal(getToolDraft(project.id)!.documents.length, 9)
  assert.deepEqual(script(), source)
  assert.throws(() => commitToolDraft(project.id, started.draft_id, first.version, script), /尚未完成/)
  const resumed = makeTools(), doc = source.artifacts![0]
  const read = await readEffective(resumed, doc.id)
  await resumed.execute('propose_document_patch', { summary: '继续细化', task_id: started.task.id, draft_version: first.version,
    changes: [{ document_id: doc.id, base_version: read.version, replacements: [{ find: '调查记者', replace: '独立调查记者', reason: '沿用同一决定细化' }] }] })
  const continued = getToolDraft(project.id)!
  assert.equal(continued.id, started.draft_id); assert.equal(continued.revision_task!.batches, 3)
  assert.match(continued.documents.find(item => item.id === doc.id)!.content, /独立调查记者/)
  await assert.rejects(resumed.execute('propose_document_patch', { ...bad, changes }), /版本已变化/)
  await verifyRevision(resumed, project.id)
  const verified = getToolDraft(project.id)!
  assert.equal(verified.revision_task!.status, 'ready')
  commitToolDraft(project.id, verified.id, verified.version, script)
  assert.equal(script().artifacts!.length, 9); assert.ok(script().artifacts!.every(doc => !doc.content.includes('身份待定')))
  const state = await call<any>('GET', `/api/projects/${project.id}/script/director/tools-state`)
  assert.ok(state.document_health.every((doc: any) => doc.status === 'reviewed'))
  assert.throws(() => commitToolDraft(project.id, verified.id, verified.version, script), /草稿已变化/)
})

test('paragraph anchors disambiguate repeated text and return precise repair diagnostics without fuzzy replacement', async () => {
  const { project, script, makeTools } = await fixture()
  await artifact(project.id, 'characters', '甲：身份待定。\n\n乙：身份待定。')
  const doc = script().artifacts![0], tools = makeTools()
  const result = await tools.execute('read_documents', { document_ids: [doc.id] }) as { documents: Array<{ version: string; paragraphs: Array<{ id: string }> }> }
  const read = result.documents[0]
  await assert.rejects(tools.execute('propose_document_patch', { summary: '定位', changes: [{ document_id: doc.id, base_version: read.version, replacements: [{ find: '身分待定。', replace: '调查记者。', reason: '确定' }] }] }), (error: any) => {
    assert.equal(error.diagnostic.code, 'passage_not_found'); assert.equal(error.diagnostic.document_id, doc.id); assert.equal(error.diagnostic.item_index, 0); assert.match(error.diagnostic.repair, /逐字/); return true
  })
  await tools.execute('propose_document_patch', { summary: '只修改乙', changes: [{ document_id: doc.id, base_version: read.version, replacements: [{ paragraph_id: read.paragraphs[1].id, find: '身份待定。', replace: '调查记者。', reason: '乙负责调查' }] }] })
  assert.equal(getToolDraft(project.id)!.documents[0].content, '甲：身份待定。\n\n乙：调查记者。')
  const current = getToolDraft(project.id)!; discardToolDraft(project.id, current.id, current.version)
  run('UPDATE script_artifacts SET content=? WHERE id=?', '甲：身份待定。\n\n乙：医生。', doc.id)
  const updated = await readDoc(tools, doc.id)
  await assert.rejects(tools.execute('propose_document_patch', { summary: '旧定位', changes: [{ document_id: doc.id, base_version: updated.version, replacements: [{ paragraph_id: read.paragraphs[1].id, replace: '乙：记者。', reason: '测试旧定位' }] }] }), (error: any) => error.diagnostic.code === 'anchor_stale')
})

test('unified decisions remain proposals until atomic commit and are forgotten when discarded', async () => {
  const a = await fixture(); await artifact(a.project.id)
  const tools = a.makeTools(), started = await startRevision(tools)
  await tools.execute('manage_revision_task', { operation: 'update', task_id: started.task.id, version: started.version, decisions: [{ topic: '林晚职业', choice: '调查记者', reason: '推动调查主线' }] })
  assert.deepEqual(storyDecisions(a.project.id), [])
  await assert.rejects(tools.execute('record_story_decision', { topic: '林晚职业', content: '记者', basis: 'delegated_model', source_message_index: 0 }), /保留在草稿/)
  const discarded = getToolDraft(a.project.id)!; discardToolDraft(a.project.id, discarded.id, discarded.version)
  assert.deepEqual(storyDecisions(a.project.id), [])
  const second = a.makeTools(), task = await startRevision(second), source = a.script().artifacts![0], read = await readDoc(second, source.id)
  const decision = await second.execute('manage_revision_task', { operation: 'update', task_id: task.task.id, version: task.version, decisions: [{ topic: '林晚职业', choice: '调查记者', reason: '推动调查主线' }] }) as { version: string }
  await second.execute('propose_document_patch', { ...patch(source.id, read.version), task_id: task.task.id, draft_version: decision.version })
  await verifyRevision(second, a.project.id)
  const ready = getToolDraft(a.project.id)!; commitToolDraft(a.project.id, ready.id, ready.version, a.script)
  assert.equal(storyDecisions(a.project.id)[0].content, '调查记者'); assert.match(a.script().characters, /调查记者/)
})

test('final verification requires full current draft reads, distinguishes suspense and reopens after any document or decision edit', async () => {
  const { project, script, makeTools } = await fixture()
  await artifact(project.id, 'characters', '身份待定。真相留到第三集揭晓。'); await artifact(project.id, 'relationships', '关系已明确。')
  const tools = makeTools(), started = await startRevision(tools), doc = script().artifacts![0]
  const review = { task_id: started.task.id, version: started.version, documents: [{ document_id: doc.id, version: 'guess', conclusion: 'resolved', explanation: '核对', findings: [] }] }
  await assert.rejects(tools.execute('review_revision_batch', review), /读完有效草稿/)
  const read = await readEffective(tools, doc.id)
  await tools.execute('review_revision_batch', { ...review, documents: [{ ...review.documents[0], version: read.version, findings: [{ category: 'pending', quote: '身份待定', explanation: '作者职业还未确定' }] }] })
  let draft = getToolDraft(project.id)!
  assert.equal(draft.revision_task!.documents.find(item => item.id === doc.id)!.status, 'blocked')
  await assert.rejects(tools.execute('review_revision_batch', { ...review, version: draft.version, documents: [{ ...review.documents[0], version: read.version, findings: [{ category: 'intentional_suspense', quote: '模型编造的证据', explanation: '留悬念' }] }] }), /逐字/)
  await tools.execute('propose_document_patch', { summary: '确定职业', task_id: started.task.id, draft_version: draft.version, changes: [{ document_id: doc.id, base_version: read.version, replacements: [{ find: '身份待定。', replace: '身份为调查记者。', reason: '模型选择职业' }] }] })
  await verifyRevision(tools, project.id)
  draft = getToolDraft(project.id)!; assert.equal(draft.revision_task!.status, 'ready')
  const changed = editToolDraft(project.id, draft.id, { version: draft.version, documents: [{ id: doc.id, content: draft.documents[0].content + '\n新主线补充' }] })
  assert.equal(changed.revision_task!.status, 'in_progress')
  assert.ok(changed.revision_task!.documents.every(item => !['verified', 'unchanged'].includes(item.status)), 'cross-document consistency reviews bind the entire proposed state')
  await verifyRevision(tools, project.id)
  draft = getToolDraft(project.id)!
  run('INSERT INTO scripts (project_id, generation_options, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET generation_options=excluded.generation_options', project.id, JSON.stringify({ visual_style: '日漫', episode_count: 3 }), new Date().toISOString())
  assert.equal(getToolDraft(project.id)!.revision_task!.status, 'in_progress', 'confirmed project constraints changed after the prior semantic review')
  await verifyRevision(tools, project.id)
  draft = getToolDraft(project.id)!
  await tools.execute('manage_revision_task', { operation: 'update', task_id: started.task.id, version: draft.version, decisions: [{ topic: '真相揭晓', choice: '第三集揭晓', reason: '刻意保留的剧情悬念' }] })
  assert.equal(getToolDraft(project.id)!.revision_task!.status, 'in_progress')
  const finalRead = await readEffective(tools, doc.id), current = getToolDraft(project.id)!
  await tools.execute('review_revision_batch', { task_id: started.task.id, version: current.version, documents: [{ document_id: doc.id, version: finalRead.version, conclusion: 'resolved', explanation: '职业已明确，真相暂不对观众公开', findings: [{ category: 'intentional_suspense', quote: '真相留到第三集揭晓', explanation: '这是明确规划的悬念，不是作者待定' }] }] })
  assert.equal(getToolDraft(project.id)!.revision_task!.documents.find(item => item.id === doc.id)!.status, 'verified')
})

test('stale originals require reread and explicit rebase and cannot overwrite concurrent work', async () => {
  const { project, script, makeTools } = await fixture(); await artifact(project.id)
  const tools = makeTools(), started = await startRevision(tools), doc = script().artifacts![0], read = await readDoc(tools, doc.id)
  await tools.execute('propose_document_patch', { ...patch(doc.id, read.version), task_id: started.task.id, draft_version: started.version })
  await verifyRevision(tools, project.id)
  const ready = getToolDraft(project.id)!
  run('UPDATE script_artifacts SET content=? WHERE id=?', doc.content + '\n其他编辑者补充：日本沿海城市。', doc.id)
  assert.equal(getToolDraft(project.id)!.revision_task!.status, 'needs_attention')
  assert.throws(() => commitToolDraft(project.id, ready.id, ready.version, script), /尚未完成/)
  const latest = await readDoc(tools, doc.id)
  const input = { ...patch(doc.id, latest.version), task_id: started.task.id, draft_version: ready.version, changes: [{ ...patch(doc.id, latest.version).changes[0], rebase: true }] }
  await assert.rejects(tools.execute('propose_document_patch', input), /读完新原文与已有草稿/)
  await readEffective(tools, doc.id)
  await tools.execute('propose_document_patch', input)
  const rebased = getToolDraft(project.id)!
  assert.match(rebased.documents[0].content, /其他编辑者补充：日本沿海城市/)
  assert.match(rebased.documents[0].content, /调查记者/)
  assert.equal(script().artifacts![0].content, latest.content)
  await verifyRevision(tools, project.id)
  const final = getToolDraft(project.id)!; commitToolDraft(project.id, final.id, final.version, script)
  assert.match(script().characters, /其他编辑者补充：日本沿海城市/)
})

test('bulk tasks preserve project/scoped/review boundaries and checkpoints survive cancellation', async () => {
  const a = await fixture(), b = await fixture(); await artifact(a.project.id); await artifact(b.project.id)
  await artifact(a.project.id, 'props', '道具待定。')
  const doc = a.script().artifacts![0], other = b.script().artifacts![0]
  await assert.rejects(startRevision(a.makeTools(), [other.id]), /当前项目/)
  await assert.rejects(startRevision(a.makeTools({ action: { operation: 'review', document_ids: [doc.id] } })), /只讨论或评审/)
  await assert.rejects(startRevision(a.makeTools({ action: { operation: 'revise', document_ids: [doc.id] } })), /只处理/)
  const controller = new AbortController(), tools = a.makeTools({ signal: controller.signal }), started = await startRevision(tools, [doc.id])
  controller.abort()
  await assert.rejects(tools.execute('read_documents', { document_ids: [doc.id] }), /abort/i)
  const recovered = await a.makeTools().execute('manage_revision_task', { operation: 'read', task_id: started.task.id }) as { task: { documents: Array<{ id: string }> }; version: string }
  assert.equal(recovered.version, started.version); assert.deepEqual(recovered.task.documents.map(item => item.id), [doc.id])
  await assert.rejects(a.makeTools().execute('propose_document_patch', { ...patch(other.id, 'guess'), task_id: started.task.id, draft_version: started.version }), /当前项目/)
})

test('a save failure rolls back every document, proposed decision and review in the unified transaction', async () => {
  const { project, script, makeTools } = await fixture(); await artifact(project.id); await artifact(project.id, 'relationships')
  const tools = makeTools(), started = await startRevision(tools)
  const proposed = await tools.execute('manage_revision_task', { operation: 'update', task_id: started.task.id, version: started.version, decisions: [{ topic: '职业', choice: '记者', reason: '调查主线' }] }) as { version: string }
  const sources = script(), changes = []
  for (const doc of sources.artifacts!) { const read = await readDoc(tools, doc.id); changes.push(patch(doc.id, read.version).changes[0]) }
  await tools.execute('propose_document_patch', { summary: '统一修改', task_id: started.task.id, draft_version: proposed.version, changes })
  await verifyRevision(tools, project.id)
  const ready = getToolDraft(project.id)!, failingId = sources.artifacts![1].id
  run(`CREATE TEMP TRIGGER revision_save_failure BEFORE UPDATE ON script_artifacts WHEN NEW.id='${failingId}' BEGIN SELECT RAISE(ABORT, 'simulated save failure'); END`)
  try {
    assert.throws(() => commitToolDraft(project.id, ready.id, ready.version, script), /simulated save failure/)
    assert.deepEqual(script(), sources); assert.deepEqual(storyDecisions(project.id), [])
    assert.equal(all('SELECT * FROM script_document_reviews WHERE project_id=?', project.id).length, 0)
    assert.equal(getToolDraft(project.id)!.status, 'pending')
  } finally { run('DROP TRIGGER revision_save_failure') }
  commitToolDraft(project.id, ready.id, ready.version, script)
  assert.ok(script().artifacts!.every(doc => doc.content.includes('调查记者')))
})

test('answering or skipping a task question updates proposed choices without authorizing document writes', async () => {
  const { project, script, makeTools } = await fixture(); await artifact(project.id)
  const started = await startRevision(makeTools())
  const answer = makeTools({ discussionOnly: true, messages: [{ role: 'user', text: '这个职业跳过，你来确定。' }] })
  await answer.execute('manage_revision_task', { operation: 'update', task_id: started.task.id, version: started.version, decisions: [{ topic: '林晚职业', choice: '调查记者', reason: '创作者在任务问题中委托模型决定' }] })
  const draft = getToolDraft(project.id)!, doc = script().artifacts![0], read = await readDoc(answer, doc.id)
  assert.equal(draft.revision_task!.decisions[0].choice, '调查记者'); assert.equal(draft.documents.length, 0)
  assert.deepEqual(storyDecisions(project.id), [])
  await assert.rejects(answer.execute('propose_document_patch', { ...patch(doc.id, read.version), task_id: started.task.id, draft_version: draft.version }), /只讨论/)
  await assert.rejects(answer.execute('review_revision_batch', { task_id: started.task.id, version: draft.version, documents: [{ document_id: doc.id, version: 'guess', conclusion: 'resolved', explanation: '不应执行', findings: [] }] }), /只讨论/)
})

test('passage patches preserve unrelated text and reject ambiguous or overlapping changes', () => {
  assert.equal(replacePassages('前言\n林晚：身份待定。\n陈默：外科医生。\n尾声', patch('id', 'v').changes[0].replacements), '前言\n林晚：调查记者，追查失踪案。\n陈默：外科医生。\n尾声')
  assert.throws(() => replacePassages('待定，待定', [{ find: '待定', replace: '记者', reason: '确认' }]), /多次/)
  assert.throws(() => replacePassages('abcdef', [{ find: 'abc', replace: 'a', reason: 'a' }, { find: 'bcde', replace: 'b', reason: 'b' }]), /重叠/)
})

test('long document tails are readable and patches require the actual range and current version', async () => {
  const { project, script, makeTools } = await fixture(); await artifact(project.id)
  const id = script().artifacts![0].id, content = '已确定的其他人物。'.repeat(3500) + '\n林晚：身份待定。'
  run('UPDATE script_artifacts SET content=? WHERE id=?', content, id)
  const tools = makeTools(), first = await tools.execute('read_documents', { document_ids: [id], length: 20000 }) as { documents: Array<{ version: string; complete: boolean }> }
  assert.equal(first.documents[0].complete, false)
  await assert.rejects(tools.execute('propose_document_patch', patch(id, first.documents[0].version)), /尚未读取/)
  const tail = await tools.execute('read_documents', { document_ids: [id], offset: content.length - 20, length: 20 }) as { documents: Array<{ content: string; complete: boolean }> }
  assert.equal(tail.documents[0].complete, true); assert.match(tail.documents[0].content, /身份待定/)
  await tools.execute('propose_document_patch', patch(id, first.documents[0].version))
  assert.equal(getToolDraft(project.id)!.documents[0].content, content.replace('林晚：身份待定。', '林晚：调查记者，追查失踪案。'))
  assert.equal(script().artifacts![0].content, content)
})

test('project scope, review and question answers prohibit document writes', async () => {
  const a = await fixture(), b = await fixture(); await artifact(a.project.id); await artifact(b.project.id)
  const doc = a.script().artifacts![0], other = b.script().artifacts![0]
  await assert.rejects(a.makeTools().execute('read_documents', { document_ids: [other.id] }), /当前项目/)
  await assert.rejects(a.makeTools().execute('propose_document_patch', patch(doc.id, 'guess')), /先读取/)
  const review = a.makeTools({ action: { operation: 'review', document_ids: [doc.id] } }), read = await readDoc(review, doc.id)
  await assert.rejects(review.execute('propose_document_patch', patch(doc.id, read.version)), /只讨论或评审/)
  await assert.rejects(review.execute('record_story_decision', { topic: '身份', content: '记者', basis: 'creator_confirmed', source_message_index: 0 }), /只评审/)
  const discussion = a.makeTools({ discussionOnly: true }); await readDoc(discussion, doc.id)
  await assert.rejects(discussion.execute('propose_document_patch', patch(doc.id, read.version)), /只讨论/)
  await artifact(a.project.id, 'locations', '旧车站')
  const location = a.script().artifacts!.find(item => item.artifact_type === 'locations')!
  const scoped = a.makeTools({ action: { operation: 'revise', document_ids: [location.id] } }); await readDoc(scoped, doc.id)
  await assert.rejects(scoped.execute('propose_document_patch', patch(doc.id, read.version)), /只处理/)
})

test('draft edits persist, preserve originals, invalidate old approvals and save atomically', async () => {
  const { project, script, makeTools } = await fixture(); await artifact(project.id)
  const doc = script().artifacts![0], tools = makeTools(), read = await readDoc(tools, doc.id)
  await tools.execute('propose_document_patch', patch(doc.id, read.version)); const draft = getToolDraft(project.id)!
  await assert.rejects(tools.execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /本轮开始前/)
  const continued = makeTools(); await continued.execute('manage_document_draft', { operation: 'read' })
  await continued.execute('manage_document_draft', { operation: 'update', version: draft.version, changes: [{ document_id: doc.id, base_version: draft.version, replacements: [{ find: '调查记者', replace: '独立调查记者', reason: '细化身份' }] }] })
  const updated = getToolDraft(project.id)!; assert.notEqual(updated.version, draft.version); assert.equal(updated.documents[0].original_content, doc.content)
  assert.throws(() => commitToolDraft(project.id, draft.id, draft.version, script), /草稿已变化/)
  await assert.rejects(makeTools().execute('commit_document_draft', { draft_id: updated.id, version: updated.version }), /尚未明确批准/)
  await makeTools({ checkApproval: async () => true }).execute('commit_document_draft', { draft_id: updated.id, version: updated.version })
  assert.equal(getToolDraft(project.id), null); assert.equal(getToolDraft(project.id, updated.id)?.status, 'saved')
  assert.match(script().characters, /独立调查记者/); assert.match(script().characters, /陈默：外科医生/); assert.equal(script().characters, script().artifacts![0].content)
})

test('stale base rejects saves; discard and manual edits are versioned and project bound', async () => {
  const a = await fixture(), b = await fixture(); await artifact(a.project.id)
  const doc = a.script().artifacts![0], tools = a.makeTools(), read = await readDoc(tools, doc.id)
  await tools.execute('propose_document_patch', patch(doc.id, read.version)); const draft = getToolDraft(a.project.id)!
  assert.throws(() => editToolDraft(b.project.id, draft.id, { version: draft.version, documents: [{ id: doc.id, content: '越权' }] }), /找不到/)
  const edited = editToolDraft(a.project.id, draft.id, { version: draft.version, documents: [{ id: doc.id, content: draft.documents[0].content + '\n手动补充' }] })
  run('UPDATE script_artifacts SET content=? WHERE id=?', '其他窗口改过原文', doc.id)
  assert.throws(() => commitToolDraft(a.project.id, draft.id, edited.version, a.script), /已被修改/)
  assert.equal(a.script().artifacts![0].content, '其他窗口改过原文'); assert.equal(getToolDraft(a.project.id)?.status, 'pending')
  assert.throws(() => discardToolDraft(a.project.id, draft.id, draft.version), /草稿已变化/)
  discardToolDraft(a.project.id, draft.id, edited.version); assert.equal(getToolDraft(a.project.id), null)
})

test('durable decisions replace a topic, retain source and do not save documents', async () => {
  const { project, script, makeTools } = await fixture(), tools = makeTools({ messages: [{ role: 'assistant', text: '记者或律师？' }, { role: 'user', text: '这个职业跳过，你来定。' }] })
  const input = { topic: '林晚职业', content: '林晚是调查记者', basis: 'delegated_model', source_message_index: 1 }
  await tools.execute('record_story_decision', input); await tools.execute('record_story_decision', { ...input, content: '林晚是独立调查记者' })
  assert.equal(storyDecisions(project.id).length, 1); assert.equal(storyDecisions(project.id)[0].source_text, '这个职业跳过，你来定。'); assert.equal(script().characters, '')
  await assert.rejects(tools.execute('record_story_decision', { ...input, source_message_index: 0 }), /创作者消息/)
  const state = await makeTools().execute('get_creation_state', {}) as { decisions: unknown[] }; assert.equal(state.decisions.length, 1)
  const search = await tools.execute('search_project_content', { query: '调查记者' }) as { matches: Array<{ source: string }> }; assert.equal(search.matches[0].source, 'decision')
})

test('creation follows earliest missing stage without duplication or overwriting pending legacy drafts', async () => {
  const { project, script, makeTools } = await fixture(), input = { stage: 'characters', artifacts: stageArtifacts('characters', '林晚是记者'), scenes: [] }
  await assert.rejects(makeTools().execute('create_document_draft', input), /请先完成并保存/)
  await artifact(project.id, 'outline', '故事大纲')
  await assert.rejects(makeTools({ legacyPending: true }).execute('create_document_draft', input), /阶段草稿/)
  await makeTools().execute('create_document_draft', input); const draft = getToolDraft(project.id)!; assert.equal(draft.workflow?.stage, 'characters')
  commitToolDraft(project.id, draft.id, draft.version, script)
  await assert.rejects(makeTools({ workflow: 'characters' }).execute('create_document_draft', input), /已保存/)
})

test('new stage tools reject incomplete documents before persisting and save all nine after preview edits', async () => {
  const { project, script, makeTools } = await fixture()
  await artifact(project.id, 'props', '明日报纸')
  await artifact(project.id, 'episode_script', '已保存第1集正文')
  const before = script(), tools = makeTools()
  const state = await tools.execute('get_creation_state', {}) as { stage_content_requirements: string; missing_stage_documents: string[] }
  assert.deepEqual(state.missing_stage_documents, [...scriptStageArtifacts.outline])
  assert.match(state.stage_content_requirements, /伏笔与回收/)
  const artifacts = stageArtifacts('outline', '林晚追查明日报纸')
  await assert.rejects(tools.execute('create_document_draft', { stage: 'outline', artifacts: artifacts.slice(0, 1), scenes: [] }), /故事简述[\s\S]*伏笔与回收/)
  assert.equal(getToolDraft(project.id), null)
  assert.deepEqual(script(), before)
  await tools.execute('create_document_draft', { stage: 'outline', artifacts, scenes: [] })
  const generated = getToolDraft(project.id)!
  assert.equal(generated.documents.length, 9)
  assert.deepEqual(script(), before, 'generation never writes project documents')
  await assert.rejects(makeTools().execute('create_document_draft', { stage: 'outline', artifacts, scenes: [] }), /已有待确认草稿/)
  const edited = editToolDraft(project.id, generated.id, { version: generated.version, documents: [{ id: 'foreshadowing:0', content: '第1集埋设报纸缺角，第3集回收失踪线索。' }] })
  commitToolDraft(project.id, edited.id, edited.version, script)
  assert.equal(script().artifacts!.length, before.artifacts!.length + 9)
  assert.equal(script().artifacts!.find(doc => doc.artifact_type === 'foreshadowing')!.content, '第1集埋设报纸缺角，第3集回收失踪线索。')
  for (const doc of before.artifacts!) assert.deepEqual(script().artifacts!.find(item => item.id === doc.id), doc)
  assert.deepEqual(script().scenes, before.scenes)
})

test('partial stages can be completed with exact read originals while saved IDs and unrelated documents stay intact', async () => {
  const { project, script, makeTools } = await fixture()
  await artifact(project.id, 'outline', '\n已有主线原文\n')
  await artifact(project.id, 'characters', '已有全剧人物')
  const before = script(), original = before.artifacts!.find(doc => doc.artifact_type === 'outline')!
  const tools = makeTools({ workflow: 'outline', operation: 'supplement', stage: directorStageContext(script(), { explicit: { stage: 'outline', episode_number: 0 } }) })
  const artifacts = stageArtifacts('outline', '补齐主线设计').map(doc => doc.artifact_type === 'outline' ? { artifact_type: doc.artifact_type, title: original.title, content: original.content } : doc)
  await assert.rejects(tools.execute('create_document_draft', { stage: 'outline', artifacts, scenes: [] }), /读完/)
  await readDoc(tools, original.id)
  await assert.rejects(tools.execute('create_document_draft', { stage: 'outline', artifacts: artifacts.map(doc => doc.artifact_type === 'outline' ? { ...doc, content: '覆盖已有主线' } : doc), scenes: [] }), /原样保留/)
  assert.equal(getToolDraft(project.id), null)
  await tools.execute('create_document_draft', { stage: 'outline', artifacts, scenes: [] })
  const generated = getToolDraft(project.id)!
  assert.equal(generated.documents.find(doc => doc.artifact_type === 'outline')!.id, original.id)
  commitToolDraft(project.id, generated.id, generated.version, script)
  assert.equal(script().artifacts!.length, 10)
  for (const doc of before.artifacts!) assert.deepEqual(script().artifacts!.find(item => item.id === doc.id), doc)
})

test('partial stage completion rejects a stale original atomically and retains historical incomplete drafts', async () => {
  const { project, script, makeTools } = await fixture()
  await artifact(project.id, 'characters', '人物旧原文')
  const original = script().artifacts![0]
  const tools = makeTools({ workflow: 'characters', operation: 'supplement', stage: directorStageContext(script(), { explicit: { stage: 'characters', episode_number: 0 } }) })
  await readDoc(tools, original.id)
  await tools.execute('create_document_draft', { stage: 'characters', artifacts: [
    { artifact_type: 'characters', title: original.title, content: original.content },
    { artifact_type: 'relationships', title: '人物关系', content: '林晚与陈默互相依赖。' },
  ], scenes: [] })
  const draft = getToolDraft(project.id)!
  run('UPDATE script_artifacts SET content=? WHERE id=?', '另一窗口修改后的原文', original.id)
  assert.throws(() => commitToolDraft(project.id, draft.id, draft.version, script), /已被修改/)
  assert.equal(script().artifacts!.length, 1, 'no partial relationship write')
  assert.equal(script().artifacts![0].content, '另一窗口修改后的原文')
  discardToolDraft(project.id, draft.id, draft.version)
  // An already persisted draft from the old contract must still be editable.
  const legacy = { ...draft, id: 'historical-draft', version: 'historical-version', status: 'pending', documents: [{ ...draft.documents[0], version: '', original_content: '', content: '旧人物小传' }], workflow: { stage: 'characters', scope: 'project', episode_number: 0, artifacts: [{ artifact_type: 'characters', title: '旧人物草稿', content: '旧人物小传' }], scenes: [] } }
  run('INSERT INTO script_tool_drafts (id, project_id, version, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', legacy.id, project.id, legacy.version, 'pending', JSON.stringify(legacy), 'old', 'old')
  const edited = editToolDraft(project.id, legacy.id, { version: legacy.version, documents: [{ id: original.id, content: '手动完善的旧人物小传' }] })
  assert.equal(edited.workflow!.artifacts.length, 1)
  assert.equal(edited.documents[0].content, '手动完善的旧人物小传')
})

test('stage generation fills saved empty placeholders without changing their IDs or losing a long existing document', async () => {
  const { project, script, makeTools } = await fixture()
  const content = '已确认的故事事实。'.repeat(2400)
  for (const type of scriptStageArtifacts.outline) await artifact(project.id, type, type === 'outline' ? content : '')
  const before = script(), original = before.artifacts!.find(doc => doc.artifact_type === 'outline')!
  const tools = makeTools({ workflow: 'outline', operation: 'supplement', stage: directorStageContext(script(), { explicit: { stage: 'outline', episode_number: 0 } }) })
  for (let offset = 0; offset < content.length; offset += 10000) await tools.execute('read_documents', { document_ids: [original.id], offset, length: 10000 })
  await tools.execute('create_document_draft', { stage: 'outline', artifacts: stageArtifacts('outline', '补齐完整设计').map(doc => doc.artifact_type === 'outline' ? { ...doc, title: original.title, content } : doc), scenes: [] })
  const draft = getToolDraft(project.id)!
  commitToolDraft(project.id, draft.id, draft.version, script)
  assert.equal(script().artifacts!.length, 9)
  for (const doc of before.artifacts!) {
    const saved = script().artifacts!.find(item => item.artifact_type === doc.artifact_type)!
    assert.equal(saved.id, doc.id)
    assert.ok(saved.content.trim())
  }
  assert.deepEqual(script().artifacts!.find(item => item.id === original.id), original)
})

test('episode patches synchronize scene fields without replacing scene or shot IDs', async () => {
  const { project, script, makeTools } = await fixture()
  await call('PUT', `/api/projects/${project.id}/script`, { outline: '', characters: '', scenes: [{ episode_number: 1, heading: '车站', characters: '林晚', action: '林晚等待。', dialogue: '别走。', duration: 8 }] })
  await artifact(project.id, 'episode_script', '林晚等待。她说：别走。')
  const scene = script().scenes[0], timestamp = new Date().toISOString()
  run('INSERT INTO shots (id, project_id, position, title, source_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'linked-shot', project.id, 0, '车站镜头', scene.id, timestamp)
  const doc = script().artifacts![0], tools = makeTools(), read = await readDoc(tools, doc.id)
  const input = { summary: '修改台词', changes: [{ document_id: doc.id, base_version: read.version, replacements: [{ find: '别走。', replace: '等等我。', reason: '更明确的挽留' }] }] }
  await assert.rejects(tools.execute('propose_document_patch', input), /同步对应分场/)
  await tools.execute('propose_document_patch', { ...input, scene_changes: [{ scene_id: scene.id, base_version: read.scenes![0].version, changes: { dialogue: '等等我。' } }] })
  const draft = getToolDraft(project.id)!; commitToolDraft(project.id, draft.id, draft.version, script)
  assert.equal(script().scenes[0].id, scene.id); assert.equal(script().scenes[0].action, scene.action); assert.equal(script().scenes[0].dialogue, '等等我。')
  assert.equal(one<{ source_scene_id: string }>('SELECT source_scene_id FROM shots WHERE id=?', 'linked-shot')!.source_scene_id, scene.id); assert.match(script().artifacts![0].content, /等等我/)
  const stage = toolConversationStage(project.id, script(), directorStageContext(script()), { operation: 'revise', document_ids: [doc.id] })
  assert.equal(stage.stage, 'episode'); assert.equal(stage.episode_number, 1); assert.equal(stage.mode, 'explicit')
})

test('unified episode review reads all effective scenes and real downstream references, reopening when references change', async () => {
  const { project, script, makeTools } = await fixture()
  await call('PUT', `/api/projects/${project.id}/script`, { outline: '', characters: '', scenes: [{ episode_number: 1, heading: '车站', characters: '林晚', action: '林晚等待。', dialogue: '别走。', duration: 8 }, { episode_number: 1, heading: '出口', action: '救援完成。', duration: 5 }] })
  await artifact(project.id, 'episode_script', '林晚等待。她说：别走。随后救援完成。')
  const doc = script().artifacts![0], scene = script().scenes[0], tools = makeTools(), started = await startRevision(tools)
  run('INSERT INTO shots (id, project_id, position, title, source_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'revision-linked-shot', project.id, 0, '林晚挽留', scene.id, new Date().toISOString())
  const read = await readDoc(tools, doc.id)
  await tools.execute('propose_document_patch', { summary: '修改台词并同步分场', task_id: started.task.id, draft_version: started.version,
    changes: [{ document_id: doc.id, base_version: read.version, replacements: [{ find: '别走。', replace: '等等我。', reason: '明确挽留' }] }], scene_changes: [{ scene_id: scene.id, base_version: read.scenes![0].version, changes: { dialogue: '等等我。' } }] })
  const partialRead = await readEffective(tools, doc.id, { scene_limit: 1 }), current = getToolDraft(project.id)!
  const review = { task_id: started.task.id, version: current.version, documents: [{ document_id: doc.id, version: partialRead.version, conclusion: 'resolved', explanation: '正文与分场同步', findings: [] }] }
  await assert.rejects(tools.execute('review_revision_batch', review), /全部有效分场/)
  await readEffective(tools, doc.id, { scene_offset: 1, scene_limit: 1 })
  await tools.execute('review_revision_batch', review)
  let draft = getToolDraft(project.id)!; assert.equal(draft.revision_task!.status, 'in_progress')
  const refs = await tools.execute('manage_revision_task', { operation: 'read', task_id: started.task.id }) as { version: string; references: Array<{ kind: string; id: string; version: string }> }
  await tools.execute('review_revision_batch', { task_id: started.task.id, version: refs.version, references: refs.references.map(({ kind, id, version }) => ({ kind, id, version, conclusion: 'needs_change', explanation: '镜头台词需要同步' })) })
  assert.equal(getToolDraft(project.id)!.revision_task!.status, 'needs_attention')
  draft = getToolDraft(project.id)!
  assert.throws(() => commitToolDraft(project.id, draft.id, draft.version, script), /尚未完成/)
  run('UPDATE shots SET prompt=? WHERE id=?', '林晚挽留同伴：等等我。', 'revision-linked-shot')
  const updated = await tools.execute('manage_revision_task', { operation: 'read' }) as typeof refs
  await assert.rejects(tools.execute('review_revision_batch', { task_id: started.task.id, version: updated.version, references: refs.references.map(({ kind, id, version }) => ({ kind, id, version, conclusion: 'consistent', explanation: '旧版本应失效' })) }), /版本已变化/)
  await tools.execute('review_revision_batch', { task_id: started.task.id, version: updated.version, references: updated.references.map(({ kind, id, version }) => ({ kind, id, version, conclusion: 'consistent', explanation: '已核对最新镜头，挽留台词与正文一致' })) })
  draft = getToolDraft(project.id)!; assert.equal(draft.revision_task!.status, 'ready')
  commitToolDraft(project.id, draft.id, draft.version, script)
  assert.equal(script().scenes[0].id, scene.id); assert.equal(script().scenes[0].dialogue, '等等我。')
  assert.equal(one<{ source_scene_id: string }>('SELECT source_scene_id FROM shots WHERE id=?', 'revision-linked-shot')!.source_scene_id, scene.id)
})

test('native recoverable failures are repaired after an early final text without duplicating protocol outputs', async t => {
  for (const protocol of ['chat_completions', 'responses']) await t.test(protocol, async t => {
    const { project, script } = await fixture(); await artifact(project.id)
    const doc = script().artifacts![0], model = await nativeModel(protocol); let turn = 0, sourceVersion = ''
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
      const body = JSON.parse(String(init.body)); requests.push(body); turn++
      const history = body.messages || body.input
      const output = [...history].reverse().find((item: any) => item.role === 'tool' || item.type === 'function_call_output')
      if (turn === 3) sourceVersion = JSON.parse(output.content || output.output).result.documents[0].version
      if (turn === 4) assert.equal(JSON.parse(output.content || output.output).diagnostic.code, 'passage_not_found')
      if (turn === 5) {
        assert.match(history.at(-1).content, /程序执行检查/)
        assert.equal(history.filter((item: any) => item.tool_call_id === 'repair-3' || item.call_id === 'repair-3' && item.type === 'function_call_output').length, 1)
      }
      const operation = turn === 1 ? ['get_creation_state', {}] : turn === 2 || turn === 5 ? ['read_documents', { document_ids: [doc.id] }]
        : turn === 3 ? ['propose_document_patch', { ...patch(doc.id, sourceVersion), changes: [{ ...patch(doc.id, sourceVersion).changes[0], replacements: [{ find: '不精确的原文', replace: '记者', reason: '确定' }] }] }]
        : turn === 6 ? ['propose_document_patch', patch(doc.id, sourceVersion)] : undefined
      if (protocol === 'responses') return Response.json({ status: 'completed', output: operation ? [{ type: 'function_call', call_id: `repair-${turn}`, name: operation[0], arguments: JSON.stringify(operation[1]) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn === 4 ? '失败了，下次重新定位。' : '草稿已准备。' }] }] })
      return Response.json({ choices: [{ message: { role: 'assistant', content: operation ? '' : turn === 4 ? '失败了，下次重新定位。' : '草稿已准备。', ...(operation ? { tool_calls: [{ id: `repair-${turn}`, type: 'function', function: { name: operation[0], arguments: JSON.stringify(operation[1]) } }] } : {}) }, finish_reason: operation ? 'tool_calls' : 'stop' }] })
    })
    const result = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '补齐林晚的待定职业' }] })
    assert.equal(turn, 7); assert.equal(result.tool_draft.status, 'pending'); assert.equal(result.execution_outcome, undefined)
    assert.match(result.tool_draft.documents[0].content, /调查记者/); assert.equal(script().artifacts![0].content, doc.content)
    assert.equal(result.activity.filter((event: any) => event.label === '继续修复未完成项').length, 1)
  })
})

test('unrepaired unified work and provider interruption return honest partial checkpoints', async t => {
  for (const failure of ['early_final', 'network']) await t.test(failure, async t => {
    const { project, script } = await fixture(); await artifact(project.id)
    const model = await nativeModel(); let turn = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
      turn++
      if (turn === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'start-task', type: 'function', function: { name: 'manage_revision_task', arguments: JSON.stringify({ operation: 'start', scope: 'all_documents', summary: '补齐所有设定', source_message_index: 0 }) } }] }, finish_reason: 'tool_calls' }] })
      if (failure === 'network') throw new Error('mock provider interrupted')
      return Response.json({ choices: [{ message: { role: 'assistant', content: '所有设定都已完成并保存。' }, finish_reason: 'stop' }] })
    })
    const result = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '所有设定的待定项都由你补齐' }] })
    assert.equal(turn, failure === 'network' ? 2 : 4)
    assert.equal(result.execution_outcome.kind, 'partial'); assert.match(result.reply, /任务尚未完成/); assert.doesNotMatch(result.reply, /所有设定都已完成并保存/)
    assert.equal(getToolDraft(project.id)!.id, result.tool_draft.id); assert.equal(result.tool_draft.revision_task.documents[0].status, 'pending')
    assert.match(script().artifacts![0].content, /身份待定/)
  })
})

test('argument count diagnostics identify actual count and repeated identical failures stop boundedly', async t => {
  const { project } = await fixture(), model = await nativeModel(); let turn = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body)); turn++
    if (turn === 2) {
      const first = body.messages.filter((item: any) => item.role === 'tool').map((item: any) => JSON.parse(item.content))
      assert.equal(first[0].diagnostic.limit, 8); assert.equal(first[0].diagnostic.actual, 9); assert.equal(first[0].diagnostic.path, 'document_ids')
      assert.equal(first[1].diagnostic.code, 'repeated_failed_call')
      return Response.json({ choices: [{ message: { role: 'assistant', content: '已完成读取。' }, finish_reason: 'stop' }] })
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [1, 2].map(index => ({ id: `too-many-${index}`, type: 'function', function: { name: 'read_documents', arguments: JSON.stringify({ document_ids: Array.from({ length: 9 }, (_, index) => `missing-${index}`) }) } })) }, finish_reason: 'tool_calls' }] })
  })
  const result = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '读取项目' }] })
  assert.equal(turn, 2); assert.equal(result.execution_outcome.kind, 'failed'); assert.doesNotMatch(result.reply, /^已完成读取/)
})

test('new persistent tables cascade when project is deleted', async () => {
  const { project, makeTools } = await fixture(), tools = makeTools()
  await tools.execute('record_story_decision', { topic: '身份', content: '记者', basis: 'creator_confirmed', source_message_index: 0 })
  await tools.execute('propose_next_step', { stage: 'outline', summary: '方向明确', basis: '创作者提供故事', source_message_indexes: [0] })
  await tools.execute('create_document_draft', { stage: 'outline', artifacts: stageArtifacts('outline', '故事主线'), scenes: [] })
  await call('DELETE', `/api/projects/${project.id}`); assert.equal(getToolDraft(project.id), null); assert.deepEqual(storyDecisions(project.id), [])
  assert.equal(one('SELECT * FROM script_workflow_proposals WHERE project_id=?', project.id), undefined)
})

async function nativeModel(protocol = 'chat_completions') {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '原生工具测试', base_url: 'https://native.invalid/v1' })
  return call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '工具模型', remote_id: 'native', modality: 'text', protocol, settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions', request_template: { model: '{{model}}', ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) }, text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content' } })
}
test('all creation modes send the same complete role guidance in native and compatible JSON/SSE while retaining tools and Skills', async t => {
  const { project, script } = await fixture()
  const before = script()
  const skill = installSkillBundle({ repo: 'test/mode-rule', path: 'SKILL.md', name: 'mode-rule', description: '模式回归规则', license: null, revision: 'b'.repeat(40), tool_requirements: [], suggested_stages: ['script'], url: 'https://github.com/test/mode-rule', files: [{ path: 'SKILL.md', content: '---\nname: mode-rule\ndescription: 模式回归规则\n---\n模式回归：讨论建议必须依据已确认项目资料。' }] })
  configureSkill(skill.id, true, ['script']); t.after(() => configureSkill(skill.id, false, ['script']))
  const profiles = [
    { mode: 'all', label: '全能创作', focus: /兼顾故事构思、角色塑造、分场剧本和可制作性/ },
    { mode: 'script', label: '剧本创编', focus: /以编剧视角讨论故事结构、人物动机、戏剧冲突、对白和分场节奏/ },
    { mode: 'director', label: '导演执导', focus: /以导演视角讨论戏剧节奏、场面调度、镜头可视化、动作连续性和情绪表达/ },
  ]
  const blocks = new Map<string, string>()
  let registeredTools: string[] | undefined
  for (const protocol of ['chat_completions', 'responses']) {
    const model = await nativeModel(protocol)
    for (const profile of profiles) for (const native of [true, false]) for (const stream of [false, true]) {
      await t.test(`${profile.mode} ${protocol} ${native ? 'native' : 'compatible'} ${stream ? 'SSE' : 'JSON'}`, async t => {
        let calls = 0, modelTurns = 0
        const reply = `已按${profile.label}讨论当前故事方向。`
        const textResponse = (text: string) => protocol === 'responses'
          ? Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text })
          : Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
          const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
          calls++
          const body = JSON.parse(String(init.body))
          const prompt = typeof body.input === 'string' ? body.input : (body.messages || body.input)[0].content as string
          if (prompt.includes('本次独立调用只理解创作者意图')) return textResponse(JSON.stringify({ action: 'discuss', settings_patch: {} }))
          modelTurns++
          assert.match(prompt, profile.focus); assert.ok(prompt.includes(`当前创作模式：${profile.label}（${profile.mode}）`))
          assert.match(prompt, /不因切换模式自行跳阶段、创建或保存文档/)
          assert.match(prompt, /模式回归：讨论建议必须依据已确认项目资料/)
          const block = prompt.match(/【创作模式要求】[\s\S]*?【创作模式要求结束】/g)!
          assert.equal(block.length, 1)
          if (blocks.has(profile.mode)) assert.equal(block[0], blocks.get(profile.mode))
          else blocks.set(profile.mode, block[0])
          if (!native) return textResponse(reply)
          const names = body.tools.map((tool: any) => tool.function?.name || tool.name).sort()
          assert.ok(names.includes('read_documents')); assert.ok(names.includes('propose_shot_plan'))
          if (registeredTools) assert.deepEqual(names, registeredTools)
          else registeredTools = names
          if (modelTurns === 1) return protocol === 'responses'
            ? Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'mode-state', name: 'get_creation_state', arguments: '{}' }] })
            : Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'mode-state', type: 'function', function: { name: 'get_creation_state', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
          const output = (body.messages || body.input).at(-1)
          assert.equal(JSON.parse(output.content || output.output).result.project.id, project.id)
          return textResponse(reply)
        })
        const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${stream ? '/stream' : ''}`, payload: { model_id: model.id, mode: profile.mode, use_tools: native, messages: [{ role: 'user', text: '讨论当前故事方向，暂不生成文档。' }] } })
        assert.equal(response.statusCode, 200, response.body)
        const result = stream ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
        assert.equal(result?.reply, reply, response.body)
        assert.equal(result.stage_context.stage, 'outline')
        assert.equal(calls, native ? 3 : 2); assert.equal(modelTurns, native ? 2 : 1)
        assert.deepEqual(script(), before)
      })
    }
  }
})

test('native SSE read-patch loop preserves Skills, displays progress and returns a pending draft', async t => {
  const { project, script } = await fixture(); await artifact(project.id)
  const skill = installSkillBundle({ repo: 'test/script', path: 'SKILL.md', name: 'script-rule', description: '编剧规则', license: null, revision: 'a'.repeat(40), tool_requirements: [], suggested_stages: ['script'], url: 'https://github.com/test/script', files: [{ path: 'SKILL.md', content: '---\nname: script-rule\ndescription: 编剧规则\n---\n每段对白明确人物动机。' }] })
  configureSkill(skill.id, true, ['script'])
  const model = await nativeModel(), doc = script().artifacts![0]; let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body)); calls++; assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'read_visual_profiles')); assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'read_documents')); assert.match(body.messages[0].content, /每段对白明确人物动机/)
    const output = body.messages.at(-1); let fn: string, args: unknown
    if (calls === 1) { fn = 'get_creation_state'; args = {} }
    else if (calls === 2) { assert.equal(JSON.parse(output.content).result.documents[0].id, doc.id); fn = 'read_documents'; args = { document_ids: [doc.id] } }
    else if (calls === 3) { fn = 'propose_document_patch'; args = patch(doc.id, JSON.parse(output.content).result.documents[0].version) }
    else { assert.equal(JSON.parse(output.content).result.saved, false); return Response.json({ choices: [{ message: { content: '已提出修改，请确认保存。' }, finish_reason: 'stop' }] }) }
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: `native-${calls}`, type: 'function', function: { name: fn, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { model_id: model.id, mode: 'script', use_tools: true, document_action: { operation: 'revise', document_ids: [doc.id] }, messages: [{ role: 'user', text: '请把林晚设为调查记者' }] } })
  assert.equal(response.statusCode, 200, response.body)
  const events = response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))), done = events.find(event => event.type === 'done')
  assert.equal(done.tool_draft.kind, 'patch'); assert.equal(done.stage_context.stage, 'characters'); assert.equal(done.stage_context.mode, 'review'); assert.equal(done.reply, '已提出修改，请确认保存。'); assert.equal(events.filter(event => event.type === 'process').length, 3)
  assert.match(script().artifacts![0].content, /身份待定/)
  const state = await call<{ draft: ScriptToolDraft }>('GET', `/api/projects/${project.id}/script/director/tools-state`); assert.equal(state.draft.id, done.tool_draft.id)
  const denied = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/tool-drafts/${state.draft.id}/commit`, payload: { version: state.draft.version, approved: false } }); assert.equal(denied.statusCode, 422)
  await call('POST', `/api/projects/${project.id}/script/director/tool-drafts/${state.draft.id}/commit`, { version: state.draft.version, approved: true }); assert.match(script().characters, /调查记者/)
})

test('ask_creator returns a selectable interaction at the existing document stage without extra classification', async t => {
  const { project, script } = await fixture(); await artifact(project.id); const model = await nativeModel('responses'); let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply; requests++; return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'ask-1', name: 'ask_creator', arguments: JSON.stringify({ intro: '确定林晚的职业', request: { type: 'choice_request', status: 'pending', question: '林晚是什么记者？', options: [{ id: 'independent', title: '独立记者', text: '林晚是独立调查记者。' }, { id: 'newspaper', title: '报社记者', text: '林晚在报社任职。' }] } }) }] }) })
  const result = await call<{ reply: string; classification: { type: string; interaction: { stage: string } }; stage_context: { mode: string; stage: string } }>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, document_action: { operation: 'revise', document_ids: [script().artifacts![0].id] }, messages: [{ role: 'user', text: '补齐林晚职业' }] })
  assert.equal(requests, 1); assert.equal(result.classification.type, 'choice_request'); assert.equal(result.classification.interaction.stage, 'characters'); assert.equal(result.stage_context.stage, 'characters'); assert.equal(result.stage_context.mode, 'explicit'); assert.equal(JSON.parse(result.reply).kind, 'choices'); assert.equal(getToolDraft(project.id), null)
})

test('confirmed episode count and runtime update creation settings while leaving documents intact', async () => {
  const { project, script, makeTools } = await fixture()
  const tools = makeTools({ messages: [{ role: 'user', text: '全剧5集，每集60秒。' }] })
  await tools.execute('record_story_decision', { topic: '集数与时长', content: '全剧5集，每集60秒。', basis: 'creator_confirmed', source_message_index: 0, settings_patch: { episode_count: 5, episode_duration: 60 } })
  assert.equal(script().generation_options.episode_count, 5); assert.equal(script().generation_options.episode_duration, 60)
  assert.equal(script().outline, ''); assert.equal(script().characters, '')
  assert.equal(tools.result().generation_options?.episode_count, 5)
  assert.throws(() => toolConversationStage(project.id, script(), directorStageContext(script()), { operation: 'review', document_ids: ['not-this-project'] }), /当前项目/)
})

test('native save approval is independently checked with the selected model and cannot be inferred from continue', async t => {
  const { project, script, makeTools } = await fixture(); await artifact(project.id)
  const document = script().artifacts![0], tools = makeTools(), read = await readDoc(tools, document.id)
  await tools.execute('propose_document_patch', patch(document.id, read.version))
  const draft = getToolDraft(project.id)!, model = await nativeModel(); let approved = false, approvalChecks = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body))
    assert.equal(body.model, 'native')
    if (!body.tools) { approvalChecks++; assert.match(body.messages[0].content, /最后一条消息是否明确批准保存/); return Response.json({ choices: [{ message: { content: JSON.stringify({ approved }) } }] }) }
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content); assert.equal(result.ok, approved)
      return Response.json({ choices: [{ message: { content: approved ? '已保存' : '请先确认草稿' }, finish_reason: 'stop' }] })
    }
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'commit-call', type: 'function', function: { name: 'commit_document_draft', arguments: JSON.stringify({ draft_id: draft.id, version: draft.version }) } }] }, finish_reason: 'tool_calls' }] })
  })
  const payload = (text: string) => ({ model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text }] })
  await call('POST', `/api/projects/${project.id}/script/director/chat`, payload('继续'))
  assert.match(script().artifacts![0].content, /身份待定/); assert.equal(getToolDraft(project.id)?.status, 'pending')
  approved = true
  await call('POST', `/api/projects/${project.id}/script/director/chat`, payload('确认保存这份人物修订草稿'))
  assert.equal(approvalChecks, 2); assert.equal(getToolDraft(project.id), null); assert.match(script().characters, /调查记者/)
})

test('scoped revision cannot create, discard or save a draft for another selected document', async () => {
  const { project, script, makeTools } = await fixture(); await artifact(project.id)
  const doc = script().artifacts![0], tools = makeTools(), read = await readDoc(tools, doc.id)
  await tools.execute('propose_document_patch', patch(doc.id, read.version)); const draft = getToolDraft(project.id)!
  await artifact(project.id, 'locations', '车站')
  const location = script().artifacts!.find(item => item.artifact_type === 'locations')!, scoped = makeTools({ action: { operation: 'revise', document_ids: [location.id] }, checkApproval: async () => true })
  await assert.rejects(scoped.execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /只处理/)
  await assert.rejects(scoped.execute('manage_document_draft', { operation: 'discard', version: draft.version }), /只处理/)
  await assert.rejects(scoped.execute('create_document_draft', { stage: 'props', artifacts: [{ artifact_type: 'props', title: '道具', content: '怀表' }], scenes: [] }), /已有文档修订/)
})

test('draft status can be recovered after a lost response and remains bound to the project', async () => {
  const a = await fixture(), b = await fixture(); await artifact(a.project.id)
  const doc = a.script().artifacts![0], tools = a.makeTools(), read = await readDoc(tools, doc.id)
  await tools.execute('propose_document_patch', patch(doc.id, read.version)); const draft = getToolDraft(a.project.id)!
  commitToolDraft(a.project.id, draft.id, draft.version, a.script)
  const saved = await call<ScriptToolDraft>('GET', `/api/projects/${a.project.id}/script/director/tool-drafts/${draft.id}`)
  assert.equal(saved.status, 'saved')
  const other = await app.inject({ method: 'GET', url: `/api/projects/${b.project.id}/script/director/tool-drafts/${draft.id}` })
  assert.equal(other.statusCode, 404)
})

test('execution traces retain repeated calls, native errors, public model text and complete lifecycle in SSE and JSON', async t => {
  const { project, script } = await fixture(); await artifact(project.id)
  const model = await nativeModel(), doc = script().artifacts![0]
  run('UPDATE script_artifacts SET content=? WHERE id=?', '林晚：调查记者，追查失踪案件。'.repeat(500), doc.id)
  let turn = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    turn++
    if (turn === 10) return Response.json({ choices: [{ message: { content: '<think>private chain of thought</think>已阅读人物资料。', reasoning_content: 'private field' }, finish_reason: 'stop' }] })
    const name = turn === 1 ? 'get_creation_state' : 'read_documents'
    const args = turn === 1 ? {} : { document_ids: [doc.id], offset: turn - 2, length: 1 }
    const tool_calls = [{ id: `trace-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    if (turn === 1) tool_calls.push(
      { id: 'trace-failed-read', type: 'function', function: { name: 'read_documents', arguments: JSON.stringify({ document_ids: ['missing-document'] }) } },
      { id: 'trace-first-read', type: 'function', function: { name: 'read_documents', arguments: JSON.stringify({ document_ids: [doc.id], length: 5000 }) } },
    )
    return Response.json({ choices: [{ message: { content: null, tool_calls }, finish_reason: 'tool_calls' }] })
  })
  const payload = { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '请阅读人物资料' }] }
  const stream = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload })
  const events = stream.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  const updates = events.filter(event => event.type === 'activity').map(event => event.activity)
  const done = events.find(event => event.type === 'done'), tools = done.activity.filter((item: any) => item.kind === 'tool')
  assert.equal(tools.length, 11, 'all repeated document reads survive beyond the former eight-entry limit')
  assert.equal(new Set(tools.map((item: any) => item.id)).size, 11)
  assert.equal(tools[1].status, 'failed'); assert.match(tools[1].output, /不存在|当前项目/)
  assert.equal(tools[2].status, 'succeeded'); assert.match(tools[2].input, /document_ids/); assert.match(tools[2].output, /content/)
  assert.equal(tools[2].output_truncated, true)
  assert.deepEqual(tools[2].targets, [{ kind: 'document', id: doc.id, title: doc.title }], 'source labels remain complete even when the public JSON preview is truncated')
  const { scriptActivitiesSchema } = await import('../src/modules/script/script-activity.js')
  assert.equal(scriptActivitiesSchema.safeParse(done.activity).success, true)
  for (const event of done.activity) {
    assert.ok(event.status !== 'running'); assert.ok(event.duration_ms >= 0)
    const lifecycle = updates.filter(item => item.id === event.id)
    assert.equal(lifecycle.length, 2); assert.equal(lifecycle[0].status, 'running'); assert.equal(lifecycle[1].status, event.status)
  }
  assert.equal(done.reply, '已阅读人物资料。')
  assert.ok(!JSON.stringify(done.activity).includes('private chain'))
  assert.ok(!JSON.stringify(done.activity).includes('private field'))
  const skill = done.activity.find((item: any) => item.kind === 'skill')
  assert.equal(skill.name, 'script-rule'); assert.deepEqual(skill.files, ['SKILL.md']); assert.equal(skill.revision, 'a'.repeat(40))
  turn = 0
  const result = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, payload)
  assert.equal(result.activity.filter((item: any) => item.kind === 'tool').length, 11, 'non-stream fallback carries the same trace')
})

test('provider failure is recorded as a failed model operation rather than a successful tool execution', async t => {
  const { project } = await fixture(), model = await nativeModel()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply; throw new Error('provider unavailable') })
  const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '讨论故事方向' }] } })
  const events = result.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  const modelEvents = events.filter(event => event.type === 'activity' && event.activity.kind === 'model')
  assert.equal(modelEvents[0].activity.status, 'running'); assert.equal(modelEvents[1].activity.status, 'failed')
  assert.match(modelEvents[1].activity.summary, /provider unavailable/)
  assert.equal(events.filter(event => event.type === 'activity' && event.activity.kind === 'tool').length, 0)
  assert.ok(events.some(event => event.type === 'error'))
})

test('server heartbeat keeps a slow director connection visibly alive without changing dialogue text', async t => {
  const { project } = await fixture(), model = await nativeModel()
  t.mock.timers.enable({ apis: ['setInterval'] })
  let entered!: () => void, finish!: (response: Response) => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => discussionIntent(init) || new Promise<Response>(resolve => { finish = resolve; entered() }))
  const pending = app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '讨论创作方向' }] } })
  await waiting
  t.mock.timers.tick(15_000)
  finish(Response.json({ choices: [{ message: { content: '先确定故事方向。' }, finish_reason: 'stop' }] }))
  const response = await pending
  const events = response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.equal(events.filter(event => event.type === 'heartbeat').length, 1)
  assert.equal(events.find(event => event.type === 'heartbeat').text, undefined)
  assert.equal(events.find(event => event.type === 'done').reply, '先确定故事方向。')
})

test('whole-dialogue timeout fails an active native model operation and closes the stream', async t => {
  const { project } = await fixture(), model = await nativeModel()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let first = true, entered!: () => void, requestSignal!: AbortSignal
  const waiting = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    if (first) {
      first = false
      // Spend nineteen minutes on the first request, then let the model read state
      // and start a second request. Each call alone fits the provider deadline.
      t.mock.timers.tick(19 * 60_000)
      return Response.json({ choices: [{ message: { tool_calls: [{ id: 'state-1', type: 'function', function: { name: 'get_creation_state', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
    }
    requestSignal = init.signal!; entered()
    return new Promise<Response>(() => {})
  })
  const pending = app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '检查创作进度然后继续讨论' }] } })
  await waiting
  t.mock.timers.tick(10 * 60_000)
  assert.equal(requestSignal.aborted, false)
  t.mock.timers.tick(60_000)
  const response = await pending
  const events = response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.equal(requestSignal.aborted, true)
  assert.match(events.find(event => event.type === 'error').message, /30 分钟/)
  assert.equal(events.at(-1).type, 'close')
  assert.ok(!events.some(event => event.type === 'done'))
  const activity = events.filter(event => event.type === 'activity').map(event => event.activity)
  assert.equal(activity.findLast(item => item.kind === 'model').status, 'failed')
  assert.match(activity.findLast(item => item.kind === 'model').summary, /超时/)
  assert.equal(activity.findLast(item => item.kind === 'tool').status, 'succeeded')
})


test('direction readiness is proposed through native tools, persists, and cannot skip phases or use invented sources', async t => {
  const { project, script, makeTools } = await fixture(), model = await nativeModel()
  assert.equal(creationState(project.id, script()).status, 'direction')
  assert.equal(creationState(project.id, script()).next_step, null)
  const proposed = { stage: 'outline', summary: '主线与核心冲突已明确，可以整理全剧大纲。', basis: '创作者指定林晚调查城市怪谈，并授权补齐细节。', source_message_indexes: [0] }
  await assert.rejects(makeTools().execute('propose_next_step', { ...proposed, stage: 'characters' }), /最早缺失/)
  await assert.rejects(makeTools().execute('propose_next_step', { ...proposed, source_message_indexes: [3] }), /真实创作者/)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    calls++
    assert.ok(JSON.parse(String(init.body)).tools.some((tool: any) => tool.function.name === 'propose_next_step'))
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'next', type: 'function', function: { name: 'propose_next_step', arguments: JSON.stringify(proposed) } }] }, finish_reason: 'tool_calls' }] })
  })
  const done = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, question_response: { status: 'skipped', question: '要哪一种怪谈？' }, messages: [{ role: 'user', text: '林晚调查城市怪谈，其他细节由你决定。' }] })
  assert.equal(calls, 1); assert.equal(done.creation.status, 'ready'); assert.equal(done.creation.next_step.stage, 'outline')
  assert.equal(getToolDraft(project.id), null); assert.equal(script().outline, '')
  const restored = await call<any>('GET', `/api/projects/${project.id}/script/director/tools-state`)
  assert.equal(restored.creation.next_step.id, done.creation.next_step.id)
  assert.equal(acceptCreationStep(project.id, script(), done.creation.next_step.id).stage, 'outline')
  await makeTools().execute('record_story_decision', { topic: '主线调整', content: '改为海岛怪谈', basis: 'creator_confirmed', source_message_index: 0 })
  assert.equal(creationState(project.id, script()).next_step, null)
  const stale = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true, next_step_id: done.creation.next_step.id, messages: [{ role: 'user', text: '生成大纲' }] } })
  assert.equal(stale.statusCode, 409); assert.equal(calls, 1, 'reject outdated readiness before requesting the provider')
})

test('stage button uses native drafting, waits for saving, and reuses characters saved before the outline', async t => {
  const { project, script, makeTools } = await fixture(), model = await nativeModel()
  await artifact(project.id)
  const originalCharacters = script().characters
  await makeTools().execute('propose_next_step', { stage: 'outline', summary: '方向明确', basis: '创作者已经提供主线', source_message_indexes: [0] })
  const ready = creationState(project.id, script()).next_step!
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body)); calls++
    assert.ok(body.tools, 'stage button must not switch back to the legacy text path')
    assert.match(body.messages[0].content, /创作者本轮明确要求处理这个阶段/)
    assert.match(body.messages[0].content, /每段对白明确人物动机/, 'stage generation keeps enabled Skill rules')
    return body.messages.at(-1).role === 'tool' ? Response.json({ choices: [{ message: { content: '全剧大纲草稿已准备。' }, finish_reason: 'stop' }] })
      : Response.json({ choices: [{ message: { tool_calls: [{ id: 'outline', type: 'function', function: { name: 'create_document_draft', arguments: JSON.stringify({ stage: 'outline', artifacts: stageArtifacts('outline', '林晚在城市中调查怪谈。'), scenes: [] }) } }] }, finish_reason: 'tool_calls' }] })
  })
  const done = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, next_step_id: ready.id, workflow: { stage: 'outline', scope: 'project', episode_number: 0 }, messages: [{ role: 'user', text: '生成全剧大纲，沿用已保存人物。' }] })
  assert.equal(calls, 2); assert.equal(done.tool_draft.status, 'pending'); assert.equal(done.creation.status, 'review'); assert.equal(done.creation.next_step, null)
  assert.equal(script().outline, '')
  assert.deepEqual(done.tool_draft.documents.map((doc: any) => doc.artifact_type), [...scriptStageArtifacts.outline])
  await call('POST', `/api/projects/${project.id}/script/director/tool-drafts/${done.tool_draft.id}/commit`, { version: done.tool_draft.version, approved: true })
  const state = creationState(project.id, script())
  assert.equal(state.next_step!.stage, 'locations'); assert.equal(script().characters, originalCharacters)
  assert.equal(state.stage_context.mode, 'default')
  assert.equal(script().artifacts!.filter(doc => scriptStageArtifacts.outline.includes(doc.artifact_type as typeof scriptStageArtifacts.outline[number])).length, 9)
})

test('ordinary direction discussion cannot turn a model-generated draft into an authorized write', async t => {
  const { project, script } = await fixture(), model = await nativeModel()
  let checks = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body))
    if (!body.tools) { checks++; return Response.json({ choices: [{ message: { content: '{"authorized":false}' } }] }) }
    if (body.messages.at(-1).role === 'tool') { assert.equal(JSON.parse(body.messages.at(-1).content).ok, false); return Response.json({ choices: [{ message: { content: '先讨论核心冲突。' }, finish_reason: 'stop' }] }) }
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'bad-create', type: 'function', function: { name: 'create_document_draft', arguments: JSON.stringify({ stage: 'outline', artifacts: stageArtifacts('outline', '擅自生成内容'), scenes: [] }) } }] }, finish_reason: 'tool_calls' }] })
  })
  const result = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '我想讨论一个城市怪谈故事。' }] })
  assert.equal(checks, 1); assert.equal(getToolDraft(project.id), null); assert.equal(script().outline, '')
  assert.equal(result.creation.status, 'direction'); assert.ok(result.activity.some((step: any) => step.label === '核验创作授权'))
})

test('ordinary chat generation uses detailed stage standards and repairs missing documents before offering a draft', async t => {
  const { project, script } = await fixture(), model = await nativeModel()
  let creationCalls = 0, authorizationChecks = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body))
    if (!body.tools) { authorizationChecks++; return Response.json({ choices: [{ message: { content: '{"authorized":true}' } }] }) }
    assert.match(body.messages[0].content, /普通讨论、设定回答和跳过不授权创建草稿/)
    assert.match(body.messages[0].content, /伏笔与回收[\s\S]*反转预设[\s\S]*创作禁区/)
    if (body.messages.at(-1).role === 'tool') {
      const output = JSON.parse(body.messages.at(-1).content)
      if (output.ok) return Response.json({ choices: [{ message: { content: '九份大纲文档已准备，等待确认。' }, finish_reason: 'stop' }] })
      assert.match(JSON.stringify(output), /当前阶段缺少完整文档[\s\S]*伏笔与回收/)
    }
    const artifacts = stageArtifacts('outline', '林晚调查城市怪谈')
    return Response.json({ choices: [{ message: { tool_calls: [{ id: `outline-${++creationCalls}`, type: 'function', function: { name: 'create_document_draft', arguments: JSON.stringify({ stage: 'outline', artifacts: creationCalls === 1 ? artifacts.slice(0, 1) : artifacts, scenes: [] }) } }] }, finish_reason: 'tool_calls' }] })
  })
  const result = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '生成全剧大纲和全部详细设计文档。' }] })
  assert.equal(creationCalls, 2)
  assert.equal(authorizationChecks, 1)
  assert.equal(result.tool_draft.documents.length, 9)
  assert.equal(script().artifacts!.length, 0)
  assert.equal(script().outline, '')
})

test('a missing document title is rejected and sent back for repair even when the model stops after failure', async t => {
  const { project, script } = await fixture(), model = await nativeModel()
  const artifacts = stageArtifacts('outline', '林晚追查城市救援事件')
  artifacts[0].title = '城市救援 · 概要设计'
  let turns = 0, authorizationChecks = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body))
    if (!body.tools) { authorizationChecks++; return Response.json({ choices: [{ message: { content: '{"authorized":true}' } }] }) }
    turns++
    const last = body.messages.at(-1)
    if (turns === 2) {
      assert.equal(last.role, 'tool')
      const output = JSON.parse(last.content)
      assert.equal(output.ok, false)
      assert.equal(output.diagnostic.retryable, true)
      assert.equal(output.diagnostic.path, 'artifacts.0.title')
      assert.match(output.diagnostic.message, /标题.*补全 title/)
      assert.equal(getToolDraft(project.id), null, 'invalid titles never create a draft')
      assert.equal(script().artifacts!.length, 0)
      return Response.json({ choices: [{ message: { content: '我会补上标题。' }, finish_reason: 'stop' }] })
    }
    if (turns === 4) {
      assert.equal(JSON.parse(last.content).ok, true)
      return Response.json({ choices: [{ message: { content: '标题已补齐，草稿等待确认。' }, finish_reason: 'stop' }] })
    }
    assert.ok(turns === 1 || turns === 3)
    if (turns === 3) assert.match(last.content, /程序执行检查[\s\S]*artifacts\.0\.title/)
    const input = turns === 1 ? artifacts.map((doc, index) => {
      if (index) return doc
      const { title: _title, ...untitled } = doc
      return untitled
    }) : artifacts
    return Response.json({ choices: [{ message: { tool_calls: [{ id: `title-${turns}`, type: 'function', function: { name: 'create_document_draft', arguments: JSON.stringify({ stage: 'outline', artifacts: input, scenes: [] }) } }] }, finish_reason: 'tool_calls' }] })
  })
  const result = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '生成全剧大纲和全部详细设计文档。' }] })
  assert.equal(turns, 4)
  assert.equal(authorizationChecks, 1)
  assert.equal(result.tool_draft.documents.length, 9)
  assert.equal(result.tool_draft.documents[0].title, artifacts[0].title)
  assert.equal(result.tool_draft.documents[0].content, artifacts[0].content)
  assert.equal(script().artifacts!.length, 0, 'repair remains a draft pending creator confirmation')
})

test('explicit stage selection restricts revisions to the requested document and episode', async () => {
  const { project, script, makeTools } = await fixture()
  await artifact(project.id); await artifact(project.id, 'locations', '车站')
  const character = script().artifacts!.find(doc => doc.artifact_type === 'characters')!, location = script().artifacts!.find(doc => doc.artifact_type === 'locations')!
  const tools = makeTools({ workflow: 'characters', operation: 'revise', stage: directorStageContext(script(), { explicit: { stage: 'characters', episode_number: 0 } }) })
  const read = await readDoc(tools, location.id)
  await assert.rejects(tools.execute('propose_document_patch', { summary: '改地点', changes: [{ document_id: location.id, base_version: read.version, replacements: [{ find: '车站', replace: '港口', reason: '修改' }] }] }), /明确指定/)
  const valid = await readDoc(tools, character.id)
  await tools.execute('propose_document_patch', patch(character.id, valid.version))
  assert.equal(getToolDraft(project.id)!.documents[0].id, character.id)
  await assert.rejects(tools.execute('propose_next_step', { stage: 'outline', summary: '继续大纲', basis: '已有内容', source_message_indexes: [0] }), /当前草稿/)
})

test('episode-one saving exposes its storyboard data while episode two is still the next writing step', async () => {
  const { project, script } = await fixture()
  for (const stage of ['outline', 'characters', 'locations', 'props']) await artifact(project.id, stage, stage + '设定')
  await call('PUT', `/api/projects/${project.id}/script`, { outline: script().outline, characters: script().characters, generation_options: { episode_count: 3 } })
  await artifact(project.id, 'episode_script', '第一集完整正文')
  const scene = await call<any>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站', episode_number: 1, duration: 8 })
  const state = creationState(project.id, script())
  assert.deepEqual(state.saved_episodes, [1]); assert.equal(state.next_step!.stage, 'episode'); assert.equal(state.next_step!.episode_number, 2)
  const handoff = await call<any>('POST', `/api/projects/${project.id}/script/convert-to-shots`, { scene_ids: [scene.id] })
  assert.equal(handoff.shots.length, 1); assert.equal(handoff.shots[0].source_scene_id, scene.id)
})

test('accepting a revision proposal scopes native patches to its existing target', async t => {
  const { project, script, makeTools } = await fixture(), model = await nativeModel()
  await artifact(project.id); await artifact(project.id, 'locations', '车站')
  const doc = script().artifacts!.find(item => item.artifact_type === 'characters')!
  const tools = makeTools({ action: { operation: 'revise', document_ids: [doc.id] }, stage: directorStageContext(script(), { explicit: { stage: 'characters', episode_number: 0 } }) })
  await tools.execute('propose_next_step', { stage: 'characters', purpose: 'revise', summary: '补齐林晚职业', basis: '创作者要求修改人物', source_message_indexes: [0], document_ids: [doc.id] })
  const next = creationState(project.id, script()).next_step!
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body)); calls++
    assert.match(body.messages[0].content, /本轮明确操作/)
    assert.match(body.messages[0].content, new RegExp(doc.id))
    if (calls === 3) return Response.json({ choices: [{ message: { content: '修订草稿待确认。' }, finish_reason: 'stop' }] })
    const fn = calls === 1 ? 'read_documents' : 'propose_document_patch'
    const args = calls === 1 ? { document_ids: [doc.id] } : patch(doc.id, JSON.parse(body.messages.at(-1).content).result.documents[0].version)
    return Response.json({ choices: [{ message: { tool_calls: [{ id: `revision-${calls}`, type: 'function', function: { name: fn, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
  })
  const done = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, next_step_id: next.id, workflow: { stage: 'characters', scope: 'project', episode_number: 0 }, messages: [{ role: 'user', text: '修订全剧人物设定，补齐林晚职业' }] })
  assert.equal(done.tool_draft.kind, 'patch'); assert.equal(done.tool_draft.documents[0].id, doc.id)
  assert.equal(done.creation.status, 'review'); assert.equal(script().artifacts!.find(item => item.id === doc.id)!.content, doc.content)
  assert.equal(script().artifacts!.find(item => item.artifact_type === 'locations')!.content, '车站')
})

test('natural-language stage jumps cannot create unsaved future-stage drafts', async t => {
  const { project, script } = await fixture(), model = await nativeModel()
  let checks = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const intentReply = discussionIntent(init); if (intentReply) return intentReply;
    const body = JSON.parse(String(init.body))
    if (!body.tools) {
      checks++; assert.match(body.messages[0].content, /跨越当前推荐阶段/)
      return Response.json({ choices: [{ message: { content: '{"authorized":true}' } }] })
    }
    if (body.messages.at(-1).role === 'tool') return Response.json({ choices: [{ message: { content: '人物草稿已准备，尚未保存。' }, finish_reason: 'stop' }] })
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'jump', type: 'function', function: { name: 'create_document_draft', arguments: JSON.stringify({ stage: 'characters', artifacts: stageArtifacts('characters', '林晚是记者。'), scenes: [] }) } }] }, finish_reason: 'tool_calls' }] })
  })
  const done = await call<any>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '先生成全剧人物设定，大纲之后再写。' }] })
  assert.equal(checks, 0); assert.equal(done.tool_draft, undefined); assert.match(done.execution_outcome.summary, /请先完成并保存故事大纲/)
  assert.equal(script().characters, ''); assert.equal(script().outline, ''); assert.equal(done.creation.next_step, null)
})
