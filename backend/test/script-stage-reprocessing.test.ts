import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import type { ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptStageArtifacts, scriptArtifactLabels, type ScriptStage } from '@video-studio/shared/script/script-stage-content'
import { stageOperationError, missingSavedStageArtifacts, type StageOperation } from '@video-studio/shared/script/script-stage-access'
import { directorStageContext, workflowProgress } from '../src/modules/script/script-workflow.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-stage-reprocessing-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, all, one, run } = await import('../src/infrastructure/database/db.js')
const { documentTools, commitToolDraft, discardToolDraft, getToolDraft, editToolDraft } = await import('../src/modules/script/script-document-tools.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown): Promise<any> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
function artifacts(stage: ScriptStage, content = '已确认设计') {
  return scriptStageArtifacts[stage].map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: `${scriptArtifactLabels[artifact_type]}：${content}`, status: 'ready' }))
}
async function fixture(legacy = false) {
  const project = await call('POST', '/api/projects', { name: '阶段重新处理测试' })
  await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
    ...artifacts('outline'), ...artifacts('characters'), ...(legacy ? artifacts('locations').slice(0, 1) : artifacts('locations')), ...artifacts('props'),
    { artifact_type: 'episode_script', episode_number: 1, title: '第一集', content: '已经确认的分集正文', status: 'ready' },
  ] })
  const script = (): ScriptSnapshot => {
    const row = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', project.id)
    return { outline: row?.outline || '', characters: row?.characters || '', generation_options: JSON.parse(row?.generation_options || '{}'),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', project.id), scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', project.id) }
  }
  const tools = (stage: ScriptStage, operation: StageOperation) => documentTools({ project, script,
    stage: directorStageContext(script(), { explicit: { stage, episode_number: stage === 'episode' ? 1 : 0 } }), workflow: stage, operation,
    messages: [{ role: 'user', text: '重新设计所选阶段，先准备草稿，只处理这个阶段' }], checkApproval: async () => false, onEvent: () => {} })
  return { project, script, tools }
}
async function readAll(instance: ReturnType<typeof documentTools>, docs: ScriptArtifact[]) {
  for (const doc of docs) await instance.execute('read_documents', { document_ids: [doc.id] })
}

async function episodeFixture() {
  const fixtureData = await fixture(), { project, script } = fixtureData
  await call('PUT', `/api/projects/${project.id}/script`, { outline: script().outline, characters: script().characters, scenes: [
    ...Array.from({ length: 4 }, (_, index) => ({ episode_number: 1, heading: `旧场次${index + 1}`, location: '车站', characters: '林晚', action: `动作${index + 1}`, dialogue: `对白${index + 1}`, narration: '原旁白', duration: 8 })),
    { episode_number: 2, heading: '第二集原场次', action: '第二集事实', duration: 8 },
  ] })
  await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [{ artifact_type: 'episode_script', episode_number: 2, title: '第二集', content: '第二集确认正文', status: 'ready' }] })
  const source = script().artifacts!.find(doc => doc.artifact_type === 'episode_script' && doc.episode_number === 1)!
  const sources = script().scenes.filter(scene => scene.episode_number === 1), timestamp = new Date().toISOString()
  const shotId = `${project.id}-shot`, assetId = `${project.id}-asset`, profileId = `${project.id}-profile`, taskId = `${project.id}-task`
  run('INSERT INTO shots (id, project_id, position, title, source_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', shotId, project.id, 0, '原车站镜头', sources[0].id, timestamp)
  run('INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', assetId, project.id, shotId, 'image', '旧素材.png', '/fixture/image.png', 'generated', timestamp)
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, shotId)
  run('INSERT INTO asset_tasks (id, project_id, focus_artifact, status, source_artifact_ids, source_scene_ids, result_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', taskId, project.id, 'location', 'ready', JSON.stringify([source.id]), JSON.stringify([sources[0].id]), assetId, timestamp, timestamp)
  run('INSERT INTO visual_profiles (id, project_id, kind, name, definition, view_requirements, board_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', profileId, project.id, 'location', '车站', '旧视觉设定', '[]', assetId, timestamp, timestamp)
  run('INSERT INTO scene_visual_bindings (scene_id, profile_id) VALUES (?, ?)', sources[0].id, profileId)
  const references = () => ({
    shot: one('SELECT * FROM shots WHERE id=?', shotId), asset: one('SELECT * FROM assets WHERE id=?', assetId),
    task: one('SELECT * FROM asset_tasks WHERE id=?', taskId), profile: one('SELECT * FROM visual_profiles WHERE id=?', profileId),
    bindings: all('SELECT * FROM scene_visual_bindings WHERE profile_id=?', profileId),
  })
  const request = { stage: 'episode' as const, scope: 'episode' as const, episode_number: 1,
    artifacts: [{ artifact_type: 'episode_script' as const, title: '第一集 · 重新设计', content: '重新设计的完整正文、动作、对白与结尾钩子' }],
    scenes: sources.map(scene => ({ source_scene_id: scene.id, heading: scene.heading + '新设计', location: scene.location, time_of_day: scene.time_of_day, characters: scene.characters, action: scene.action + '重做', dialogue: scene.dialogue + '重做', narration: scene.narration, duration: scene.duration })),
  }
  return { ...fixtureData, source, sources, references, request, shotId }
}

