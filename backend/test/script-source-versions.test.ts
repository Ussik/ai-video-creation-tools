import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import type { ScriptSourceUpdate } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisPipelineVersion } from '../src/modules/script/script-source-map.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
const testData = await mkdtemp(join(tmpdir(), 'studio-source-versions-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, newId } = await import('../src/infrastructure/database/db.js')
const { effectiveScriptSource, originalScriptSource, scriptDocumentVersion, commitScriptSourceUpdate } = await import('../src/modules/script/script-source-versions.js')
const { repairScriptSource } = await import('../src/modules/script/script-draft-resolution.js')
const { documentTools, getToolDraft, attachDraftSourceUpdate, editToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext, workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
const originalText = '全剧60集。\n龟和龙加入合作，原因尚未展开。\n结局伙伴重聚。'
const revisedText = originalText.replace('原因尚未展开。', '因为龙救下受困的龟，两者约定合作守护河流。')
const stageDraft = () => workflowGenerationDraftSchema.parse({ stage: 'outline', artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: revisedText })), scenes: [] })
async function upload(id: string, content: string) {
  const boundary = 'revision-source'
  const result = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="story.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(result.statusCode, 200, result.body); return result.json()
}
async function fixture() {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '修订来源' } })).json()
  await upload(project.id, originalText); return project
}
function update(id: string, content = revisedText): ScriptSourceUpdate {
  const source = effectiveScriptSource(id)!
  return { id: newId(), base_version: scriptDocumentVersion(source), original_content: source.content, content,
    replacements: [{ find: '原因尚未展开。', replace: '因为龙救下受困的龟，两者约定合作守护河流。', reason: '补齐合作起因' }] }
}
async function nativeDraft(project: any, sourceUpdate?: ScriptSourceUpdate) {
  const snapshot = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script
  const tools = documentTools({ project, script: () => snapshot, workflow: 'outline', stage: directorStageContext(snapshot, { explicit: { stage: 'outline', episode_number: 0 } }),
    messages: [{ role: 'user', text: '生成完整全剧大纲' }], checkApproval: async () => false, onEvent: () => {} })
  await tools.execute('create_document_draft', stageDraft())
  const draft = getToolDraft(project.id)!
  return sourceUpdate ? attachDraftSourceUpdate(project.id, draft.id, sourceUpdate) : draft
}
async function confirm(projectId: string, draft: { id: string; version: string }) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/director/tool-drafts/${draft.id}/commit`, payload: { version: draft.version, approved: true } })
}

test('ordinary stage drafts reject a replaced, removed or newly added source and preserve pending work', async () => {
  for (const mutation of ['replace', 'replace_identically', 'remove', 'add', 'revise'] as const) {
    const project = mutation === 'add' ? (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '尚无原稿' } })).json() : await fixture()
    const source = effectiveScriptSource(project.id)
    const draft = await nativeDraft(project)
    assert.equal(draft.source_version, source ? scriptDocumentVersion(source) : null)
    if (mutation === 'remove') assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/script/source` })).statusCode, 200)
    else if (mutation === 'revise') commitScriptSourceUpdate(project.id, update(project.id))
    else await upload(project.id, mutation === 'replace_identically' ? originalText : '作者的新原稿，保留真实结局。')
    const before = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script
    const edited = editToolDraft(project.id, draft.id, { version: draft.version, documents: [{ id: draft.documents[0]!.id, content: '保留的手动草稿内容' }] })
    assert.equal(edited.source_version, draft.source_version, 'editing never rebinds the source to the latest upload')
    const result = await confirm(project.id, edited)
    assert.equal(result.statusCode, 409, result.body)
    assert.match(result.json().detail, /来源已变化.*草稿仍保留/)
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script, before)
    assert.deepEqual(getToolDraft(project.id), edited)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_revisions WHERE project_id=?').get(project.id)!.count, mutation === 'revise' ? 1 : 0)
  }
})

test('unchanged sources including no source save normally, and stage plus source revision commit together', async () => {
  for (const mode of ['source', 'none', 'revision'] as const) {
    const project = mode === 'none' ? (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '原创剧本' } })).json() : await fixture()
    const proposed = mode === 'revision' ? update(project.id) : undefined
    const draft = await nativeDraft(project, proposed)
    const result = await confirm(project.id, draft)
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().status, 'saved')
    const saved = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script
    assert.equal(saved.artifacts.length, scriptStageArtifacts.outline.length)
    assert.equal(effectiveScriptSource(project.id)?.content ?? null, mode === 'none' ? null : proposed?.content || originalText)
    if (proposed) assert.equal(originalScriptSource(project.id)!.content, originalText)
  }
})

