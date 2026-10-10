import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Project, ScriptArtifact, ScriptScene } from '../src/db.js'
import type { ScriptSnapshot } from '../src/script-document-tools.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-resource-tools-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, all, one, run } = await import('../src/db.js')
const { documentTools, getToolDraft, commitToolDraft, editToolDraft } = await import('../src/script-document-tools.js')
const { directorStageContext } = await import('../src/script-workflow.js')
const { documentHealth } = await import('../src/script-document-review.js')
const { projectDocuments } = await import('../src/script-document-tools.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call<T = any>(method: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, 200, response.body); return response.json()
}
async function fixture() {
  const project = await call<Project>('POST', '/api/projects', { name: '视觉与分镜对话测试' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '雨夜车站', characters: '林晚', action: '林晚追查失踪案', duration: 8 })
  const script = (): ScriptSnapshot => ({ outline: '', characters: '', generation_options: {}, artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', project.id), scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', project.id) })
  const tools = (extra: Partial<Parameters<typeof documentTools>[0]> = {}) => documentTools({ project, script, stage: directorStageContext(script()), messages: [{ role: 'user', text: '请修改林晚的视觉设定，整理这些分镜' }], onEvent: () => {}, checkApproval: async () => true, authorizeResource: async () => true, ...extra })
  return { project, scene, script, tools }
}
const value = { kind: 'character', name: '林晚', variant: '雨衣', definition: '黑发，墨绿雨衣，记者', view_requirements: '正侧背、面部、服装细节', scene_ids: [] }
const shot = { title: '林晚走进车站', prompt: '林晚进入雨夜车站', image_prompt: '单幅首帧：林晚在门口', video_prompt: '林晚向前走，镜头缓慢跟随', duration: 8 }

test('visual profile proposals are reviewable and stale versions reject the entire save', async () => {
  const f = await fixture(), first = f.tools()
  await first.execute('propose_visual_profile_draft', { summary: '新增林晚信息图设定', profiles: [{ profile: { ...value, scene_ids: [f.scene.id] } }] })
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
  const draft = getToolDraft(f.project.id)!
  assert.equal(draft.kind, 'resource'); assert.equal(draft.resource_changes!.length, 1)
  commitToolDraft(f.project.id, draft.id, draft.version, f.script)
  const profile = one<any>('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id)!
  assert.equal(profile.definition, value.definition)
  const tool = f.tools(), read = await tool.execute('read_visual_profiles', { profile_ids: [profile.id] }) as any
  await tool.execute('propose_visual_profile_draft', { summary: '补充细节', profiles: [{ profile_id: profile.id, base_version: read.profiles[0].version, profile: { ...value, definition: '黑发，墨绿雨衣，记者；银色扣子' } }] })
  const pending = getToolDraft(f.project.id)!
  assert.match(one<any>('SELECT * FROM visual_profiles WHERE id=?', profile.id).definition, /^黑发，墨绿雨衣，记者$/)
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, definition: '用户手动调整后的设定' })
  assert.throws(() => commitToolDraft(f.project.id, pending.id, pending.version, f.script), /原文已变化/)
  assert.equal(getToolDraft(f.project.id)!.status, 'pending')
})