test('episode redesign reads all sources, previews safely and preserves document, scene, shot and asset identity when reordering', async () => {
  const { project, script, tools, source, sources, references, request, shotId } = await episodeFixture()
  const before = script(), originalReferences = references(), instance = tools('episode', 'regenerate')
  assert.equal(stageOperationError(before, { stage: 'episode', episode_number: 1, operation: 'regenerate' }), null)
  await assert.rejects(instance.execute('create_document_draft', request), /读完/)
  await readAll(instance, [source]) // default scene page contains only three of four scenes
  await assert.rejects(instance.execute('create_document_draft', request), /分页读完全部分场/)
  await instance.execute('read_episode_scenes', { episode_number: 1, offset: 3 })
  await assert.rejects(instance.execute('create_document_draft', { ...request, episode_number: 2 }), /明确指定/)
  await assert.rejects(instance.execute('create_document_draft', { ...request, scenes: request.scenes.slice(1) }), /全部已有场次/)
  await assert.rejects(instance.execute('create_document_draft', { ...request, scenes: [...request.scenes, request.scenes[0]] }), /不能重复/)
  await assert.rejects(instance.execute('create_document_draft', { ...request, scenes: request.scenes.map((scene, index) => index ? scene : { ...scene, source_scene_id: before.scenes.find(item => item.episode_number === 2)!.id }) }), /本集已有场次/)
  await assert.rejects(instance.execute('create_document_draft', { ...request, scenes: request.scenes.map((scene, index) => index ? scene : { ...scene, source_scene_id: 'invented-id' }) }), /本集已有场次/)
  const newScene = { heading: '新增开场', location: '车站', time_of_day: '日', characters: '林晚', action: '追赶列车', dialogue: '等一下！', narration: '', duration: 5 }
  await instance.execute('create_document_draft', { ...request, scenes: [newScene, ...request.scenes.toReversed()] })
  const draft = getToolDraft(project.id)!
  assert.equal(draft.documents[0].id, source.id)
  assert.equal(draft.workflow!.operation, 'regenerate')
  assert.ok(draft.impacts!.some(impact => impact.kind === 'shot' && impact.id === shotId))
  assert.deepEqual(script(), before)
  assert.deepEqual(references(), originalReferences)
  await assert.rejects(instance.execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /确认/)
  assert.throws(() => editToolDraft(project.id, draft.id, { version: draft.version, documents: [{ id: source.id, content: '编辑正文' }], scenes: draft.workflow!.scenes.slice(1, -1) }), /全部已有场次/)
  assert.equal(getToolDraft(project.id)!.version, draft.version)
  await instance.execute('manage_document_draft', { operation: 'read' })
  await assert.rejects(instance.execute('manage_document_draft', { operation: 'update', version: draft.version, scenes: draft.workflow!.scenes.slice(1, -1) }), /全部已有场次/)
  const edited = editToolDraft(project.id, draft.id, { version: draft.version, documents: [{ id: source.id, content: '作者确认前调整的完整正文' }], scenes: draft.workflow!.scenes.map(scene => ({ ...scene, dialogue: scene.dialogue + '手动编辑' })) })
  commitToolDraft(project.id, edited.id, edited.version, script)
  const saved = script(), savedScenes = saved.scenes.filter(scene => scene.episode_number === 1)
  assert.equal(savedScenes.length, 5, 'existing scenes are updated, not duplicated')
  assert.deepEqual(savedScenes.slice(1).map(scene => scene.id), sources.toReversed().map(scene => scene.id), 'explicit source IDs follow scene reorder')
  for (const original of sources) {
    const updated = savedScenes.find(scene => scene.id === original.id)!
    assert.equal(updated.action, original.action + '重做')
    assert.equal(updated.dialogue, original.dialogue + '重做手动编辑')
  }
  assert.equal(saved.artifacts!.find(doc => doc.id === source.id)!.content, '作者确认前调整的完整正文')
  for (const original of before.artifacts!.filter(doc => doc.id !== source.id)) assert.deepEqual(saved.artifacts!.find(doc => doc.id === original.id), original)
  assert.deepEqual(saved.scenes.filter(scene => scene.episode_number !== 1), before.scenes.filter(scene => scene.episode_number !== 1))
  assert.deepEqual(references(), originalReferences)
  assert.equal(workflowProgress(saved).next_episode, 3)
})