test('legacy drafts remain readable and editable without silently adopting a source version', async () => {
  const project = await fixture(), draft = await nativeDraft(project)
  const { source_version: _binding, ...legacy } = draft
  db.prepare('UPDATE script_tool_drafts SET payload=? WHERE id=?').run(JSON.stringify(legacy), draft.id)
  const edited = editToolDraft(project.id, draft.id, { version: draft.version, documents: [{ id: draft.documents[0]!.id, content: '可追溯的历史候选稿' }] })
  assert.equal(edited.source_version, undefined)
  const result = await confirm(project.id, edited)
  assert.equal(result.statusCode, 409, result.body)
  assert.match(result.json().detail, /历史草稿缺少原稿版本记录/)
  assert.equal(getToolDraft(project.id)!.documents[0]!.content, '可追溯的历史候选稿')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_artifacts WHERE project_id=?').get(project.id)!.count, 0)
})

test('a document tool session retains the original source binding across asynchronous validation', async () => {
  const project = await fixture()
  const snapshot = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script
  const expected = scriptDocumentVersion(effectiveScriptSource(project.id)!)
  const tools = documentTools({ project, script: () => snapshot, workflow: 'outline', stage: directorStageContext(snapshot, { explicit: { stage: 'outline', episode_number: 0 } }),
    messages: [{ role: 'user', text: '生成大纲' }], checkApproval: async () => false, onEvent: () => {}, validateCreation: async () => { await upload(project.id, '模型审读期间替换的原稿。') } })
  await tools.execute('create_document_draft', stageDraft())
  const draft = getToolDraft(project.id)!
  assert.equal(draft.source_version, expected)
  assert.equal((await confirm(project.id, draft)).statusCode, 409)
})