test('reference tools show actual missing images and binding drafts respect project scope and snapshots', async () => {
  const f = await fixture(), other = await fixture()
  const data = await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [value] }), profile = data.visual_profiles[0]
  const foreign = (await call('POST', `/api/projects/${other.project.id}/visual-profiles`, { profiles: [value] })).visual_profiles[0]
  const tool = f.tools()
  await assert.rejects(tool.execute('read_visual_profiles', { profile_ids: [foreign.id] }), /当前项目/)
  const read = await tool.execute('read_visual_profiles', { profile_ids: [profile.id] }) as any
  assert.equal(read.profiles[0].reference_status, 'missing'); assert.equal(read.profiles[0].actual_image_inspected, false)
  const context = await tool.execute('get_storyboard_context', { scene_ids: [f.scene.id] }) as any
  await tool.execute('propose_visual_binding_patch', { summary: '此场需要林晚参考图', targets: [{ target_type: 'scene', target_id: f.scene.id, base_version: context.objects[0].binding_version, bindings: [{ profile_id: profile.id, required: true }] }] })
  assert.equal(all('SELECT * FROM scene_visual_bindings WHERE scene_id=?', f.scene.id).length, 0)
  const draft = getToolDraft(f.project.id)!
  commitToolDraft(f.project.id, draft.id, draft.version, f.script)
  assert.equal(all('SELECT * FROM scene_visual_bindings WHERE scene_id=?', f.scene.id).length, 1)
})

test('shot plans preserve source IDs, support preview edits and cannot duplicate on repeated confirmation', async () => {
  const f = await fixture(), tools = f.tools()
  const context = await tools.execute('get_storyboard_context', { scene_ids: [f.scene.id] }) as any
  await tools.execute('propose_shot_plan', { summary: '拆成一个建立镜头', scenes: [{ scene_id: f.scene.id, base_version: context.objects[0].version, shots: [shot] }] })
  const draft = getToolDraft(f.project.id)!, change = draft.resource_changes![0]
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
  const edited = editToolDraft(f.project.id, draft.id, { version: draft.version, documents: [], resource_values: [{ index: 0, value: { ...change.value as object, video_prompt: '林晚缓慢迈入，镜头从背后跟拍' } }] })
  assert.notEqual(edited.version, draft.version)
  assert.throws(() => commitToolDraft(f.project.id, draft.id, draft.version, f.script), /重新确认/)
  commitToolDraft(f.project.id, draft.id, edited.version, f.script)
  const saved = one<any>('SELECT * FROM shots WHERE project_id=?', f.project.id)!
  assert.equal(saved.source_scene_id, f.scene.id); assert.equal(saved.image_prompt, shot.image_prompt); assert.match(saved.video_prompt, /背后跟拍/)
  assert.throws(() => commitToolDraft(f.project.id, draft.id, edited.version, f.script), /重新确认/)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 1)
  const patcher = f.tools(), original = await patcher.execute('get_storyboard_context', { shot_ids: [saved.id], limit: 10 }) as any
  const actual = original.objects.find((item: any) => item.type === 'shot')
  await patcher.execute('propose_shot_patch', { summary: '补充收镜', shots: [{ shot_id: saved.id, base_version: actual.version, changes: { end_state: '林晚停在候车室中央' } }] })
  const revised = getToolDraft(f.project.id)!
  commitToolDraft(f.project.id, revised.id, revised.version, f.script)
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', saved.id).end_state, '林晚停在候车室中央')
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', saved.id).image_prompt, shot.image_prompt)
})