test('episode redesign discard and concurrent source edits never write partial formal changes', async () => {
  for (const conflict of ['discard', 'document', 'scene'] as const) {
    const { project, script, tools, source, request, references, sources } = await episodeFixture()
    const instance = tools('episode', 'regenerate'), before = script(), originalReferences = references()
    await readAll(instance, [source]); await instance.execute('read_episode_scenes', { episode_number: 1, offset: 3 })
    await instance.execute('create_document_draft', request)
    const draft = getToolDraft(project.id)!
    if (conflict === 'discard') {
      discardToolDraft(project.id, draft.id, draft.version)
      assert.deepEqual(script(), before)
    } else {
      if (conflict === 'document') run('UPDATE script_artifacts SET content=? WHERE id=?', '另一位作者的正文', source.id)
      else run('UPDATE script_scenes SET dialogue=? WHERE id=?', '另一位作者的对白', sources[0].id)
      const changed = script()
      assert.throws(() => commitToolDraft(project.id, draft.id, draft.version, script), /已被修改/)
      assert.deepEqual(script(), changed)
      assert.equal(getToolDraft(project.id)!.status, 'pending')
    }
    assert.deepEqual(references(), originalReferences)
  }
})

test('historical scene-only and prose-only episodes support full redesign without duplicating scenes', async () => {
  const { project, script, tools, source, sources, request } = await episodeFixture()
  run('DELETE FROM script_artifacts WHERE id=?', source.id)
  const instance = tools('episode', 'regenerate')
  await instance.execute('read_episode_scenes', { episode_number: 1, limit: 10 })
  await instance.execute('create_document_draft', request)
  const draft = getToolDraft(project.id)!
  await instance.execute('manage_document_draft', { operation: 'read' })
  await instance.execute('manage_document_draft', { operation: 'update', version: draft.version, changes: [{ document_id: draft.documents[0].id, base_version: draft.version, replacements: [{ find: request.artifacts[0].content, replace: '历史分集的新正文，确认前继续完善', reason: '补充新正文' }] }] })
  const updated = getToolDraft(project.id)!
  commitToolDraft(project.id, updated.id, updated.version, script)
  assert.deepEqual(script().scenes.filter(scene => scene.episode_number === 1).map(scene => scene.id), sources.map(scene => scene.id))
  assert.equal(script().artifacts!.filter(doc => doc.artifact_type === 'episode_script' && doc.episode_number === 1).length, 1)
  assert.equal(script().artifacts!.find(doc => doc.artifact_type === 'episode_script' && doc.episode_number === 1)!.content, '历史分集的新正文，确认前继续完善')
  const prose = await fixture(), proseSource = prose.script().artifacts!.find(doc => doc.artifact_type === 'episode_script')!, proseTools = prose.tools('episode', 'regenerate')
  await readAll(proseTools, [proseSource])
  const { source_scene_id: _source, ...newScene } = request.scenes[0]
  await proseTools.execute('create_document_draft', { ...request, scenes: [newScene] })
  const proseDraft = getToolDraft(prose.project.id)!
  commitToolDraft(prose.project.id, proseDraft.id, proseDraft.version, prose.script)
  assert.equal(prose.script().artifacts!.find(doc => doc.id === proseSource.id)!.content, request.artifacts[0].content)
  assert.equal(prose.script().scenes.length, 1)
})