test('document patches bind their source while independent resource drafts can still save after source changes', async () => {
  const project = await fixture()
  const saved = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/artifacts`, payload: { artifacts: [{ artifact_type: 'characters', title: '人物设定', content: '林晚：记者。', episode_number: 0, status: 'ready' }] } })
  assert.equal(saved.statusCode, 200, saved.body)
  const snapshot = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script, document = snapshot.artifacts[0]
  const tools = documentTools({ project, script: () => snapshot, stage: directorStageContext(snapshot), messages: [{ role: 'user', text: '修改林晚设定' }], checkApproval: async () => false, onEvent: () => {} })
  const read = await tools.execute('read_documents', { document_ids: [document.id] }) as { documents: Array<{ version: string }> }
  await tools.execute('propose_document_patch', { summary: '补充职业', changes: [{ document_id: document.id, base_version: read.documents[0]!.version, replacements: [{ find: '林晚：记者。', replace: '林晚：调查记者。', reason: '明确职业' }] }] })
  const patch = getToolDraft(project.id)!
  await upload(project.id, '替换原稿。')
  assert.equal((await confirm(project.id, patch)).statusCode, 409)
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/tool-drafts/${patch.id}/discard`, payload: { version: patch.version } })).statusCode, 200)
  const resources = documentTools({ project, script: () => snapshot, stage: directorStageContext(snapshot), messages: [{ role: 'user', text: '创建林晚视觉设定' }], checkApproval: async () => false, authorizeResource: async () => true, onEvent: () => {} })
  await resources.execute('propose_visual_profile_draft', { summary: '创建视觉设定', profiles: [{ profile: { kind: 'character', name: '林晚', variant: '日常', definition: '黑发，墨绿雨衣', view_requirements: '正侧背', scene_ids: [] } }] })
  const resource = getToolDraft(project.id)!
  assert.equal(resource.source_version, undefined)
  await upload(project.id, '再次替换原稿，不涉及视觉对象。')
  const result = await confirm(project.id, resource)
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM visual_profiles WHERE project_id=?').get(project.id)!.count, 1)
})
test('source replacement rejects both confirmation paths and rolls stage writes back; discard keeps source intact', async () => {
  for (const native of [false, true]) {
    const project = await fixture(), proposed = update(project.id), draft = native ? await nativeDraft(project, proposed) : null
    await upload(project.id, '新上传原稿，仍为60集，剧情已由作者修改。')
    const before = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script
    const result = draft ? await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/tool-drafts/${draft.id}/commit`, payload: { version: draft.version, approved: true } })
      : await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/director/draft`, payload: { ...stageDraft(), source_update: proposed } })
    assert.equal(result.statusCode, 409, result.body)
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().script, before)
    assert.match(effectiveScriptSource(project.id)!.content, /新上传原稿/)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_revisions WHERE project_id=?').get(project.id)!.count, 0)
    if (draft) {
      assert.equal(getToolDraft(project.id)!.version, draft.version)
      const discarded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/tool-drafts/${draft.id}/discard`, payload: { version: draft.version } })
      assert.equal(discarded.statusCode, 200, discarded.body); assert.match(effectiveScriptSource(project.id)!.content, /新上传原稿/)
    }
  }
})
test('revisions survive reload, preserve upload bytes, support idempotence and reset on a replacement upload', async () => {
  const project = await fixture(), uploadText = originalScriptSource(project.id)!.content, proposed = update(project.id, `\n${revisedText}\n`)
  const saved = commitScriptSourceUpdate(project.id, proposed)
  assert.equal(saved.content, proposed.content, 'manual whitespace is preserved')
  assert.equal(saved.revision, 1); assert.deepEqual(commitScriptSourceUpdate(project.id, proposed), saved)
  assert.equal(originalScriptSource(project.id)!.content, uploadText)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/source` })).json().revision, 1)
  const second = { ...update(project.id), content: proposed.content.replace('伙伴重聚', '伙伴在河岸重聚') }
  commitScriptSourceUpdate(project.id, second); assert.equal(effectiveScriptSource(project.id)!.revision, 2)
  assert.throws(() => commitScriptSourceUpdate(project.id, proposed), /修订已变化/)
  const other = await fixture(); assert.throws(() => commitScriptSourceUpdate(other.id, second), /修订已变化/)
  await upload(project.id, uploadText)
  assert.equal(effectiveScriptSource(project.id)!.revision, undefined); assert.equal(effectiveScriptSource(project.id)!.content, uploadText)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_revisions WHERE project_id=?').get(project.id)!.count, 2)
})
test('successive source repair rounds use proposed text without committing and reject invented source edits', async () => {
  const project = await fixture(), source = effectiveScriptSource(project.id)!
  const pending = { id: 'pending', version: 'version', draft: stageDraft(), findings: [], request: {}, source_version: 'source' }
  const first = repairScriptSource(pending, source, update(project.id).replacements)!
  const second = repairScriptSource({ ...pending, source_update: first }, source, [{ find: '守护河流。', replace: '守护河流，每晚轮流巡查。', reason: '明确合作行动' }])!
  assert.equal(first.base_version, second.base_version); assert.equal(first.id, second.id)
  assert.equal(second.original_content, source.content); assert.equal(second.replacements.length, 2)
  assert.match(second.content, /全剧60集/); assert.match(second.content, /每晚轮流巡查/)
  assert.equal(effectiveScriptSource(project.id)!.content, source.content)
  assert.deepEqual(repairScriptSource({ ...pending, source_update: second }, source, []), second)
  assert.throws(() => repairScriptSource(pending, null, first.replacements), /没有文稿来源/)
  assert.throws(() => repairScriptSource(pending, source, [{ find: '原文不存在', replace: '修改', reason: '测试' }]))
})
function mapReply(prompt: string) {
  if (prompt.includes('【原稿分析核对资料】')) {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('【原稿分析核对资料】\n') + '【原稿分析核对资料】\n'.length))
    return JSON.stringify({ checked_section_ids: input.sections.map((section: { id: number }) => section.id), findings: [] })
  }
  if (prompt.includes('【全剧整合资料】')) {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('【全剧整合资料】\n') + '【全剧整合资料】\n'.length))
    const ids = input.materials.flatMap((item: any) => item.covered_section_ids)
    return JSON.stringify({ covered_section_ids: ids, story: { summary: '龟龙合作守护河流，结局伙伴重聚。', characters: [], timeline: [{ summary: '龙救下受困的龟，双方约定守护河流。', section_ids: ids }], threads: [],
      ending: { summary: '伙伴重聚。', section_ids: ids }, uncertainties: [] } })
  }
  const batch = JSON.parse(prompt.slice(prompt.lastIndexOf('【原文片段】\n') + '【原文片段】\n'.length))
  const units = batch.passages.flatMap((passage: { units: Array<{ id: number; text: string }> }) => passage.units)
  return JSON.stringify({ sections: [{ start_unit: units[0].id, title: '合作', episode_number: null, summary: '检索摘要', characters: [],
    events: [{ summary: '合作起因', evidence: { unit_id: units.find((unit: { text: string }) => unit.text.includes('龙救下受困的龟')).id } }] }] })
}
test('revision save invalidates old maps and late results; rebuilt maps use revised content and positions', async () => {
  const project = await fixture(), proposed = update(project.id)
  let release: () => void = () => {}, began: () => void = () => {}
  const started = new Promise<void>(resolve => { began = resolve }); let calls = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    calls++
    if (prompt.includes('原因尚未展开')) return new Promise<string>(resolve => { release = () => resolve(JSON.stringify({ sections: [{ start_unit: 0, title: '旧地图', episode_number: null, summary: '旧内容', characters: [], events: [] }] })); began() })
    assert.match(prompt, /龙救下受困的龟/); return mapReply(prompt)
  })
  try {
    analyzer.start(project.id, 'mock'); await started; commitScriptSourceUpdate(project.id, proposed)
    assert.equal(scriptSourceAnalysis(project.id), null)
    release()
    for (let attempt = 0; attempt < 100 && scriptSourceAnalysis(project.id)?.status !== 'ready'; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    const map = scriptSourceAnalysis(project.id)!
    assert.equal(map.status, 'ready', map.error || '')
    assert.doesNotMatch(JSON.stringify(map), /旧地图|旧内容/)
    assert.ok(calls >= 3, 'confirmed revision rebuilds the map and full-story information')
    const evidence = map.sections[0]!.events[0]!.evidence
    assert.equal(proposed.content.slice(evidence.offset, evidence.offset + evidence.quote.length), evidence.quote)
    commitScriptSourceUpdate(project.id, { ...update(project.id), content: proposed.content.replace('伙伴重聚', '伙伴在河岸重聚') })
    assert.equal(scriptSourceAnalysis(project.id), null, 'ready map is invalidated too')
  } finally { release(); await analyzer.close() }
})