test('read-before-write, explicit intent, selected document scope and discussion-only apply to resource tools', async () => {
  const f = await fixture()
  await assert.rejects(f.tools({ authorizeResource: async () => false }).execute('propose_visual_profile_draft', { summary: '未经要求创建', profiles: [{ profile: value }] }), /尚未明确要求/)
  await assert.rejects(f.tools({ discussionOnly: true }).execute('propose_visual_profile_draft', { summary: '创建', profiles: [{ profile: value }] }), /只讨论/)
  await call('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [{ artifact_type: 'characters', title: '人物', content: '林晚记者。' }] })
  const doc = f.script().artifacts![0]
  await assert.rejects(f.tools({ action: { operation: 'revise', document_ids: [doc.id] } }).execute('propose_visual_profile_draft', { summary: '创建', profiles: [{ profile: value }] }), /文档范围/)
  await assert.rejects(f.tools().execute('propose_shot_plan', { summary: '拆镜', scenes: [{ scene_id: f.scene.id, base_version: 'guess', shots: [shot] }] }), /变化/)
  assert.equal(getToolDraft(f.project.id), null)
  await f.tools().execute('propose_visual_profile_draft', { summary: '创建视觉设定', profiles: [{ profile: value }] })
  const draft = getToolDraft(f.project.id)!, scoped = f.tools({ action: { operation: 'revise', document_ids: [doc.id] } })
  await assert.rejects(scoped.execute('manage_document_draft', { operation: 'discard', draft_id: draft.id, version: draft.version }), /范围/)
  await assert.rejects(scoped.execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /范围/)
  assert.equal(getToolDraft(f.project.id)!.status, 'pending')
})

test('professional review requires complete source evidence and becomes stale after edits', async () => {
  const f = await fixture()
  await call('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [{ artifact_type: 'characters', title: '人物设定', content: '林晚：身份待定。\n陈默：医生。' }] })
  const doc = f.script().artifacts![0], tools = f.tools()
  const read = await tools.execute('read_documents', { document_ids: [doc.id], length: 5 }) as any
  const report = { summary: '林晚职业尚未明确', documents: [{ id: doc.id, version: read.documents[0].version }], findings: [{ document_id: doc.id, document_version: read.documents[0].version,
    category: 'pending', severity: 'warning', quote: '林晚：身份待定。', explanation: '职业影响调查权限和人物行动', suggestion: '明确为调查记者', related: [] }] }
  await assert.rejects(tools.execute('submit_document_review', report), /读完/)
  await tools.execute('read_documents', { document_ids: [doc.id] })
  await assert.rejects(tools.execute('submit_document_review', { ...report, findings: [{ ...report.findings[0], quote: '原文没有这个设定' }] }), /证据/)
  await tools.execute('submit_document_review', report)
  assert.equal(documentHealth(f.project.id, projectDocuments(f.project.id, f.script()))[0].findings.length, 1)
  assert.equal(f.script().artifacts![0].content, doc.content)
  await call('PATCH', `/api/script-artifacts/${doc.id}`, { content: '林晚：调查记者。\n陈默：医生。' })
  assert.equal(documentHealth(f.project.id, projectDocuments(f.project.id, f.script()))[0].status, 'stale')
  await call('DELETE', `/api/projects/${f.project.id}`)
  assert.equal(all('SELECT * FROM script_document_reviews WHERE project_id=?', f.project.id).length, 0)
})

test('native missed questions stay unclassified, and asset prompts do not persist explanatory bilingual text', async t => {
  const f = await fixture(), provider = await call('POST', '/api/providers', { name: '本地测试', base_url: 'https://mock.invalid' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '自定义模型', remote_id: 'anything', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  let native = true
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const content = native ? '方案一：记者调查。方案二：医生追查。你选择哪个？' : JSON.stringify({ prompt_zh: '林晚人物信息图，黑发墨绿雨衣', prompt_en: 'Character design board for Lin Wan', notes: '尚需核实年龄' })
    if (!native) assert.match(body.messages[0].content, /prompt_zh/)
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] })
  })
  const result = await call('POST', `/api/projects/${f.project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '讨论故事方向' }] })
  assert.equal(result.classification, undefined); assert.equal(result.classification_version, undefined); assert.equal(result.completion_kind, 'explanation')
  native = false
  const bundle = await call('POST', `/api/projects/${f.project.id}/script/director/asset-prompt`, { model_id: model.id, focus_artifact: 'character', messages: [{ role: 'user', text: '确认林晚记者形象' }] })
  assert.equal(bundle.prompt_zh, '林晚人物信息图，黑发墨绿雨衣'); assert.equal(bundle.notes, '尚需核实年龄')
  const task = await call('POST', `/api/projects/${f.project.id}/asset-tasks`, { focus_artifact: 'character', prompt: bundle.prompt_zh })
  assert.equal(task.prompt, bundle.prompt_zh); assert.doesNotMatch(task.prompt, /Character|尚需核实/)
})

test('native interaction provenance and structured professional reviews survive conversation storage', async () => {
  const f = await fixture()
  const classification = { type: 'choice_request', status: 'pending', interaction: { stage: 'characters', purpose: 'setting' }, question: '职业？', options: [{ id: 'a', title: '记者', text: '调查记者' }, { id: 'b', title: '医生', text: '医生' }] }
  const review = { id: 'review-roundtrip', created_at: new Date().toISOString(), summary: '需确认职业', documents: [{ id: 'source', version: 'v1' }], findings: [{ document_id: 'source', document_version: 'v1', category: 'pending', severity: 'warning', quote: '身份待定', explanation: '影响调查权限', suggestion: '明确职业', related: [] }] }
  const url = `/api/projects/${f.project.id}/script/conversations`
  const execution = { title: '评审项目文档', request: '评审林晚职业', started_at: Date.now(), focus_artifact: 'all', mode: 'script', targets: ['全剧人物设定'], document_action: { operation: 'review', document_ids: ['source'] }, outcome: { kind: 'review', summary: '评审已完成，整理了 1 项建议。' } }
  const activity = [{ id: 'read-target', kind: 'tool', name: 'read_documents', label: '阅读项目文档', summary: '已读取人物设定', status: 'succeeded', started_at: Date.now(), targets: [{ kind: 'document', id: 'source', title: '全剧人物设定' }], output: '截断内容', output_truncated: true }]
  await call('PUT', url, { id: 'metadata-history', messages: [{ id: 'assistant-review', role: 'assistant', text: '请确认职业', activity, reply_metadata: { classification, classification_version: 8, classification_context: '[]', classification_source: 'function_call', review, execution } }] })
  let restored = (await call('GET', url)).conversations[0].messages[0]
  assert.equal(restored.classification_source, 'function_call'); assert.deepEqual(restored.review, review)
  assert.deepEqual(restored.execution, execution); assert.deepEqual(restored.activity, activity)
  await call('PUT', url, { id: 'metadata-history', messages: [{ id: 'assistant-review', role: 'assistant', text: '请确认职业', activity, reply_metadata: { classification, classification_version: 8, classification_context: '[]', classification_source: 'function_call', review, execution } }, { role: 'user', text: '选择记者' }] })
  restored = (await call('GET', url)).conversations[0].messages[0]
  assert.equal(restored.classification, undefined, 'answered native question enters contextual recognition instead of restoring pending state')
  assert.deepEqual(restored.review, review)
  assert.deepEqual(restored.execution, execution); assert.deepEqual(restored.activity, activity)
})

test('resource edits reject invalid indices and duplicate names and can remove a refreshed binding', async () => {
  const { editResourceValues } = await import('../src/script-resource-tools.js')
  const change = { type: 'visual_binding' as const, id: 'shot', title: '镜头', target_type: 'shot' as const, base_version: 'v', original: [], value: [{ profile_id: 'profile', required: true }], refresh_profile_ids: ['profile'] }
  assert.deepEqual((editResourceValues([change], [{ index: 0, value: [] }])[0] as typeof change).refresh_profile_ids, [])
  assert.throws(() => editResourceValues([change], [{ index: 1, value: [] }]), /当前草稿对象/)
  assert.throws(() => editResourceValues([change], [{ index: 0, value: [] }, { index: 0, value: [] }]), /重复编辑/)
  const f = await fixture()
  await f.tools().execute('propose_visual_profile_draft', { summary: '两个角色', profiles: [{ profile: value }, { profile: { ...value, name: '陈默' } }] })
  const draft = getToolDraft(f.project.id)!
  assert.throws(() => editToolDraft(f.project.id, draft.id, { version: draft.version, documents: [], resource_values: [{ index: 1, value: draft.resource_changes![0].value }] }), /不能重复提交/)
  assert.equal(getToolDraft(f.project.id)!.version, draft.version)
})