test('native and JSON model paths over JSON and SSE return versioned selected-episode redesign drafts', async t => {
  for (const useTools of [true, false]) for (const suffix of ['', '/stream']) {
    const { project, script, source, sources, request, references } = await episodeFixture()
    const provider = await call('POST', '/api/providers', { name: '分集重设计模拟', base_url: 'https://episode-redesign.invalid/v1' })
    const model = await call('POST', '/api/models', { provider_id: provider.id, name: '文本模拟', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
    const before = script(), originalReferences = references()
    let turns = 0, intentCalls = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
      const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
      if (prompt.includes('本次独立调用只理解创作者意图')) {
        intentCalls++
        assert.match(prompt, /明确重做\/重新设计已保存单集用regenerate/)
        return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'draft', operation: 'regenerate', authorization: 'explicit', workflow: { stage: 'episode', episode_number: 1 }, creative_brief: '重新设计第一集的完整正文，保留镜头关联', settings_patch: {} }) } }] })
      }
      assert.match(prompt, /仅第 1 集正文/)
      assert.match(prompt, /source_scene_id/)
      turns++
      if (useTools) {
        const operation = turns === 1 ? { name: 'read_documents', arguments: { document_ids: [source.id], scene_limit: 10 } }
          : turns === 2 ? { name: 'create_document_draft', arguments: request } : null
        return Response.json({ choices: [{ message: operation ? { tool_calls: [{ id: `turn-${turns}`, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.arguments) } }] } : { content: '第一集重新设计草稿已准备，尚未保存。' }, finish_reason: operation ? 'tool_calls' : 'stop' }] })
      }
      assert.match(prompt, /本集重新设计的完整原文与场次/)
      for (const scene of sources) { assert.ok(prompt.includes(scene.id)); assert.ok(prompt.includes(scene.dialogue)) }
      assert.ok(prompt.includes(source.content))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ artifacts: request.artifacts, scenes: request.scenes }) }, finish_reason: 'stop' }] })
    })
    const payload = { model_id: model.id, mode: 'script', use_tools: useTools, messages: [{ role: 'assistant', text: '下一步可以生成第三集。' }, { role: 'user', text: '重新设计第一集完整正文和分场，别写第三集' }] }
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload })
    assert.equal(response.statusCode, 200, response.body)
    const done = suffix ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
    assert.ok(done?.tool_draft, response.body)
    assert.equal(done.draft, undefined, 'redesign cannot fall back to unversioned legacy save')
    assert.equal(done.tool_draft.workflow.operation, 'regenerate')
    assert.equal(done.tool_draft.workflow.episode_number, 1)
    assert.equal(done.tool_draft.documents[0].id, source.id)
    assert.equal(intentCalls, 1)
    assert.deepEqual(script(), before)
    assert.deepEqual(references(), originalReferences)
    const saved = await call('POST', `/api/projects/${project.id}/script/director/tool-drafts/${done.tool_draft.id}/commit`, { version: done.tool_draft.version, approved: true })
    assert.equal(saved.status, 'saved')
    assert.deepEqual(script().scenes.filter(scene => scene.episode_number === 1).map(scene => scene.id), sources.map(scene => scene.id))
    assert.deepEqual(references(), originalReferences)
    t.mock.restoreAll()
  }
})

