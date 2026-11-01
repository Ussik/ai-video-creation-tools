import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts, type StageArtifactType } from '@video-studio/shared/script/script-stage-content'
import type { Project, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const directory = await mkdtemp(join(tmpdir(), 'script-work-contract-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, one, run } = await import('../src/infrastructure/database/db.js')
const { documentTools, getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
assert.equal(db.name, join(directory, 'studio.db'), 'work-contract integration must use its own temporary database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project: Project = await api('POST', '/api/projects', { name: '分项创作合同集成验证' })
  const provider = await api('POST', '/api/providers', { name: '离线合同模型', base_url: 'https://work-contract-fixture.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '分项创作', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions',
    settings: { stream: false, request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const script = (): ScriptSnapshot => {
    const row = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', project.id)
    return { outline: row?.outline || '', characters: row?.characters || '', generation_options: JSON.parse(row?.generation_options || '{}'),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', project.id),
      scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', project.id) }
  }
  const formal = () => ({ script: script(),
    source: all('SELECT filename,content FROM script_source_documents WHERE project_id=?', project.id),
    revisions: all('SELECT * FROM script_source_revisions WHERE project_id=?', project.id),
  })
  const chat = (workflow = { stage: 'outline', intent: 'stage_design' }, useTools = true) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`,
    payload: { model_id: model.id, mode: 'script', use_tools: useTools, workflow,
      messages: [{ role: 'user', text: '按已约定范围完成完整设计资料包，保留所有已有文档；生成后先给我预览。' }] } })
  const tools = (taskContract?: Parameters<typeof documentTools>[0]['taskContract']) => documentTools({ project, script,
    stage: directorStageContext(script(), { explicit: { stage: 'outline', episode_number: 0 } }), workflow: 'outline',
    taskContract, messages: [{ role: 'user', text: '只生成这次约定的大纲草稿，先预览。' }], checkApproval: async () => false, onEvent: () => {} })
  return { project, model, script, formal, chat, tools }
}
const artifact = (type: StageArtifactType) => ({ artifact_type: type, title: `${scriptArtifactLabels[type]}草案`,
  content: `${scriptArtifactLabels[type]}：林舟拿到钥匙，调查旧约，面对失去记忆的代价，最后按约归还钥匙。` })
function wireTypes(body: any): StageArtifactType[] {
  const contract = body.response_format?.json_schema
  assert.equal(contract?.name, 'workflow_draft', 'generation must use the typed subtask envelope')
  const type = contract.schema.properties.artifacts.items.properties.artifact_type
  return type.enum || [type.const]
}
function response(types: StageArtifactType[]) {
  return Response.json({ choices: [{ message: { content: JSON.stringify({ artifacts: types.map(artifact), scenes: [] }) }, finish_reason: 'stop' }] })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('the real stage-design route executes five dependent groups, runs independent groups together and saves only after confirmation', { timeout: 10000 }, async t => {
  const f = await fixture()
  await api('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [
    { artifact_type: 'characters', title: '已确认人物', content: '林舟是一名返乡记者，人物身份保持不变。', episode_number: 0, status: 'ready' },
  ] })
  const before = f.formal(), narrativeStarted = deferred(), worldStarted = deferred(), release = deferred()
  const groups: StageArtifactType[][] = [], finished = new Set<string>()
  let reviews = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /work-contract-fixture\.invalid/)
    const review = draftCompletenessFixtureResponse(init)
    if (review) { reviews++; return review }
    const body = JSON.parse(String(init?.body)), types = wireTypes(body)
    groups.push(types)
    assert.equal(body.tools, undefined, 'typed subtasks need no extra model-led tool loop')
    if (types.includes('synopsis')) { assert.ok(finished.has('outline')); narrativeStarted.resolve(); await release.promise }
    if (types.includes('world')) { assert.ok(finished.has('outline')); worldStarted.resolve(); await release.promise }
    if (types.includes('hooks')) { assert.ok(finished.has('structure')); assert.ok(finished.has('constraints')) }
    if (types.includes('episode_outline')) assert.ok(finished.has('reversals'))
    types.forEach(type => finished.add(type))
    return response(types)
  })
  const pending = f.chat()
  try {
    await Promise.all([narrativeStarted.promise, worldStarted.promise])
    assert.deepEqual([...finished], ['outline'], 'both branches start while neither independent branch has completed')
    assert.deepEqual(f.formal(), before, 'running subtasks cannot change accepted documents or the manuscript')
  } finally { release.resolve() }
  const generated = await pending
  assert.equal(generated.statusCode, 200, generated.body)
  const value = generated.json()
  assert.deepEqual(groups, [['outline'], ['synopsis', 'structure'], ['world', 'constraints'], ['hooks', 'foreshadowing', 'reversals'], ['episode_outline']])
  assert.equal(reviews, 1)
  assert.equal(value.tool_draft.status, 'pending')
  assert.equal(value.workflow.intent, 'stage_design')
  assert.deepEqual(value.tool_draft.documents.map((doc: any) => doc.artifact_type), [...scriptStageArtifacts.outline])
  const previews = value.activity.filter((entry: any) => entry.artifact_preview).map((entry: any) => entry.artifact_preview)
  assert.equal(previews.length, 5)
  assert.equal(previews.flatMap((preview: any) => preview.artifacts).length, 9)
  assert.deepEqual(f.formal(), before, 'a fully generated and reviewed preview still cannot write formal data')
  await api('POST', `/api/projects/${f.project.id}/script/director/tool-drafts/${value.tool_draft.id}/commit`, { version: value.tool_draft.version, approved: true })
  const accepted = f.script().artifacts!
  assert.equal(accepted.filter(doc => scriptStageArtifacts.outline.includes(doc.artifact_type as any)).length, 9)
  assert.deepEqual(accepted.find(doc => doc.artifact_type === 'characters'), before.script.artifacts!.find(doc => doc.artifact_type === 'characters'))
})

test('the real supplement route generates seven missing documents and preserves every saved title and prose byte through preview and save', async t => {
  const f = await fixture()
  await api('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [
    { artifact_type: 'outline', title: '作者已确认的大纲', content: '林舟返乡，调查旧约，结局归还钥匙。', episode_number: 0, status: 'ready' },
    { artifact_type: 'synopsis', title: '原有故事简述', content: '钥匙原属故友；林舟查清来历后主动归还。', episode_number: 0, status: 'ready' },
  ] })
  // Historical documents may contain whitespace from earlier editors. It is
  // part of the accepted manuscript, not permission to normalize saved prose.
  run("UPDATE script_artifacts SET title=?,content=? WHERE project_id=? AND artifact_type='outline'", '作者已确认的大纲  ', '林舟返乡。\n\n调查旧约，结局归还钥匙。\n  ', f.project.id)
  const before = f.formal(), generatedTypes: StageArtifactType[] = [], groups: StageArtifactType[][] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /work-contract-fixture\.invalid/)
    const review = draftCompletenessFixtureResponse(init)
    if (review) return review
    const body = JSON.parse(String(init?.body)), types = wireTypes(body)
    assert.ok(!types.includes('outline'))
    assert.ok(!types.includes('synopsis'))
    groups.push(types); generatedTypes.push(...types)
    return response(types)
  })
  const generated = await f.chat({ stage: 'outline', intent: 'stage_design', operation: 'supplement' } as any)
  assert.equal(generated.statusCode, 200, generated.body)
  const value = generated.json()
  assert.equal(groups.length, 4)
  assert.equal(generatedTypes.length, 7)
  for (const original of before.script.artifacts!) {
    const preview = value.tool_draft.documents.find((doc: any) => doc.artifact_type === original.artifact_type)
    assert.equal(preview.title, original.title)
    assert.equal(preview.content, original.content)
  }
  assert.deepEqual(f.formal(), before)
  await api('POST', `/api/projects/${f.project.id}/script/director/tool-drafts/${value.tool_draft.id}/commit`, { version: value.tool_draft.version, approved: true })
  for (const original of before.script.artifacts!) assert.deepEqual(f.script().artifacts!.find(doc => doc.id === original.id), original)
  assert.equal(f.script().artifacts!.length, 9)
})

test('JSON supplement preserves historical bytes in its preview and formal save, and refuses changes to accepted prose', async t => {
  const f = await fixture()
  await api('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [
    { artifact_type: 'outline', title: '已确认主线', content: '林舟返乡，调查旧约，归还钥匙。', episode_number: 0, status: 'ready' },
    { artifact_type: 'synopsis', title: '已确认故事简述', content: '钥匙来自故友；林舟查明来历后归还。', episode_number: 0, status: 'ready' },
  ] })
  run("UPDATE script_artifacts SET title=?,content=? WHERE project_id=? AND artifact_type='outline'", '已确认主线  ', '\n林舟返乡。\n\n调查旧约，归还钥匙。\n  ', f.project.id)
  run("UPDATE script_artifacts SET title=?,content=? WHERE project_id=? AND artifact_type='synopsis'", '已确认故事简述\t', '  钥匙来自故友；林舟查明来历后归还。\n', f.project.id)
  const before = f.formal(), generatedTypes: StageArtifactType[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const review = draftCompletenessFixtureResponse(init)
    if (review) return review
    const types = wireTypes(JSON.parse(String(init?.body)))
    generatedTypes.push(...types)
    assert.ok(!types.includes('outline') && !types.includes('synopsis'))
    return response(types)
  })
  const generated = await f.chat({ stage: 'outline', intent: 'stage_design', operation: 'supplement' } as any, false)
  assert.equal(generated.statusCode, 200, generated.body)
  const value = generated.json()
  assert.equal(generatedTypes.length, 7)
  for (const original of before.script.artifacts!) {
    const preview = value.draft.artifacts.find((doc: any) => doc.artifact_type === original.artifact_type)
    assert.equal(preview.title, original.title)
    assert.equal(preview.content, original.content)
  }
  assert.deepEqual(f.formal(), before, 'generation does not save formal documents')
  const tampered = structuredClone(value.draft)
  tampered.artifacts.find((doc: any) => doc.artifact_type === 'outline').content = '新写主线，覆盖既有剧情。'
  const refused = await app.inject({ method: 'PUT', url: `/api/projects/${f.project.id}/script/director/draft`, payload: tampered })
  assert.equal(refused.statusCode, 422, refused.body)
  assert.match(refused.body, /补齐.*不能改写/)
  assert.deepEqual(f.formal(), before, 'a rejected supplement cannot partially save its new documents')
  await api('PUT', `/api/projects/${f.project.id}/script/director/draft`, value.draft)
  for (const original of before.script.artifacts!) assert.deepEqual(f.script().artifacts!.find(doc => doc.id === original.id), original)
  assert.equal(f.script().artifacts!.length, 9)
})

for (const useTools of [true, false]) {
  test(`${useTools ? 'tool' : 'JSON'} supplement accepts the exact eight missing outline sections without touching the saved outline record`, async t => {
    const f = await fixture()
    await api('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [
      { artifact_type: 'outline', title: '作者已确认的故事大纲', content: '林舟返乡，调查旧约，归还钥匙。', episode_number: 0, status: 'ready' },
    ] })
    run("UPDATE script_artifacts SET title=?,content=?,created_at=?,updated_at=? WHERE project_id=? AND artifact_type='outline'",
      '作者已确认的故事大纲  ', '\n林舟返乡。\n\n调查旧约，归还钥匙。\n  ', '2026-01-01T01:02:03.000Z', '2026-02-02T04:05:06.000Z', f.project.id)
    const before = f.formal(), original = before.script.artifacts![0]!
    const missing = scriptStageArtifacts.outline.filter(type => type !== 'outline')
    const generatedTypes: StageArtifactType[] = [], groups: StageArtifactType[][] = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.match(String(url), /work-contract-fixture\.invalid/)
      const review = draftCompletenessFixtureResponse(init)
      if (review) return review
      const types = wireTypes(JSON.parse(String(init?.body)))
      assert.ok(types.every(type => missing.includes(type as typeof missing[number])), 'only explicitly requested missing sections may be generated')
      groups.push(types); generatedTypes.push(...types)
      return response(types)
    })
    const generated = await f.chat({ stage: 'outline', episode_number: 0, operation: 'supplement', intent: 'stage_design', artifact_types: missing } as any, useTools)
    assert.equal(generated.statusCode, 200, generated.body)
    const value = generated.json()
    assert.equal(groups.length, 4)
    assert.equal(generatedTypes.length, 8)
    assert.deepEqual([...generatedTypes].sort(), [...missing].sort(), 'every missing section is generated exactly once')
    const preview = useTools ? value.tool_draft.documents : value.draft.artifacts
    assert.deepEqual(preview.map((doc: any) => doc.artifact_type), missing, 'the preview retains the exact selected supplement scope')
    assert.deepEqual(f.formal(), before, 'generating and reviewing all eight sections cannot save formal data')
    if (useTools) {
      await api('POST', `/api/projects/${f.project.id}/script/director/tool-drafts/${value.tool_draft.id}/commit`, { version: value.tool_draft.version, approved: true })
    } else {
      await api('PUT', `/api/projects/${f.project.id}/script/director/draft`, value.draft)
    }
    const accepted = f.script()
    assert.equal(accepted.artifacts!.length, 9)
    assert.deepEqual(accepted.artifacts!.map(doc => doc.artifact_type).sort(), [...scriptStageArtifacts.outline].sort())
    assert.deepEqual(accepted.artifacts!.find(doc => doc.id === original.id), original, 'saving the supplement preserves the accepted outline ID, title, prose and timestamps byte for byte')
    assert.equal(accepted.outline, before.script.outline, 'the legacy outline field also retains the accepted text')
  })
}

test('a model cannot invent a narrower task contract when only whole-stage generation was authorized', async () => {
  const f = await fixture(), before = f.formal()
  await assert.rejects(f.tools().execute('create_document_draft', { stage: 'outline', intent: 'source_outline', artifact_types: ['outline'],
    artifacts: [artifact('outline')], scenes: [] }), /尚未明确分项成果范围/)
  assert.equal(getToolDraft(f.project.id), null)
  assert.deepEqual(f.formal(), before)
})

test('a server-selected single-outline contract rejects model changes to intent, deliverables and extra artifact bodies', async () => {
  const f = await fixture(), before = f.formal()
  const tools = f.tools({ intent: 'source_outline', artifact_types: ['outline'] })
  const candidate = { stage: 'outline', artifacts: [artifact('outline')], scenes: [] }
  await assert.rejects(tools.execute('create_document_draft', { ...candidate, intent: 'stage_design' }), /不能改变.*任务类型/)
  await assert.rejects(tools.execute('create_document_draft', { ...candidate, artifact_types: ['outline', 'world'] }), /不能改变.*成果范围/)
  await assert.rejects(tools.execute('create_document_draft', { ...candidate, artifact_types: ['world'] }), /不能改变.*成果范围/)
  await assert.rejects(tools.execute('create_document_draft', { ...candidate, artifacts: [...candidate.artifacts, artifact('world')] }), /超出本次约定/)
  assert.equal(getToolDraft(f.project.id), null)
  assert.deepEqual(f.formal(), before)
  const accepted = await tools.execute('create_document_draft', candidate) as { saved: boolean }
  assert.equal(accepted.saved, false)
  assert.deepEqual(getToolDraft(f.project.id)!.documents.map(doc => doc.artifact_type), ['outline'])
  assert.deepEqual(f.formal(), before)
})

test('a server-selected full-design contract cannot be narrowed to only its first document', async () => {
  const f = await fixture(), before = f.formal()
  const tools = f.tools({ intent: 'stage_design', artifact_types: [...scriptStageArtifacts.outline] })
  await assert.rejects(tools.execute('create_document_draft', { stage: 'outline', artifact_types: ['outline'], artifacts: [artifact('outline')], scenes: [] }), /不能改变.*成果范围/)
  await assert.rejects(tools.execute('create_document_draft', { stage: 'outline', artifacts: [artifact('outline')], scenes: [] }), /缺少完整文档/)
  assert.equal(getToolDraft(f.project.id), null)
  assert.deepEqual(f.formal(), before)
})
