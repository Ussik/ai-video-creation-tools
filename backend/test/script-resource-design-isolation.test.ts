import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResourceChange } from '@video-studio/shared/script/script-resource-types'
import type { ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'

const directory = await mkdtemp(join(tmpdir(), 'script-resource-design-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { resourceTools, validateResourceChanges, applyResourceChanges } = await import('../src/modules/script/script-resource-tools.js')
const { inheritSceneVisualBindings } = await import('../src/modules/visuals/visual-profiles.js')
const { documentTools, scriptFunctions, getToolDraft, commitToolDraft, editToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const { strictJsonSchema } = await import('../src/modules/generation/model-output.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call(method: 'POST', url: string, payload: unknown): Promise<any> {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const profileValue = { kind: 'character', name: '林晚', variant: '雨衣', definition: '黑发、墨绿雨衣', view_requirements: '正侧背与服装细节', scene_ids: [] as string[] }
const shotValue = { title: '进入车站', prompt: '林晚进入车站', image_prompt: '林晚在车站门口', video_prompt: '林晚缓步进入，镜头跟随', duration: 8, start_state: '', end_state: '', cut_note: '' }
function design(projectId: string, sceneId: string, name: string) {
  const id = newId()
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?)', id, projectId, name, JSON.stringify([sceneId]), '独立视觉方案', now())
  return id
}
function profile(projectId: string, designId: string | null, variant: string) {
  const id = newId(), timestamp = now()
  run(`INSERT INTO visual_profiles (id,project_id,kind,name,variant,definition,view_requirements,design_id,revision,created_at,updated_at)
    VALUES (?,?,'character','林晚',?,'黑发、墨绿雨衣','正侧背与服装细节',?,1,?,?)`, id, projectId, variant, designId, timestamp, timestamp)
  return id
}
function shot(projectId: string, sceneId: string, designId: string | null, supersededBy: string | null = null) {
  const id = newId()
  run(`INSERT INTO shots (id,project_id,position,title,prompt,duration,source_scene_id,design_id,superseded_by,created_at)
    VALUES (?,?,0,'进入车站','林晚进入车站',8,?,?,?,?)`, id, projectId, sceneId, designId, supersededBy, now())
  return id
}
async function fixture() {
  const project = await call('POST', '/api/projects', { name: '对话资源方案隔离' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '雨夜车站', duration: 8 })
  const otherScene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '另一场次', duration: 8 })
  const currentDesign = design(project.id, scene.id, '分镜方案 2'), otherDesign = design(project.id, otherScene.id, '分镜方案 3')
  const legacyProfile = profile(project.id, null, '雨衣'), currentProfile = profile(project.id, currentDesign, '当前雨衣'), otherProfile = profile(project.id, otherDesign, '另一雨衣')
  run('INSERT INTO scene_visual_bindings VALUES (?,?,1)', scene.id, legacyProfile)
  run('INSERT INTO scene_visual_bindings VALUES (?,?,1)', scene.id, currentProfile)
  const oldShot = shot(project.id, scene.id, null, currentDesign), currentShot = shot(project.id, scene.id, currentDesign)
  const otherShot = shot(project.id, otherScene.id, otherDesign)
  inheritSceneVisualBindings(oldShot, scene.id); inheritSceneVisualBindings(currentShot, scene.id)
  return { project, scene, otherScene, currentDesign, otherDesign, legacyProfile, currentProfile, otherProfile, oldShot, currentShot, otherShot }
}
function save(projectId: string, changes: ResourceChange[]) {
  db.transaction(() => { validateResourceChanges(projectId, changes); applyResourceChanges(projectId, changes) })()
}

function dialogue(f: Awaited<ReturnType<typeof fixture>>) {
  const script = (): ScriptSnapshot => ({ outline: '', characters: '', generation_options: {},
    artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', f.project.id),
    scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', f.project.id) })
  return { script, tools: documentTools({ project: f.project, script, stage: directorStageContext(script()),
    messages: [{ role: 'user', text: '请新增和修改当前方案人物视觉设定' }], onEvent: () => {},
    checkApproval: async () => true, authorizeResource: async () => true }) }
}

// Model the real strict-tool wire shape: every optional property is present,
// with null for omission, including optional properties inside profile unions.
function strictArguments(name: string, value: Record<string, unknown>) {
  type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[] }
  const schema = strictJsonSchema(scriptFunctions.find(tool => tool.name === name)!.parameters) as Schema
  const fill = (shape: Schema, input: any): any => {
    if (input === null) return null
    if (shape.anyOf) {
      const branch = shape.anyOf.find(child => Array.isArray(input) ? child.type === 'array'
        : input && typeof input === 'object' ? child.type === 'object' && Object.keys(input).every(key => key in (child.properties || {}))
          : child.type === typeof input)
      if (branch) return fill(branch, input)
    }
    if (Array.isArray(input)) return input.map(item => fill(shape.items || {}, item))
    if (!input || typeof input !== 'object') return input
    const output = Object.fromEntries(Object.entries(input).map(([key, item]) => [key, fill(shape.properties?.[key] || {}, item)]))
    for (const key of shape.required || []) if (!(key in output)) output[key] = null
    return output
  }
  return fill(schema, value)
}

test('storyboard context exposes only the selected active designs while explicit profile reads retain historical access', async () => {
  const f = await fixture(), tools = resourceTools(f.project.id)
  const context = tools.execute('get_storyboard_context', { scene_ids: [f.scene.id], limit: 10 }) as any
  assert.deepEqual(context.visual_profile_catalog.map((item: any) => item.id), [f.currentProfile])
  assert.equal(context.visual_profile_catalog[0].design_id, f.currentDesign)
  assert.deepEqual(context.objects.map((item: any) => item.design_id), [f.currentDesign, f.currentDesign])
  assert.deepEqual(context.objects[0].bindings.map((item: any) => item.profile_id), [f.currentProfile])
  assert.ok(context.objects.every((item: any) => item.id !== f.oldShot))
  const byShot = tools.execute('get_storyboard_context', { shot_ids: [f.otherShot], limit: 10 }) as any
  assert.deepEqual(byShot.visual_profile_catalog.map((item: any) => item.id), [f.otherProfile])
  const historical = tools.execute('read_visual_profiles', { profile_ids: [f.legacyProfile] }) as any
  assert.equal(historical.profiles[0].design_id, null)
  assert.ok(historical.profiles[0].shot_ids.includes(f.oldShot))
})

test('new dialogue profiles keep a stable scoped variant through proposal, validation and save without reusing historical identities', async () => {
  const f = await fixture(), legacyBefore = one('SELECT * FROM visual_profiles WHERE id=?', f.legacyProfile)
  const proposal = resourceTools(f.project.id).execute('propose_visual_profile_draft', { summary: '重新设计雨衣', profiles: [{ profile: { ...profileValue, scene_ids: [f.scene.id] } }] }) as any
  const change = proposal.changes[0], displayed = structuredClone(change.value)
  assert.equal(displayed.design_id, f.currentDesign)
  assert.equal(displayed.variant, '雨衣 · 分镜方案 2')
  assert.notEqual(change.id, f.legacyProfile)
  validateResourceChanges(f.project.id, proposal.changes)
  validateResourceChanges(f.project.id, proposal.changes)
  assert.deepEqual(change.value, displayed)
  save(f.project.id, proposal.changes)
  const saved = one<any>('SELECT * FROM visual_profiles WHERE id=?', change.id)!
  assert.equal(saved.design_id, f.currentDesign); assert.equal(saved.variant, displayed.variant)
  assert.deepEqual(one('SELECT * FROM visual_profiles WHERE id=?', f.legacyProfile), legacyBefore)
  const tools = resourceTools(f.project.id), context = tools.execute('get_storyboard_context', { scene_ids: [f.scene.id] }) as any
  const shots = tools.execute('propose_shot_plan', { summary: '新增镜头', scenes: [{ scene_id: f.scene.id, base_version: context.objects[0].version, shots: [shotValue] }] }) as any
  save(f.project.id, shots.changes)
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', shots.changes[0].id).design_id, f.currentDesign)
  assert.ok(one('SELECT 1 FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', shots.changes[0].id, change.id))
  assert.equal(one('SELECT 1 FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', shots.changes[0].id, f.legacyProfile), undefined)
})

test('profile drafts reject mixed designs, explicit mismatches and a design change before confirmation', async () => {
  const f = await fixture(), tools = resourceTools(f.project.id)
  assert.throws(() => tools.execute('propose_visual_profile_draft', { summary: '跨域', profiles: [{ profile: { ...profileValue, scene_ids: [f.scene.id, f.otherScene.id] } }] }), /不同设计方案/)
  assert.throws(() => tools.execute('propose_visual_profile_draft', { summary: '伪造归属', profiles: [{ profile: { ...profileValue, design_id: f.otherDesign, scene_ids: [f.scene.id] } }] }), /设计方案与当前场次不一致/)
  const proposal = tools.execute('propose_visual_profile_draft', { summary: '等待确认', profiles: [{ profile: { ...profileValue, scene_ids: [f.scene.id] } }] }) as any
  const nextDesign = design(f.project.id, f.scene.id, '分镜方案 4')
  run('UPDATE shots SET superseded_by=? WHERE id=?', nextDesign, f.currentShot)
  shot(f.project.id, f.scene.id, nextDesign)
  assert.throws(() => save(f.project.id, proposal.changes), /设计方案与当前场次不一致/)
  assert.equal(one('SELECT * FROM visual_profiles WHERE id=?', proposal.changes[0].id), undefined)
})

test('explicit edits to a historical profile preserve its design and reject migration in all write stages', async () => {
  const f = await fixture(), tools = resourceTools(f.project.id)
  const read = tools.execute('read_visual_profiles', { profile_ids: [f.legacyProfile] }) as any
  const input = { summary: '更新历史设定文字', profiles: [{ profile_id: f.legacyProfile, base_version: read.profiles[0].version, profile: { ...profileValue, definition: '历史版本的扣子细节' } }] }
  assert.throws(() => tools.execute('propose_visual_profile_draft', { ...input, profiles: [{ ...input.profiles[0], profile: { ...profileValue, design_id: f.currentDesign } }] }), /不能迁移/)
  const proposal = tools.execute('propose_visual_profile_draft', input) as any
  const invalid = structuredClone(proposal.changes)
  invalid[0].value.design_id = f.currentDesign
  assert.throws(() => validateResourceChanges(f.project.id, invalid), /不能迁移/)
  assert.throws(() => applyResourceChanges(f.project.id, invalid), /不能迁移/)
  save(f.project.id, proposal.changes)
  const saved = one<any>('SELECT * FROM visual_profiles WHERE id=?', f.legacyProfile)!
  assert.equal(saved.design_id, null); assert.equal(saved.definition, '历史版本的扣子细节')
})

test('scene binding replacement changes only the current design and preserves historical bindings and shot snapshots', async () => {
  const f = await fixture(), tools = resourceTools(f.project.id), replacement = profile(f.project.id, f.currentDesign, '另一当前雨衣')
  const oldScene = one('SELECT * FROM scene_visual_bindings WHERE scene_id=? AND profile_id=?', f.scene.id, f.legacyProfile)
  const oldShot = all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', f.oldShot)
  tools.execute('read_visual_profiles', { profile_ids: [replacement] })
  const context = tools.execute('get_storyboard_context', { scene_ids: [f.scene.id] }) as any
  const proposal = tools.execute('propose_visual_binding_patch', { summary: '只替换当前方案候选', targets: [{ target_type: 'scene', target_id: f.scene.id,
    base_version: context.objects[0].binding_version, bindings: [{ profile_id: replacement, required: false }] }] }) as any
  save(f.project.id, proposal.changes)
  assert.deepEqual(one('SELECT * FROM scene_visual_bindings WHERE scene_id=? AND profile_id=?', f.scene.id, f.legacyProfile), oldScene)
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', f.oldShot), oldShot)
  assert.equal(one('SELECT * FROM scene_visual_bindings WHERE scene_id=? AND profile_id=?', f.scene.id, f.currentProfile), undefined)
  assert.equal(one<any>('SELECT * FROM scene_visual_bindings WHERE scene_id=? AND profile_id=?', f.scene.id, replacement).required, 0)
})

test('cross-design bindings reject at proposal, validation and apply before touching an existing snapshot', async () => {
  const f = await fixture(), tools = resourceTools(f.project.id)
  tools.execute('read_visual_profiles', { profile_ids: [f.legacyProfile] })
  const context = tools.execute('get_storyboard_context', { shot_ids: [f.currentShot], limit: 10 }) as any
  const current = context.objects.find((item: any) => item.type === 'shot')
  const target = { target_type: 'shot', target_id: f.currentShot, base_version: current.binding_version, bindings: [{ profile_id: f.legacyProfile, required: true }] }
  assert.throws(() => tools.execute('propose_visual_binding_patch', { summary: '旧档案混入新镜头', targets: [target] }), /同一设计方案/)
  const invalid: ResourceChange[] = [{ type: 'visual_binding', id: f.currentShot, title: '镜头', target_type: 'shot', base_version: current.binding_version, original: [], value: target.bindings, refresh_profile_ids: [] }]
  const before = all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', f.currentShot)
  assert.throws(() => validateResourceChanges(f.project.id, invalid), /同一设计方案/)
  assert.throws(() => applyResourceChanges(f.project.id, invalid), /同一设计方案/)
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', f.currentShot), before)
  const scene = context.objects.find((item: any) => item.type === 'scene')
  assert.throws(() => tools.execute('propose_visual_binding_patch', { summary: '旧档案混入新场次', targets: [{ ...target, target_type: 'scene', target_id: f.scene.id, base_version: scene.binding_version }] }), /同一设计方案/)
})

test('a scene retains its design after its last current shot is deleted and dialogue planning never inherits legacy candidates', async () => {
  const f = await fixture(), tools = resourceTools(f.project.id)
  run('DELETE FROM shots WHERE id=?', f.currentShot)
  const context = tools.execute('get_storyboard_context', { scene_ids: [f.scene.id] }) as any
  assert.equal(context.objects[0].design_id, f.currentDesign)
  const proposal = tools.execute('propose_shot_plan', { summary: '空场次重新拆镜', scenes: [{ scene_id: f.scene.id, base_version: context.objects[0].version, shots: [shotValue] }] }) as any
  save(f.project.id, proposal.changes)
  const created = one<any>('SELECT * FROM shots WHERE id=?', proposal.changes[0].id)!
  assert.equal(created.design_id, f.currentDesign)
  assert.deepEqual(all<any>('SELECT profile_id FROM shot_visual_bindings WHERE shot_id=?', created.id).map(item => item.profile_id), [f.currentProfile])
})

test('a pending scene binding draft becomes stale when a new design supersedes that scene', async () => {
  const f = await fixture(), tools = resourceTools(f.project.id)
  const context = tools.execute('get_storyboard_context', { scene_ids: [f.scene.id] }) as any
  const proposal = tools.execute('propose_visual_binding_patch', { summary: '清空当前候选', targets: [{ target_type: 'scene', target_id: f.scene.id, base_version: context.objects[0].binding_version, bindings: [] }] }) as any
  const nextDesign = design(f.project.id, f.scene.id, '分镜方案 4')
  run('UPDATE shots SET superseded_by=? WHERE id=?', nextDesign, f.currentShot)
  shot(f.project.id, f.scene.id, nextDesign)
  assert.throws(() => validateResourceChanges(f.project.id, proposal.changes), /版本已变化/)
  assert.ok(one('SELECT 1 FROM scene_visual_bindings WHERE scene_id=? AND profile_id=?', f.scene.id, f.currentProfile))
})

test('strict dialogue proposals restore null design scope and infer or retain the current design', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'edit an existing design profile' : 'create a profile for current scenes', async () => {
    const f = await fixture(), { tools, script } = dialogue(f)
    const original = existing ? (await tools.execute('read_visual_profiles', { profile_ids: [f.currentProfile] }) as any).profiles[0] : null
    const input = strictArguments('propose_visual_profile_draft', { summary: '完善当前方案人物', profiles: [{
      ...(original ? { profile_id: original.id, base_version: original.version } : {}),
      profile: { ...profileValue, variant: original?.variant || '新蓝衣', definition: '黑发、蓝衣，补充服装细节',
        scene_ids: original ? [] : [f.scene.id] },
    }] })
    assert.equal(input.profiles[0].profile.design_id, null, 'strict models use null for unspecified optional fields')
    await tools.execute('propose_visual_profile_draft', input)
    const draft = getToolDraft(f.project.id)!, change = draft.resource_changes![0]!
    assert.equal(change.type, 'visual_profile')
    assert.equal((change.value as any).design_id, f.currentDesign)
    assert.equal(one<any>('SELECT * FROM visual_profiles WHERE id=?', f.legacyProfile).design_id, null)
    commitToolDraft(f.project.id, draft.id, draft.version, script)
    const saved = one<any>('SELECT * FROM visual_profiles WHERE id=?', change.id)!
    assert.equal(saved.design_id, f.currentDesign)
    assert.equal(saved.definition, '黑发、蓝衣，补充服装细节')
    if (original) assert.equal(saved.id, original.id)
  })
})

test('strict draft edits preserve design scope even for new profiles without source scenes', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'existing profile draft' : 'new profile with an explicit design', async () => {
    const f = await fixture(), { tools, script } = dialogue(f)
    const original = existing ? (await tools.execute('read_visual_profiles', { profile_ids: [f.currentProfile] }) as any).profiles[0] : null
    await tools.execute('propose_visual_profile_draft', strictArguments('propose_visual_profile_draft', { summary: '当前方案草稿', profiles: [{
      ...(original ? { profile_id: original.id, base_version: original.version } : {}),
      profile: { ...profileValue, variant: original?.variant || '独立草稿', scene_ids: [], design_id: f.currentDesign },
    }] }))
    const draft = await tools.execute('manage_document_draft', strictArguments('manage_document_draft', { operation: 'read' })) as any
    const { design_id: _design, ...value } = draft.resource_changes[0].value
    const input = strictArguments('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version,
      resource_values: [{ index: 0, value: { ...value, definition: '草稿补充银色衣扣' } }] })
    assert.equal(input.resource_values[0].value.design_id, null)
    await tools.execute('manage_document_draft', input)
    const updated = getToolDraft(f.project.id)!, change = updated.resource_changes![0]!
    assert.equal((change.value as any).design_id, f.currentDesign)
    assert.deepEqual((change.value as any).scene_ids, [])
    // Public draft editing keeps explicit null and wrong-domain values invalid.
    for (const wrong of [null, f.otherDesign]) assert.throws(() => editToolDraft(f.project.id, updated.id, {
      version: updated.version, documents: [], resource_values: [{ index: 0, value: { ...change.value as any, design_id: wrong } }],
    }), /不能迁移/)
    for (const wrong of [f.otherDesign]) await assert.rejects(tools.execute('manage_document_draft', strictArguments('manage_document_draft', {
      operation: 'update', draft_id: updated.id, version: updated.version,
      resource_values: [{ index: 0, value: { ...change.value as any, design_id: wrong } }],
    })), /不能迁移/)
    assert.equal((getToolDraft(f.project.id)!.resource_changes![0]!.value as any).design_id, f.currentDesign)
    commitToolDraft(f.project.id, updated.id, updated.version, script)
    assert.equal(one<any>('SELECT * FROM visual_profiles WHERE id=?', change.id).design_id, f.currentDesign)
    assert.equal(one<any>('SELECT * FROM visual_profiles WHERE id=?', change.id).definition, '草稿补充银色衣扣')
  })
})

test('model-only null restoration does not loosen public create or explicit wrong-design inputs', async () => {
  const f = await fixture(), { tools } = dialogue(f)
  for (const designId of [null, f.otherDesign]) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/visual-profiles`,
      payload: { profiles: [{ ...profileValue, scene_ids: [f.scene.id], design_id: designId }] } })
    assert.equal(response.statusCode, 422, response.body)
  }
  await assert.rejects(tools.execute('propose_visual_profile_draft', strictArguments('propose_visual_profile_draft', {
    summary: '错误方案', profiles: [{ profile: { ...profileValue, scene_ids: [f.scene.id], design_id: f.otherDesign } }],
  })), /设计方案与当前场次不一致/)
  const created = await call('POST', `/api/projects/${f.project.id}/visual-profiles`, {
    design_id: f.currentDesign, profiles: [{ ...profileValue, variant: '手工独立版本', scene_ids: [] }],
  })
  assert.equal(created.created_profile_ids.length, 1)
  assert.equal(one<any>('SELECT * FROM visual_profiles WHERE id=?', created.created_profile_ids[0]).design_id, f.currentDesign)
})