test('JSON fallback rejects a source changed during generation and legacy save cannot bypass draft confirmation', async t => {
  const { project, script, source, request } = await episodeFixture()
  const before = script()
  const legacy = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/director/draft`, payload: { ...request, operation: 'regenerate' } })
  assert.equal(legacy.statusCode, 422)
  assert.match(legacy.body, /草稿确认保存/)
  assert.deepEqual(script(), before)
  const provider = await call('POST', '/api/providers', { name: '版本模拟', base_url: 'https://episode-conflict.invalid/v1' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const content = prompt.includes('本次独立调用只理解创作者意图')
      ? { action: 'draft', operation: 'regenerate', authorization: 'explicit', workflow: { stage: 'episode', episode_number: 1 }, creative_brief: '重设计第一集', settings_patch: {} }
      : { artifacts: request.artifacts, scenes: request.scenes }
    if (!prompt.includes('本次独立调用只理解创作者意图')) run('UPDATE script_artifacts SET content=? WHERE id=?', '生成期间作者自己修改的正文', source.id)
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: false, workflow: { stage: 'episode', episode_number: 1, operation: 'regenerate' }, messages: [{ role: 'user', text: '重设计第一集' }] } })
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /本集正文或场次已被修改/)
  assert.equal(getToolDraft(project.id), null)
  assert.equal(script().artifacts!.find(doc => doc.id === source.id)!.content, '生成期间作者自己修改的正文')
  assert.deepEqual(script().scenes, before.scenes)
})

test('unfinished stages and episode gaps are locked while saved stages remain available without resetting progress', async () => {
  assert.match(stageOperationError({}, { stage: 'locations', episode_number: 0 })!, /先完成并保存故事大纲/)
  assert.equal(stageOperationError({}, { stage: 'outline', episode_number: 0 }), null)
  const { script } = await fixture(true)
  assert.equal(workflowProgress(script()).next_episode, 2)
  assert.equal(stageOperationError(script(), { stage: 'locations', episode_number: 0, operation: 'regenerate' }), null)
  assert.equal(stageOperationError(script(), { stage: 'locations', episode_number: 0, operation: 'supplement' }), null)
  assert.equal(missingSavedStageArtifacts(script(), { stage: 'locations', episode_number: 0 }).length, 3)
  assert.match(stageOperationError(script(), { stage: 'episode', episode_number: 3 })!, /第 2 集/)
  assert.equal(stageOperationError(script(), { stage: 'episode', episode_number: 1, operation: 'revise' }), null)
})

test('all four project stages can be redesigned as complete reviewable drafts, preserving IDs and unrelated documents', async () => {
  for (const stage of ['outline', 'characters', 'locations', 'props'] as const) {
    const { project, script, tools } = await fixture()
    const before = script(), originals = before.artifacts!.filter(doc => scriptStageArtifacts[stage].includes(doc.artifact_type as never))
    const instance = tools(stage, 'regenerate')
    const request = { stage, artifacts: artifacts(stage, '新设计'), scenes: [] }
    await assert.rejects(instance.execute('create_document_draft', { ...request, artifacts: request.artifacts.slice(0, 1).map(({ status, ...doc }) => doc) }), /缺少完整文档/)
    request.artifacts = request.artifacts.map(({ status: _status, ...doc }) => doc) as typeof request.artifacts
    await assert.rejects(instance.execute('create_document_draft', request), /读完/)
    await readAll(instance, originals)
    await assert.rejects(instance.execute('create_document_draft', { ...request, artifacts: [...request.artifacts.slice(1), request.artifacts[1]] }), /阶段不一致/)
    await instance.execute('create_document_draft', request)
    const draft = getToolDraft(project.id)!
    assert.equal(draft.workflow!.operation, 'regenerate')
    assert.equal(draft.documents.length, scriptStageArtifacts[stage].length)
    assert.deepEqual(script(), before, 'no formal writes before confirmation')
    assert.deepEqual(draft.documents.map(doc => doc.id).sort(), originals.map(doc => doc.id).sort())
    assert.ok(draft.impacts!.some(impact => impact.title === '第一集'))
    const restored = getToolDraft(project.id, draft.id)!
    const edited = editToolDraft(project.id, restored.id, { version: restored.version, documents: [{ id: restored.documents[0].id, content: '作者确认前手动调整的新设计' }] })
    commitToolDraft(project.id, edited.id, edited.version, script)
    for (const original of before.artifacts!) {
      const saved = script().artifacts!.find(doc => doc.id === original.id)!
      if (originals.some(doc => doc.id === original.id)) assert.notEqual(saved.content, original.content)
      else assert.deepEqual(saved, original)
    }
    assert.equal(workflowProgress(script()).next_episode, 2)
  }
})

test('redesign rejects stale sources and discard leaves formal content intact', async () => {
  const { project, script, tools } = await fixture()
  const before = script(), instance = tools('outline', 'regenerate')
  await readAll(instance, before.artifacts!.filter(doc => scriptStageArtifacts.outline.includes(doc.artifact_type as never)))
  await instance.execute('create_document_draft', { stage: 'outline', artifacts: artifacts('outline', '重做').map(({ status, ...doc }) => doc), scenes: [] })
  const draft = getToolDraft(project.id)!
  run('UPDATE script_artifacts SET content=? WHERE id=?', '另一位作者的新版本', draft.documents[0].id)
  const changed = script()
  assert.throws(() => commitToolDraft(project.id, draft.id, draft.version, script), /已被修改/)
  assert.deepEqual(script(), changed, 'conflict causes no partial write')
  discardToolDraft(project.id, draft.id, draft.version)
  assert.deepEqual(script(), changed)
})

test('legacy supplementation adds missing sections and cannot silently rewrite saved prose through draft editing', async () => {
  const { project, script, tools } = await fixture(true)
  const before = script(), original = before.artifacts!.find(doc => doc.artifact_type === 'locations')!
  const instance = tools('locations', 'supplement')
  await readAll(instance, [original])
  await instance.execute('create_document_draft', { stage: 'locations', artifacts: artifacts('locations', '补齐').map(({ status, ...doc }) => doc.artifact_type === 'locations' ? { ...doc, content: original.content, title: original.title } : doc), scenes: [] })
  const draft = getToolDraft(project.id)!
  assert.throws(() => editToolDraft(project.id, draft.id, { version: draft.version, documents: [{ id: original.id, content: '试图覆盖原设计' }] }), /不能改写/)
  assert.equal(getToolDraft(project.id)!.version, draft.version)
  commitToolDraft(project.id, draft.id, draft.version, script)
  assert.deepEqual(script().artifacts!.find(doc => doc.id === original.id), original)
  for (const doc of before.artifacts!) assert.deepEqual(script().artifacts!.find(item => item.id === doc.id), doc)
  assert.equal(missingSavedStageArtifacts(script(), { stage: 'locations', episode_number: 0 }).length, 0)
})

test('natural-language redesign resolves the old stage before tools over JSON and SSE; typed selection bypasses interpretation', async t => {
  for (const suffix of ['', '/stream']) {
    const { project, script } = await fixture(true)
    const provider = await call('POST', '/api/providers', { name: '意图模拟', base_url: 'https://stage-reprocess.invalid/v1' })
    const model = await call('POST', '/api/models', { provider_id: provider.id, name: '模拟文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
    const before = script(), original = before.artifacts!.find(doc => doc.artifact_type === 'locations')!
    let intentCalls = 0, turns = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const completenessReply = draftCompletenessFixtureResponse(init); if (completenessReply) return completenessReply
      const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content
      if (prompt.includes('本次独立调用只理解创作者意图')) {
        intentCalls++
        return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'draft', operation: 'regenerate', authorization: 'explicit', workflow: { stage: 'locations' }, creative_brief: '重新设计四份全剧场景资料，禁止分集正文', settings_patch: {} }) } }] })
      }
      assert.match(prompt, /"stage":"locations","episode_number":null,"mode":"explicit"/)
      assert.match(prompt, /"operation":"regenerate"/)
      assert.doesNotMatch(prompt, /以下是当前阶段的内容标准[^]*只写第 2 集/)
      turns++
      const operation = turns === 1 ? { name: 'read_documents', arguments: { document_ids: [original.id] } }
        : turns === 2 ? { name: 'create_document_draft', arguments: { stage: 'locations', artifacts: artifacts('locations', '全新车站设计').map(({ status, ...doc }) => doc), scenes: [] } } : null
      return Response.json({ choices: [{ message: operation ? { tool_calls: [{ id: `turn-${turns}`, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.arguments) } }] } : { content: '场景设计草稿已准备，尚未保存。' }, finish_reason: operation ? 'tool_calls' : 'stop' }] })
    })
    const payload = { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'assistant', text: '下一步可生成第2集正文。' }, { role: 'user', text: '重新设计全剧场景，只要场景设计，别写第二集' }] }
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload })
    assert.equal(response.statusCode, 200, response.body)
    const done = suffix ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
    assert.equal(done.tool_draft.documents.length, 4)
    assert.equal(done.stage_context.stage, 'locations')
    assert.equal(intentCalls, 1)
    assert.deepEqual(script(), before)
    discardToolDraft(project.id, done.tool_draft.id, done.tool_draft.version)
    turns = 0
    const typed = await call('POST', `/api/projects/${project.id}/script/director/chat`, { ...payload, workflow: { stage: 'locations', operation: 'regenerate' } })
    assert.equal(typed.tool_draft.workflow.operation, 'regenerate')
    assert.equal(intentCalls, 1, 'a typed target is not reinterpreted by the model')
    t.mock.restoreAll()
  }
})

test('API refuses a typed future-stage generation before any provider call', async t => {
  const project = await call('POST', '/api/projects', { name: '空项目' })
  const provider = await call('POST', '/api/providers', { name: '锁定模拟', base_url: 'https://locked.invalid/v1' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not run') })
  for (const suffix of ['', '/stream']) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload: { model_id: model.id, mode: 'script', use_tools: true, workflow: { stage: 'locations' }, messages: [{ role: 'user', text: '先生成场景' }] } })
    assert.match(response.body, /请先完成并保存故事大纲/)
  }
  assert.equal(calls, 0)
})

test('stage operation survives persisted execution records and cannot weaken whole-stage output into a patch', async () => {
  const { project, script, tools } = await fixture()
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'stage-task', label: '重做场景', messages: [{ role: 'user', text: '重新设计场景' }, {
    role: 'assistant', text: '场景草稿准备中', reply_metadata: { execution: { title: '重新设计场景', request: '重新设计场景', started_at: 1, workflow: { stage: 'locations', scope: 'project', episode_number: 0, operation: 'regenerate' } } },
  }] })
  const restored = await call('GET', `/api/projects/${project.id}/script/conversations`)
  assert.equal(restored.conversations[0].messages[1].execution.workflow.operation, 'regenerate')
  const instance = tools('locations', 'regenerate')
  const source = script().artifacts!.find(doc => doc.artifact_type === 'locations')!
  const read = await instance.execute('read_documents', { document_ids: [source.id] }) as any
  await assert.rejects(instance.execute('propose_document_patch', { summary: '只改主文档', changes: [{ document_id: source.id, base_version: read.documents[0].version, replacements: [{ find: source.content, replace: '只有一份新文档', reason: '重做' }] }] }), /完整阶段草稿/)
  assert.equal(getToolDraft(project.id), null)
})