test('confirmed save reuses server-analyzed identical proposed content; rollback publishes no new map', async () => {
  const { analyzeSourceSnapshot } = await import('../src/modules/script/script-source-analysis.js')
  const project = await fixture(), proposed = update(project.id)
  const configuration = ['gpt-6.1-sol', JSON.stringify({ temperature: 0.4 }), 'openai-responses', 'https://fixture.invalid/v1']
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => { calls++; return mapReply(prompt) }, undefined, { configuration: () => configuration })
  // Start from a confirmed source whose current map is already ready.
  const current = effectiveScriptSource(project.id)!
  const existing = { id: newId(), source_version: (await import('../src/modules/script/script-source-analysis.js')).scriptSourceVersion(current), model_id: 'mock', status: 'ready', phase: 'ready', pipeline_version: sourceAnalysisPipelineVersion, completed_chunks: 1, total_chunks: 1, sections: [], error: null, updated_at: current.updated_at }
  db.prepare('INSERT OR REPLACE INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)').run(project.id, existing.id, existing.source_version, 'ready', JSON.stringify(existing), current.updated_at)
  analyzer.start(project.id, 'mock')
  try {
    const prepared = await analyzeSourceSnapshot({ ...current, content: proposed.content }, 'mock', async prompt => { calls++; return mapReply(prompt) }, new AbortController().signal, configuration)
    assert.equal(calls, 3)
    assert.throws(() => db.transaction(() => { commitScriptSourceUpdate(project.id, proposed); throw new Error('rollback') })(), /rollback/)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(scriptSourceAnalysis(project.id)!.id, existing.id)
    assert.equal(effectiveScriptSource(project.id)!.content, originalText)
    commitScriptSourceUpdate(project.id, proposed); await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(scriptSourceAnalysis(project.id)!.status, 'ready')
    assert.deepEqual(scriptSourceAnalysis(project.id)!.story, prepared.story)
    assert.equal(calls, 3, 'confirmed identical source reuses validated private snapshot without another AI call')
    assert.equal(originalScriptSource(project.id)!.content, originalText)
  } finally { await analyzer.close() }
})

test('a model configuration removed before confirmation cannot escape the revision listener or reuse unknown cached identity', async () => {
  const { analyzeSourceSnapshot } = await import('../src/modules/script/script-source-analysis.js')
  const project = await fixture(), proposed = update(project.id)
  const configuration = ['remote-model', '{"temperature":0.4}', 'openai-responses', 'https://fixture.invalid/v1']
  let configurationRemoved = false, calls = 0
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt) => {
    calls++
    if (configurationRemoved) throw new Error('模型配置已移除')
    return sourceAnalysisFixture(prompt)!
  }, undefined, { configuration: () => {
    if (configurationRemoved) throw new Error('模型配置已移除')
    return configuration
  } })
  try {
    analyzer.start(project.id, 'mock')
    for (let attempt = 0; attempt < 100 && scriptSourceAnalysis(project.id)?.status !== 'ready'; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(scriptSourceAnalysis(project.id)!.status, 'ready')
    await analyzeSourceSnapshot({ ...effectiveScriptSource(project.id)!, content: proposed.content }, 'mock', async prompt => sourceAnalysisFixture(prompt)!, new AbortController().signal, configuration)
    const beforeConfirmation = calls
    configurationRemoved = true
    commitScriptSourceUpdate(project.id, proposed)
    for (let attempt = 0; attempt < 100 && scriptSourceAnalysis(project.id)?.status !== 'failed'; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    const result = scriptSourceAnalysis(project.id)!
    assert.equal(result.status, 'failed')
    assert.match(result.error || '', /模型配置已移除/)
    assert.ok(calls > beforeConfirmation, 'the worker checks the unavailable provider rather than adopting a cache with an unknown identity')
    assert.equal(effectiveScriptSource(project.id)!.revision, 1, 'a source revision remains saved even when background analysis cannot run')
  } finally { await analyzer.close() }
})
