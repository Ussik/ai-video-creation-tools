import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { ScriptScene, ScriptArtifact } from '../src/infrastructure/database/db.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import { withFixtureVisualCoverage } from './helpers/visual-coverage.js'

const testData = await mkdtemp(join(tmpdir(), 'script-canvas-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const { registerScriptCanvasRoutes } = await import('../src/modules/canvas/script-canvas-preparation.js')
const { installSkillBundle, configureSkill, removeInstalledSkill, setSkillDefault, resetSkillTaskDefault } = await import('../src/modules/skills/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, generator: (prompt: string, contract: OutputContract) => Promise<string> = async () => JSON.stringify({ profiles: [] }), rawCoverage = false) {
  const project = await call('POST', '/api/projects', { name: '加入画布隔离测试' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站', characters: '林晚', action: '拿起钥匙', episode_number: 1 })
  const other = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '码头', episode_number: 2 })
  const routes = Fastify()
  t.after(() => routes.close())
  let calls = 0
  registerScriptCanvasRoutes(routes, {
    script: id => ({ ...one<{ outline: string; characters: string }>('SELECT * FROM scripts WHERE project_id=?', id)!,
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', id),
      scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', id) }),
    scenePrompt: scene => `${scene.heading}\n${scene.characters}\n${scene.action}`,
    generateText: async (_id, model, prompt, contract) => {
      assert.equal(model, 'mock-text'); assert.ok(contract)
      assert.equal(contract.name, 'visual_profiles'); calls++;
      const raw = await generator(prompt, contract)
      return rawCoverage ? raw : withFixtureVisualCoverage(raw, prompt)
    },
  })
  const invoke = async (action: string, payload: object, status = 200) => {
    const response = await routes.inject({ method: 'POST', url: `/api/projects/${project.id}/script/canvas/${action}`, payload })
    assert.equal(response.statusCode, status, response.body)
    return response.json()
  }
  const check = () => invoke('check', { scene_ids: [scene.id] })
  return { project, scene, other, invoke, check, calls: () => calls }
}
function profile(sceneId: string, name = '林晚') {
  return { kind: 'character', name, variant: '默认', definition: '日漫风格，黑色短发，蓝色夹克。', view_requirements: '正侧背与服装细节', scene_ids: [sceneId] }
}
async function plan(f: Awaited<ReturnType<typeof setup>>) {
  const checked = await f.check()
  const { signature, scene_ids, profiles, coverage_version, visual_coverage } = await f.invoke('prepare', { scene_ids: checked.scene_ids, signature: checked.signature, model_id: 'mock-text' })
  return { signature, scene_ids, profiles, coverage_version, visual_coverage }
}

test('read-only preparation then atomic drafts, required bindings and shot prompts without image generation', async t => {
  let sceneId = ''
  const f = await setup(t, async prompt => { assert.match(prompt, /选定场次/); return JSON.stringify({ profiles: [profile(sceneId)] }) })
  sceneId = f.scene.id
  const draft = await plan(f)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
  const result = await f.invoke('commit', { ...draft, reference_usage_version: 1 })
  assert.equal(result.created_profiles, 1); assert.equal(result.created_shots, 1)
  assert.equal(result.visual_profiles[0].definition_status, 'draft')
  assert.equal(result.shot_visual_bindings[0].required, true)
  assert.match(result.shots[0].image_prompt, /单幅首帧/)
  assert.match(result.shots[0].video_prompt, /连续视频镜头/)
  assert.equal(result.shots[0].source_scene_id, sceneId)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', f.project.id).length, 0)
})

test('long scenes require planned shots before canvas preparation and cannot create oversized templates', async t => {
  const f = await setup(t)
  await call('PATCH', `/api/script-scenes/${f.scene.id}`, { duration: 120 })
  const checked = await f.check(), base = { scene_ids: checked.scene_ids, signature: checked.signature }
  const rejected = await f.invoke('prepare', { ...base, model_id: 'mock-text' }, 422)
  assert.match(rejected.message, /先规划分镜/)
  await f.invoke('commit', { ...base, profiles: [profile(f.scene.id)] }, 422)
  assert.equal(f.calls(), 0)
  assert.deepEqual(all('SELECT * FROM shots WHERE project_id=?', f.project.id), [])
  assert.deepEqual(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id), [])

  const shot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '已规划镜头', duration: 15, source_scene_id: f.scene.id })
  const result = await f.invoke('commit', await plan(f))
  assert.equal(result.created_shots, 0)
  assert.deepEqual(result.shots.map((item: any) => [item.id, item.duration]), [[shot.id, 15]])
})

test('retries reuse all shots, confirmed profiles and optional bindings without calling the model again', async t => {
  let sceneId = ''
  const f = await setup(t, async () => JSON.stringify({ profiles: [{ ...profile(sceneId), definition: '不能覆盖原文',
    shot_usage: all<{ id: string }>('SELECT id FROM shots WHERE source_scene_id=?', sceneId).map(shot => ({ shot_id: shot.id, usage: 'both' })) }] }))
  sceneId = f.scene.id
  const saved = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(sceneId)] })).visual_profiles[0]
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','board.png','/tmp/board.png','upload',?)", 'confirmed-board', f.project.id, now())
  await call('PATCH', `/api/visual-profiles/${saved.id}`, { expected_revision: 1, board_asset_id: 'confirmed-board' })
  run('UPDATE scene_visual_bindings SET required=0 WHERE scene_id=?', sceneId)
  const shot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '手动分镜', source_scene_id: sceneId, prompt: '原提示词' })
  const second = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '第二个分镜', source_scene_id: sceneId })
  const result = await f.invoke('commit', await plan(f))
  assert.equal(result.created_profiles, 0); assert.equal(result.created_shots, 0)
  assert.deepEqual(result.shots.map((item: any) => item.id), [shot.id, second.id])
  assert.equal(result.shots[0].prompt, '原提示词')
  assert.equal(result.visual_profiles[0].definition, saved.definition)
  assert.equal(result.visual_profiles[0].board_asset_id, 'confirmed-board')
  assert.equal(result.shot_visual_bindings[0].required, false)
  const checked = await f.check(); assert.deepEqual(checked.needs_analysis, [])
  const cached = await f.invoke('prepare', { scene_ids: checked.scene_ids, signature: checked.signature })
  assert.deepEqual(cached.used_skills, []); assert.deepEqual(cached.loaded_files, [])
  const repeated = await f.invoke('commit', { signature: cached.signature, scene_ids: cached.scene_ids, profiles: cached.profiles })
  assert.equal(f.calls(), 1); assert.equal(repeated.shots.length, 2)
  assert.equal(repeated.created_profiles, 0); assert.equal(repeated.created_shots, 0)
})

test('source changes during analysis and before commit reject stale results without writes', async t => {
  let sceneId = '', mutate = true
  const f = await setup(t, async () => { if (mutate) run('UPDATE script_scenes SET action=? WHERE id=?', '更新动作', sceneId); return JSON.stringify({ profiles: [profile(sceneId)] }) })
  sceneId = f.scene.id
  const checked = await f.check()
  await f.invoke('prepare', { scene_ids: checked.scene_ids, signature: checked.signature, model_id: 'mock-text' }, 409)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
  mutate = false
  const draft = await plan(f)
  run('UPDATE script_scenes SET action=? WHERE id=?', '再次更新动作', sceneId)
  await f.invoke('commit', draft, 409)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
  assert.deepEqual((await f.check()).needs_analysis, [sceneId])
})

test('foreign, empty, conflicting or excessive drafts roll back the whole commit', async t => {
  const f = await setup(t), checked = await f.check(), base = { scene_ids: checked.scene_ids, signature: checked.signature }
  for (const profiles of [[profile(f.other.id)], [{ ...profile(f.scene.id), scene_ids: [] }],
    [profile(f.scene.id), { ...profile(f.scene.id), definition: '冲突设定' }],
    Array.from({ length: 51 }, (_, index) => profile(f.scene.id, `角色${index}`))]) {
    await f.invoke('commit', { ...base, profiles }, 422)
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
    assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
    assert.equal(all('SELECT * FROM script_canvas_preparations WHERE scene_id=?', f.scene.id).length, 0)
  }
  await f.invoke('check', { scene_ids: [f.scene.id, f.scene.id] }, 422)
})

test('fingerprints track same-episode documents and scene bindings, ignoring other episode documents', async t => {
  const f = await setup(t)
  await f.invoke('commit', await plan(f))
  assert.deepEqual((await f.check()).needs_analysis, [])
  const insert = (id: string, episode: number) => run(`INSERT INTO script_artifacts (id,project_id,artifact_type,episode_number,title,content,status,position,created_at,updated_at)
    VALUES (?,?,'episode_script',?,'正文','新内容','ready',0,?,?)`, id, f.project.id, episode, now(), now())
  insert(`other-${f.project.id}`, 2)
  assert.deepEqual((await f.check()).needs_analysis, [])
  insert(`current-${f.project.id}`, 1)
  assert.deepEqual((await f.check()).needs_analysis, [f.scene.id])
  await f.invoke('commit', await plan(f))
  await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(f.scene.id)] })
  assert.deepEqual((await f.check()).needs_analysis, [f.scene.id])
})

test('draft edits update unresolved snapshots; approved boards stay on their original definition later', async t => {
  let sceneId = ''
  const f = await setup(t, async () => JSON.stringify({ profiles: [profile(sceneId)] }))
  sceneId = f.scene.id
  const p = (await f.invoke('commit', await plan(f))).visual_profiles[0]
  const updated = await call('PATCH', `/api/visual-profiles/${p.id}`, { expected_revision: 1, definition: '日漫风格，棕发，灰色制服。', definition_status: 'ready' })
  assert.equal(one<any>('SELECT * FROM shot_visual_bindings WHERE profile_id=?', p.id)!.revision, 2)
  assert.equal(one<any>('SELECT * FROM shot_visual_bindings WHERE profile_id=?', p.id)!.definition, updated.definition)
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','board.png','/tmp/board.png','upload',?)", `board-${p.id}`, f.project.id, now())
  await call('PATCH', `/api/visual-profiles/${p.id}`, { expected_revision: 2, board_asset_id: `board-${p.id}` })
  const binding = one<any>('SELECT * FROM shot_visual_bindings WHERE profile_id=?', p.id)!
  assert.equal(binding.board_asset_id, `board-${p.id}`)
  await call('PATCH', `/api/visual-profiles/${p.id}`, { expected_revision: 2, definition: '另一个版本' })
  assert.deepEqual(one('SELECT * FROM shot_visual_bindings WHERE profile_id=?', p.id), binding)
})

test('deleting a prepared project cleans fingerprints with foreign keys enabled', async t => {
  const f = await setup(t)
  await f.invoke('commit', await plan(f))
  await call('DELETE', `/api/projects/${f.project.id}`)
  assert.equal(all('SELECT * FROM script_canvas_preparations WHERE scene_id=?', f.scene.id).length, 0)
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})

test('preparation honors project defaults, temporary visual skill selections and explicit base rules', async t => {
  function install(name: string) {
    const value = installSkillBundle({ repo: 'qa/reference-preparation', path: name, name, description: name, license: 'MIT', revision: 'b'.repeat(40),
      tool_requirements: [], suggested_stages: ['visual_assets'], url: '', files: [{ path: `${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: 视觉资料规则\n---\nRULE_${name}` }] })
    configureSkill(value.id, true, ['visual_assets']); return value.id
  }
  const main = install('visual-primary'), alternate = install('visual-alternate')
  t.after(async () => { removeInstalledSkill(main); removeInstalledSkill(alternate); resetSkillTaskDefault('visual_assets') })
  let captured = ''
  const f = await setup(t, async prompt => { captured = prompt; return JSON.stringify({ profiles: [] }) })
  setSkillDefault('visual_assets', { primary_id: alternate, auxiliary_ids: [] }, f.project.id)
  const checked = await f.check(), request = { signature: checked.signature, scene_ids: checked.scene_ids, model_id: 'mock-text' }
  const inherited = await f.invoke('prepare', request)
  assert.deepEqual(inherited.used_skills.map((value: { id: string }) => value.id), [alternate])
  assert.equal(inherited.skill_assignment.source, 'fixed'); assert.match(inherited.skill_assignment.reason, /视觉设定整理.*项目绑定/)
  assert.match(captured, /RULE_visual-alternate/); assert.doesNotMatch(captured, /RULE_visual-primary/)
  assert.ok(inherited.loaded_files.length > 0)
  const switched = await f.invoke('prepare', { ...request, skill_ids: [main] })
  assert.deepEqual(switched.used_skills.map((value: { id: string; role: string }) => [value.id, value.role]), [[main, 'primary']])
  assert.match(captured, /RULE_visual-primary/); assert.doesNotMatch(captured, /RULE_visual-alternate/)
  const base = await f.invoke('prepare', { ...request, skill_ids: [] })
  assert.deepEqual(base.used_skills, []); assert.deepEqual(base.loaded_files, []); assert.doesNotMatch(captured, /RULE_visual-/)
  await f.invoke('prepare', { ...request, skill_ids: ['foreign'] }, 422)
  assert.equal(f.calls(), 3)
  await f.invoke('commit', { signature: base.signature, scene_ids: base.scene_ids, profiles: base.profiles,
    coverage_version: base.coverage_version, visual_coverage: base.visual_coverage })
  const next = await f.check()
  assert.deepEqual(next.needs_analysis, [], 'a deliberate empty dependency list is also prepared')
  const cached = await f.invoke('prepare', { signature: next.signature, scene_ids: next.scene_ids })
  assert.deepEqual(cached.used_skills, []); assert.deepEqual(cached.loaded_files, []); assert.equal(f.calls(), 3)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
})

test('reference fingerprints follow planned visual content and ignore media selection and other scenes', async t => {
  const f = await setup(t)
  const saved = await f.invoke('commit', await plan(f)), shotId = saved.shots[0].id
  assert.deepEqual((await f.check()).needs_analysis, [], 'legacy template creation must not cause a false cache miss')
  const assetId = 'selected-frame-' + shotId
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','frame.png','/tmp/frame.png','upload',?)", assetId, f.project.id, now())
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, shotId)
  assert.deepEqual((await f.check()).needs_analysis, [], 'choosing a generated image is not a new dependency')
  const unrelated = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '其他集分镜', source_scene_id: f.other.id, image_prompt: '其他场次原画面' })
  const draft = await plan(f)
  run('UPDATE shots SET image_prompt=? WHERE id=?', '其他场次修改后的画面', unrelated.id)
  await f.invoke('commit', draft)
  assert.deepEqual((await f.check()).needs_analysis, [])
  run('UPDATE shots SET image_prompt=? WHERE id=?', '林晚新增红色雨伞', shotId)
  assert.deepEqual((await f.check()).needs_analysis, [f.scene.id])
  await f.invoke('commit', await plan(f))
  assert.deepEqual((await f.check()).needs_analysis, [])
  run('UPDATE shots SET video_prompt=? WHERE id=?', '拿起新的铜怀表后跑向出口', shotId)
  assert.deepEqual((await f.check()).needs_analysis, [f.scene.id])
})

test('scoped preparation keeps scene candidates separate from each images and video objects and detects concurrent usage edits', async t => {
  let sceneId = '', shotId = ''
  const f = await setup(t, async prompt => {
    assert.match(prompt, /场次关联仅是候选资料池/)
    return JSON.stringify({ profiles: [{ ...profile(sceneId, '技术人员'), shot_usage: [{ shot_id: shotId, usage: 'video' }] }] })
  })
  sceneId = f.scene.id
  const unused = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(sceneId, '记录本')] })).visual_profiles[0]
  const shot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '空房间开镜', source_scene_id: sceneId, image_prompt: '空房间', video_prompt: '技术人员走入画面' })
  shotId = shot.id
  const checked = await f.check()
  const draft = await f.invoke('prepare', { scene_ids: checked.scene_ids, signature: checked.signature, model_id: 'mock-text' })
  await f.invoke('commit', { signature: draft.signature, scene_ids: draft.scene_ids, reference_usage_version: 1,
    profiles: draft.profiles.map(({ shot_usage: _usage, ...profile }: any) => profile) }, 422)
  const saved = await f.invoke('commit', { signature: draft.signature, scene_ids: draft.scene_ids, profiles: draft.profiles,
    reference_usage_version: draft.reference_usage_version, coverage_version: draft.coverage_version, visual_coverage: draft.visual_coverage })
  assert.equal(saved.shot_visual_bindings.find((binding: any) => binding.profile_id === unused.id).usage, 'none')
  assert.equal(saved.shot_visual_bindings.find((binding: any) => binding.name === '技术人员').usage, 'video')
  assert.equal(saved.scene_visual_bindings, undefined)
  assert.equal(all('SELECT * FROM scene_visual_bindings WHERE scene_id=?', sceneId).length, 2)
  run('UPDATE shots SET video_prompt=? WHERE id=?', '技术人员继续走近', shotId)
  const next = await plan(f)
  run("UPDATE shot_visual_bindings SET usage='image' WHERE shot_id=? AND profile_id=?", shotId, unused.id)
  await f.invoke('commit', next, 409)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
})

function independentDesign(projectId: string, sceneIds: string[], label: string) {
  const id = `design-${projectId}-${label}`
  run(`INSERT INTO storyboard_designs (id, project_id, name, scene_ids, instructions, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, id, projectId, label, JSON.stringify(sceneIds), '重新设计为蓝白配色与圆形空间结构', now())
  return id
}
function independentShot(projectId: string, sceneId: string, designId: string) {
  const id = `shot-${designId}-${sceneId}`
  run(`INSERT INTO shots (id, project_id, position, title, prompt, image_prompt, video_prompt, duration, source_scene_id, design_id, created_at)
    VALUES (?, ?, 100, '新方案镜头', '新设计', '新设计开镜', '新设计动作', 5, ?, ?, ?)`, id, projectId, sceneId, designId, now())
  return id
}

type ProfileWireBranch = { properties: Record<string, Record<string, unknown>>; required: string[] }
function profileWireBranches(contract: OutputContract) {
  const items = (contract.schema.properties as { profiles: { items: { anyOf: ProfileWireBranch[] } } }).profiles.items
  assert.equal(items.anyOf.length, 3, 'model schema distinguishes independent, saved-base and draft-base profiles')
  return items.anyOf
}
function strictProfileDraft(draft: Record<string, unknown>, branches: ProfileWireBranch[]) {
  const branch = branches.find(value => draft.base_draft_key ? value.properties.base_draft_key!.minLength === 1
    : draft.base_profile_id ? value.properties.base_profile_id!.minLength === 1
      : value.properties.base_profile_id!.minLength === undefined && value.properties.base_draft_key!.minLength === undefined)
  assert.ok(branch, 'profile must match its explicit relation branch')
  // Strict providers emit every required wire field, using null for absent optional values.
  return Object.fromEntries([...Object.entries(draft), ...branch.required.filter(key => !(key in draft)).map(key => [key, null])])
}

test('strict model output with nullable optional fields prepares and commits legacy and independent design references', async t => {
  for (const redesign of [false, true]) await t.test(redesign ? 'independent design' : 'legacy design', async t => {
    let sceneId = '', shotId = '', profileContracts: ProfileWireBranch[] = []
    const f = await setup(t, async (_prompt, contract) => {
      profileContracts = profileWireBranches(contract)
      const drafts: Array<Record<string, unknown>> = [
        { ...profile(sceneId), draft_key: 'base', shot_usage: [{ shot_id: shotId, usage: 'none' }] },
        { ...profile(sceneId), variant: '蓝衣', draft_key: 'derived', base_draft_key: 'base', state_delta: '换蓝衣',
          shot_usage: [{ shot_id: shotId, usage: 'both' }] },
      ]
      return JSON.stringify({ profiles: drafts.map(draft => strictProfileDraft(draft, profileContracts)) })
    })
    sceneId = f.scene.id
    const designId = redesign ? independentDesign(f.project.id, [sceneId], '严格输出新方案') : null
    shotId = designId ? independentShot(f.project.id, sceneId, designId)
      : (await call('POST', `/api/projects/${f.project.id}/shots`, { title: '原方案镜头', source_scene_id: sceneId })).id
    const draft = await plan(f)
    assert.equal(f.calls(), 1, 'valid strict output must not need a format correction')
    for (const branch of profileContracts) assert.ok(!('design_id' in branch.properties), 'model output cannot choose the server-owned design scope')
    assert.ok(draft.profiles.every((value: any) => (value.design_id || null) === designId))
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0, 'analysis remains read-only')
    const saved = await f.invoke('commit', { ...draft, reference_usage_version: 1 })
    assert.equal(saved.created_profiles, 2)
    const base = saved.visual_profiles.find((value: any) => !value.base_profile_id)
    const derived = saved.visual_profiles.find((value: any) => value.base_profile_id)
    assert.equal(base.design_id || null, designId)
    assert.equal(derived.design_id || null, designId)
    assert.equal(derived.base_profile_id, base.id)
    assert.equal(derived.state_delta, '换蓝衣')
    assert.deepEqual(saved.shots.map((value: any) => value.id), [shotId])
    assert.deepEqual(saved.shot_visual_bindings.map((value: any) => [value.profile_id, value.usage]).sort(),
      [[base.id, 'none'], [derived.id, 'both']].sort())
    assert.deepEqual((await f.check()).needs_analysis, [])
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
  })
})

test('four-shot preparation corrects missing or blank derived-state changes once and commits the exact relation', async t => {
  for (const missing of [undefined, '   ']) await t.test(missing === undefined ? 'missing state delta' : 'blank state delta', async t => {
    let sceneId = '', shotIds: string[] = [], attempts = 0
    const f = await setup(t, async prompt => {
      attempts++
      const drafts = [
        { ...profile(sceneId), draft_key: 'base', shot_usage: shotIds.map(shot_id => ({ shot_id, usage: 'none' })) },
        { ...profile(sceneId), variant: '蓝色雨衣', draft_key: 'raincoat', base_draft_key: 'base',
          shot_usage: shotIds.map(shot_id => ({ shot_id, usage: 'both' })),
          ...(attempts > 1 ? { state_delta: '仅将蓝色夹克换成蓝色雨衣，其余外貌保持不变。' } : missing === undefined ? {} : { state_delta: missing }) },
      ]
      if (attempts > 1) {
        assert.match(prompt, /一次格式修正/)
        assert.match(prompt, /\$\.profiles\[1\]/)
        assert.match(prompt, /state_delta 中写出相对基础设定的具体变化/)
        assert.match(prompt, /不得为通过校验删除真实派生关系或编造变化/)
      }
      return JSON.stringify({ profiles: drafts })
    })
    sceneId = f.scene.id
    for (let index = 0; index < 4; index++) shotIds.push((await call('POST', `/api/projects/${f.project.id}/shots`, {
      title: `雨衣镜头${index + 1}`, source_scene_id: sceneId,
    })).id)
    const shotsBefore = all('SELECT * FROM shots WHERE project_id=? ORDER BY position, id', f.project.id)
    const draft = await plan(f)
    assert.equal(f.calls(), 2, 'one rejected output receives exactly one correction')
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0, 'correcting the model output remains read-only')
    assert.deepEqual(all('SELECT * FROM shots WHERE project_id=? ORDER BY position, id', f.project.id), shotsBefore)
    const saved = await f.invoke('commit', { ...draft, reference_usage_version: 1 })
    assert.equal(saved.created_profiles, 2); assert.equal(saved.created_shots, 0)
    assert.deepEqual(saved.shots.map((value: any) => value.id), shotIds)
    const base = saved.visual_profiles.find((value: any) => !value.base_profile_id)
    const derived = saved.visual_profiles.find((value: any) => value.base_profile_id)
    assert.equal(derived.base_profile_id, base.id)
    assert.equal(derived.state_delta, '仅将蓝色夹克换成蓝色雨衣，其余外貌保持不变。')
    assert.equal(saved.shot_visual_bindings.filter((value: any) => value.profile_id === derived.id && value.usage === 'both').length, 4)
    assert.deepEqual((await f.check()).needs_analysis, [])
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
  })
})

test('persistent missing derived-state changes stop after one correction without writing partial preparation', async t => {
  let sceneId = ''
  const f = await setup(t, async () => JSON.stringify({ profiles: [
    { ...profile(sceneId), draft_key: 'base' },
    { ...profile(sceneId), variant: '蓝色雨衣', base_draft_key: 'base' },
  ] }))
  sceneId = f.scene.id
  const checked = await f.check()
  const rejected = await f.invoke('prepare', { scene_ids: checked.scene_ids, signature: checked.signature, model_id: 'mock-text' }, 422)
  assert.match(JSON.stringify(rejected), /已修正一次.*\$\.profiles\[1\]/)
  assert.equal(f.calls(), 2)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM scene_visual_bindings WHERE scene_id=?', sceneId).length, 0)
  assert.equal(all('SELECT * FROM script_canvas_preparations WHERE scene_id=?', sceneId).length, 0)
  assert.deepEqual((await f.check()).needs_analysis, [sceneId])
})

test('strict saved-base model output requires a nonempty delta and commits an existing base without duplicating it', async t => {
  let sceneId = '', baseId = '', shotId = ''
  const f = await setup(t, async (_prompt, contract) => {
    const branches = profileWireBranches(contract)
    const savedBase = branches.find(branch => branch.properties.base_profile_id!.minLength === 1)!
    assert.equal(savedBase.properties.state_delta!.minLength, 1)
    assert.ok(savedBase.required.includes('state_delta'))
    return JSON.stringify({ profiles: [strictProfileDraft({ ...profile(sceneId), variant: '蓝色雨衣',
      base_profile_id: baseId, state_delta: '仅将蓝色夹克换成蓝色雨衣。', shot_usage: [{ shot_id: shotId, usage: 'both' }],
    }, branches)] })
  })
  sceneId = f.scene.id
  baseId = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(sceneId)] })).visual_profiles[0].id
  shotId = (await call('POST', `/api/projects/${f.project.id}/shots`, { title: '雨衣镜头', source_scene_id: sceneId })).id
  const saved = await f.invoke('commit', { ...await plan(f), reference_usage_version: 1 })
  assert.equal(f.calls(), 1)
  assert.equal(saved.created_profiles, 1); assert.equal(saved.created_shots, 0)
  assert.equal(saved.visual_profiles.length, 2)
  const derived = saved.visual_profiles.find((value: any) => value.base_profile_id)
  assert.equal(derived.base_profile_id, baseId)
  assert.equal(derived.state_delta, '仅将蓝色夹克换成蓝色雨衣。')
  assert.equal(saved.shot_visual_bindings.find((value: any) => value.profile_id === baseId).usage, 'none')
  assert.equal(saved.shot_visual_bindings.find((value: any) => value.profile_id === derived.id).usage, 'both')
})

test('strict model preparation reuses a confirmed derived profile with its saved relation, delta and board intact', async t => {
  let sceneId = '', shotIds: string[] = [], savedDerived: Record<string, any> | undefined
  const f = await setup(t, async (prompt, contract) => {
    assert.ok(savedDerived)
    assert.match(prompt, /复用已有派生档案时逐字保留其基础关系和state_delta/)
    return JSON.stringify({ profiles: [strictProfileDraft({ ...profile(sceneId), variant: savedDerived.variant,
      definition: savedDerived.definition, view_requirements: savedDerived.view_requirements,
      base_profile_id: savedDerived.base_profile_id, state_delta: savedDerived.state_delta,
      shot_usage: shotIds.map(shot_id => ({ shot_id, usage: 'both', reference_view: null })),
    }, profileWireBranches(contract))] })
  })
  sceneId = f.scene.id
  const original = await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [
    { ...profile(sceneId), draft_key: 'base' },
    { ...profile(sceneId), variant: '蓝色雨衣', draft_key: 'raincoat', base_draft_key: 'base',
      definition: '日漫风格，黑色短发，蓝色雨衣，人物外貌与基础设定一致。', state_delta: '仅将蓝色夹克换成蓝色雨衣。' },
  ] })
  const base = original.visual_profiles.find((value: any) => !value.base_profile_id)
  const derived = original.visual_profiles.find((value: any) => value.base_profile_id)
  for (const saved of [base, derived]) {
    const boardId = `reused-derived-board-${saved.id}`
    run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','board.png','/tmp/board.png','upload',?)", boardId, f.project.id, now())
    await call('PATCH', `/api/visual-profiles/${saved.id}`, { expected_revision: saved.revision, board_asset_id: boardId })
  }
  savedDerived = one<Record<string, any>>('SELECT * FROM visual_profiles WHERE id=?', derived.id)!
  for (let index = 0; index < 2; index++) shotIds.push((await call('POST', `/api/projects/${f.project.id}/shots`, {
    title: `复用雨衣镜头${index + 1}`, source_scene_id: sceneId,
  })).id)
  const before = all('SELECT * FROM visual_profiles WHERE project_id=? ORDER BY id', f.project.id)
  const saved = await f.invoke('commit', { ...await plan(f), reference_usage_version: 1 })
  assert.equal(f.calls(), 1, 'an explicit saved relation with strict null placeholders needs no correction')
  assert.equal(saved.created_profiles, 0); assert.equal(saved.created_shots, 0)
  assert.equal(saved.visual_profiles.length, 2)
  assert.deepEqual(all('SELECT * FROM visual_profiles WHERE project_id=? ORDER BY id', f.project.id), before)
  const reused = saved.visual_profiles.find((value: any) => value.id === derived.id)
  assert.equal(reused.base_profile_id, base.id)
  assert.equal(reused.state_delta, savedDerived.state_delta)
  assert.equal(reused.revision, savedDerived.revision)
  assert.equal(reused.board_asset_id, savedDerived.board_asset_id)
  assert.deepEqual(saved.shot_visual_bindings.filter((value: any) => value.profile_id === derived.id)
    .map((value: any) => [value.shot_id, value.usage, value.revision, value.board_asset_id]),
  shotIds.map(shotId => [shotId, 'both', savedDerived!.revision, savedDerived!.board_asset_id]))
  assert.deepEqual((await f.check()).needs_analysis, [])
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
})

test('independent designs create fresh same-name characters, locations and props without old boards or historical shot bindings', async t => {
  let sceneId = '', shotId = '', oldShotId = '', oldBoardIds: string[] = []
  const definitions = [profile('', '林晚'), { ...profile('', '车站'), kind: 'location' }, { ...profile('', '钥匙'), kind: 'prop' }]
  const f = await setup(t, async prompt => {
    assert.match(prompt, /独立设计方案[\s\S]*蓝白配色与圆形空间结构/)
    for (const board of oldBoardIds) assert.ok(!prompt.includes(board), 'historical pictures must not enter the new design prompt')
    assert.ok(!prompt.includes(oldShotId), 'historical shots must not enter current reference analysis')
    assert.doesNotMatch(prompt, /历史红黑外观/)
    return JSON.stringify({ profiles: definitions.map(value => ({ ...value, scene_ids: [sceneId],
      definition: `蓝白新设计：${value.name}`, shot_usage: [{ shot_id: shotId, usage: 'both' }] })) })
  })
  sceneId = f.scene.id
  const original = await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: definitions.map(value => ({ ...value,
    definition: `历史红黑外观：${value.name}`, scene_ids: [sceneId, f.other.id] })) })
  for (const saved of original.visual_profiles) {
    const boardId = `historical-board-${saved.id}`
    oldBoardIds.push(boardId)
    run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','old.png','/tmp/old.png','upload',?)", boardId, f.project.id, now())
    await call('PATCH', `/api/visual-profiles/${saved.id}`, { expected_revision: 1, board_asset_id: boardId })
  }
  oldShotId = (await call('POST', `/api/projects/${f.project.id}/shots`, { title: '旧方案镜头', source_scene_id: sceneId })).id
  const outsideShot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '选外场次原镜头', source_scene_id: f.other.id })
  const designId = independentDesign(f.project.id, [sceneId], '蓝白方案')
  run('UPDATE shots SET superseded_by=? WHERE id=?', designId, oldShotId)
  shotId = independentShot(f.project.id, sceneId, designId)
  const { inheritSceneVisualBindings } = await import('../src/modules/visuals/visual-profiles.js')
  inheritSceneVisualBindings(shotId, sceneId)
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', shotId), [], 'new shots cannot inherit historical scene candidates')
  const historicalProfiles = all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id)
  const historicalBindings = all('SELECT * FROM shot_visual_bindings WHERE shot_id IN (?, ?)', oldShotId, outsideShot.id)
  const historicalShots = all('SELECT * FROM shots WHERE id IN (?, ?)', oldShotId, outsideShot.id)
  const draft = await plan(f)
  assert.ok(draft.profiles.every((value: any) => value.design_id === designId && value.variant.includes('蓝白方案')))
  const saved = await f.invoke('commit', { ...draft, reference_usage_version: 1 })
  assert.equal(saved.created_profiles, 3)
  assert.deepEqual(saved.shots.map((shot: any) => shot.id), [shotId])
  assert.ok(saved.visual_profiles.every((value: any) => value.design_id === designId && !value.board_asset_id
    && !original.visual_profiles.some((old: any) => old.id === value.id)))
  assert.ok(saved.shot_visual_bindings.every((value: any) => value.shot_id === shotId && !value.board_asset_id && value.reference_assets.length === 0))
  assert.deepEqual(all('SELECT * FROM visual_profiles WHERE project_id=? AND design_id IS NULL', f.project.id), historicalProfiles)
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id IN (?, ?)', oldShotId, outsideShot.id), historicalBindings)
  assert.deepEqual(all('SELECT * FROM shots WHERE id IN (?, ?)', oldShotId, outsideShot.id), historicalShots)
  assert.deepEqual((await f.check()).needs_analysis, [])
  const retry = await f.invoke('commit', await plan(f))
  assert.equal(f.calls(), 1)
  assert.equal(retry.created_profiles, 0)
  assert.deepEqual(retry.visual_profiles.map((value: any) => value.id), saved.visual_profiles.map((value: any) => value.id))
  // Retrying within this design may reuse its own approved resources, never the historical ones.
  const own = saved.visual_profiles[0], ownBoard = `own-board-${own.id}`
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','own.png','/tmp/own.png','upload',?)", ownBoard, f.project.id, now())
  await call('PATCH', `/api/visual-profiles/${own.id}`, { expected_revision: 1, board_asset_id: ownBoard })
  run('UPDATE shots SET video_prompt=? WHERE id=?', '新设计动作补充', shotId)
  const refreshed = await f.invoke('commit', { ...await plan(f), reference_usage_version: 1 })
  assert.equal(refreshed.created_profiles, 0)
  assert.equal(refreshed.visual_profiles.find((value: any) => value.id === own.id).board_asset_id, ownBoard)
  assert.deepEqual(all('SELECT * FROM assets WHERE id IN (?, ?, ?)', ...oldBoardIds).map((value: any) => value.id).sort(), oldBoardIds.sort())
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
})

test('visual commits reject forged design scopes, cross-design bases and historical shot usage atomically', async t => {
  const f = await setup(t)
  const legacy = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(f.scene.id)] })).visual_profiles[0]
  const oldShot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '历史镜头', source_scene_id: f.scene.id })
  const designId = independentDesign(f.project.id, [f.scene.id], '独立方案')
  run('UPDATE shots SET superseded_by=? WHERE id=?', designId, oldShot.id)
  const shotId = independentShot(f.project.id, f.scene.id, designId)
  const checked = await f.check()
  const base = { scene_ids: checked.scene_ids, signature: checked.signature, reference_usage_version: 1 }
  const current = { ...profile(f.scene.id), shot_usage: [{ shot_id: shotId, usage: 'both' }] }
  for (const bad of [{ ...current, design_id: null }, { ...current, design_id: 'other-design' },
    { ...current, base_profile_id: legacy.id, state_delta: '蓝色外衣' },
    { ...current, shot_usage: [{ shot_id: oldShot.id, usage: 'both' }] }]) {
    await f.invoke('commit', { ...base, profiles: [bad] }, 422)
    assert.equal(all('SELECT * FROM visual_profiles WHERE design_id=?', designId).length, 0)
    assert.equal(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', shotId).length, 0)
  }
})

test('mixed current designs are analyzed separately and duplicate draft keys stay within each design', async t => {
  let designs: Array<{ sceneId: string; shotId: string }> = []
  const f = await setup(t, async prompt => {
    const current = designs.find(value => prompt.includes(value.shotId))!
    assert.ok(current)
    assert.equal(designs.filter(value => prompt.includes(value.shotId)).length, 1)
    return JSON.stringify({ profiles: [
      { ...profile(current.sceneId), draft_key: 'base', shot_usage: [{ shot_id: current.shotId, usage: 'none' }] },
      { ...profile(current.sceneId), variant: '蓝衣', draft_key: 'derived', base_draft_key: 'base', state_delta: '换蓝衣',
        shot_usage: [{ shot_id: current.shotId, usage: 'both' }] },
    ] })
  })
  for (const scene of [f.scene, f.other]) {
    const designId = independentDesign(f.project.id, [scene.id], `方案${scene.episode_number}`)
    designs.push({ sceneId: scene.id, shotId: independentShot(f.project.id, scene.id, designId) })
  }
  const scene_ids = designs.map(value => value.sceneId), checked = await f.invoke('check', { scene_ids })
  const draft = await f.invoke('prepare', { scene_ids, signature: checked.signature, model_id: 'mock-text' })
  assert.equal(f.calls(), 2)
  assert.equal(new Set(draft.profiles.map((value: any) => value.draft_key)).size, 4)
  const saved = await f.invoke('commit', { scene_ids, signature: draft.signature, profiles: draft.profiles, reference_usage_version: 1,
    coverage_version: draft.coverage_version, visual_coverage: draft.visual_coverage })
  assert.equal(saved.created_profiles, 4)
  for (const derived of saved.visual_profiles.filter((value: any) => value.base_profile_id)) {
    assert.equal(derived.design_id, saved.visual_profiles.find((value: any) => value.id === derived.base_profile_id).design_id)
  }
  assert.deepEqual((await f.invoke('check', { scene_ids })).needs_analysis, [])
})

test('manual profiles and scene bindings stay in the selected design and return precise created identities', async t => {
  const f = await setup(t)
  const legacy = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(f.scene.id)] })).visual_profiles[0]
  const oldShot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '旧镜头', source_scene_id: f.scene.id })
  const designId = independentDesign(f.project.id, [f.scene.id], '手工方案')
  run('UPDATE shots SET superseded_by=? WHERE id=?', designId, oldShot.id)
  const shotId = independentShot(f.project.id, f.scene.id, designId)
  const manual = { ...profile(f.scene.id), scene_ids: [] }
  const result = await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { design_id: designId, profiles: [manual] })
  assert.equal(result.created_profile_ids.length, 1)
  const created = result.visual_profiles.find((value: any) => value.id === result.created_profile_ids[0])
  assert.equal(created.design_id, designId)
  assert.equal(created.variant, '默认 · 手工方案')
  const repeated = await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { design_id: designId, profiles: [{ ...manual, variant: created.variant }] })
  assert.deepEqual(repeated.created_profile_ids, [])
  assert.equal(repeated.visual_profiles.length, 2)
  const binding = await app.inject({ method: 'PUT', url: `/api/script-scenes/${f.scene.id}/visual-bindings`,
    payload: { bindings: [{ profile_id: created.id, required: true }] } })
  assert.equal(binding.statusCode, 200, binding.body)
  assert.equal(all('SELECT * FROM scene_visual_bindings WHERE scene_id=?', f.scene.id).length, 2, 'replacing current references preserves historical scene candidates')
  await call('POST', `/api/script-scenes/${f.scene.id}/visual-bindings/apply-to-shots`)
  assert.deepEqual(all<{ profile_id: string }>('SELECT profile_id FROM shot_visual_bindings WHERE shot_id=?', shotId).map(value => value.profile_id), [created.id])
  assert.deepEqual(all<{ profile_id: string }>('SELECT profile_id FROM shot_visual_bindings WHERE shot_id=?', oldShot.id).map(value => value.profile_id), [legacy.id])
  const patched = await call('PATCH', `/api/visual-profiles/${created.id}`, { expected_revision: created.revision, variant: '编辑版本' })
  assert.equal(patched.variant, '编辑版本 · 手工方案')
  const immutable = await app.inject({ method: 'PATCH', url: `/api/visual-profiles/${created.id}`,
    payload: { expected_revision: patched.revision, design_id: null } })
  assert.equal(immutable.statusCode, 422, immutable.body)
  const foreign = await setup(t)
  const bad = await app.inject({ method: 'POST', url: `/api/projects/${foreign.project.id}/visual-profiles`,
    payload: { design_id: designId, profiles: [manual] } })
  assert.equal(bad.statusCode, 422, bad.body)
})

test('deleting every current shot keeps the scene design and template preparation cannot revert to historical resources', async t => {
  let sceneId = ''
  const f = await setup(t, async () => JSON.stringify({ profiles: [profile(sceneId)] }))
  sceneId = f.scene.id
  const oldProfile = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(sceneId)] })).visual_profiles[0]
  const oldShot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '历史镜头', source_scene_id: sceneId })
  const designId = independentDesign(f.project.id, [sceneId], '保持的新方案')
  run('UPDATE shots SET superseded_by=? WHERE id=?', designId, oldShot.id)
  const removedId = independentShot(f.project.id, sceneId, designId)
  await call('DELETE', `/api/shots/${removedId}`)
  const { sceneVisualDesignIds } = await import('../src/modules/visuals/visual-profiles.js')
  assert.equal(sceneVisualDesignIds(f.project.id, [sceneId]).get(sceneId), designId)
  const saved = await f.invoke('commit', await plan(f))
  assert.equal(saved.created_shots, 1)
  assert.equal(saved.shots[0].design_id, designId)
  assert.equal(saved.visual_profiles.length, 1)
  assert.equal(saved.visual_profiles[0].design_id, designId)
  assert.notEqual(saved.visual_profiles[0].id, oldProfile.id)
  assert.ok(saved.shot_visual_bindings.every((binding: any) => binding.profile_id === saved.visual_profiles[0].id))
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', oldShot.id).superseded_by, designId)
  assert.deepEqual((await f.check()).needs_analysis, [])
})

test('unexplained empty and all-none model outputs cannot erase bindings or cache preparation success', async t => {
  for (const empty of [true, false]) await t.test(empty ? 'empty profiles' : 'all none', async t => {
    let sceneId = '', shotId = ''
    const f = await setup(t, async () => JSON.stringify({ profiles: empty ? [] : [{ ...profile(sceneId),
      shot_usage: [{ shot_id: shotId, usage: 'none' }] }] }), true)
    sceneId = f.scene.id
    const p = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(sceneId)] })).visual_profiles[0]
    shotId = (await call('POST', `/api/projects/${f.project.id}/shots`, { title: '林晚拿起钥匙', source_scene_id: sceneId, image_prompt: '林晚拿起钥匙' })).id
    const before = all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', shotId)
    assert.ok(before.some((binding: any) => binding.profile_id === p.id && binding.usage === 'both'))
    const checked = await f.check()
    const rejected = await f.invoke('prepare', { scene_ids: checked.scene_ids, signature: checked.signature, model_id: 'mock-text' }, 422)
    assert.match(JSON.stringify(rejected), /已修正一次.*(?:逐镜视觉覆盖|visual_coverage)/)
    assert.equal(f.calls(), 2)
    await f.invoke('commit', { signature: checked.signature, scene_ids: checked.scene_ids, profiles: [], reference_usage_version: 1 }, 422)
    assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', shotId), before)
    assert.deepEqual(all('SELECT * FROM script_canvas_preparations WHERE scene_id=?', sceneId), [])
    assert.deepEqual((await f.check()).needs_analysis, [sceneId])
  })
})

test('declared visible objects require exact profile identity and matching image/video usage before any write', async t => {
  const f = await setup(t)
  const shot = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '人物近景', source_scene_id: f.scene.id,
    image_prompt: '林晚握住钥匙', video_prompt: '林晚举起钥匙' })
  const checked = await f.check()
  const subject = { kind: 'character', name: '林晚', variant: '默认', usage: 'both', requires_profile: true, reason: '镜头主体林晚需要维持固定外貌。' }
  const entry = { scene_id: f.scene.id, shot_id: shot.id, source_excerpt: '林晚握住钥匙', objects: [subject], no_reference_reason: '' }
  const base = { signature: checked.signature, scene_ids: checked.scene_ids, coverage_version: 1, reference_usage_version: 1 }
  for (const profiles of [[], [{ ...profile(f.scene.id, '林婉'), shot_usage: [{ shot_id: shot.id, usage: 'both' }] }],
    [{ ...profile(f.scene.id), shot_usage: [{ shot_id: shot.id, usage: 'none' }] }],
    [{ ...profile(f.scene.id), shot_usage: [{ shot_id: shot.id, usage: 'video' }] }]]) {
    const rejected = await f.invoke('commit', { ...base, profiles, visual_coverage: [entry] }, 422)
    assert.match(JSON.stringify(rejected), /缺少对应档案或镜头用途/)
    assert.deepEqual(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id), [])
    assert.deepEqual(all('SELECT * FROM script_canvas_preparations WHERE scene_id=?', f.scene.id), [])
  }
  for (const entries of [[], [entry, entry], [{ ...entry, shot_id: 'foreign-shot' }], [{ ...entry, source_excerpt: '虚构摘录' }]]) {
    await f.invoke('commit', { ...base, profiles: [{ ...profile(f.scene.id), shot_usage: [{ shot_id: shot.id, usage: 'both' }] }], visual_coverage: entries }, 422)
  }
  const saved = await f.invoke('commit', { ...base, profiles: [{ ...profile(f.scene.id), shot_usage: [{ shot_id: shot.id, usage: 'both' }] }], visual_coverage: [entry] })
  assert.equal(saved.created_profiles, 1)
  assert.equal(saved.shot_visual_bindings[0].usage, 'both')
})

test('reasoned empty shots remain valid and only explicitly covered shots keep references', async t => {
  let sceneId = '', emptyId = '', visibleId = ''
  const f = await setup(t, async () => JSON.stringify({ profiles: [{ ...profile(sceneId), shot_usage: [
    { shot_id: emptyId, usage: 'none' }, { shot_id: visibleId, usage: 'video' },
  ] }], visual_coverage: [
    { scene_id: sceneId, shot_id: emptyId, source_excerpt: '纯黑画面，仅有画外对白', objects: [], no_reference_reason: '纯黑画面没有人物、场景或道具出镜，画外对白不需要形象参考。' },
    { scene_id: sceneId, shot_id: visibleId, source_excerpt: '林晚从画外走入', objects: [{ kind: 'character', name: '林晚', variant: '默认',
      usage: 'video', requires_profile: true, reason: '人物仅在视频过程中进入，开镜图片不出现。' }], no_reference_reason: '' },
  ] }), true)
  sceneId = f.scene.id
  emptyId = (await call('POST', `/api/projects/${f.project.id}/shots`, { title: '林晚的画外声音', source_scene_id: sceneId,
    image_prompt: '纯黑画面，仅有画外对白' })).id
  visibleId = (await call('POST', `/api/projects/${f.project.id}/shots`, { title: '人物入画', source_scene_id: sceneId,
    image_prompt: '纯黑画面', video_prompt: '林晚从画外走入' })).id
  const saved = await f.invoke('commit', await plan(f))
  assert.equal(f.calls(), 1)
  assert.equal(saved.shot_visual_bindings.find((binding: any) => binding.shot_id === emptyId).usage, 'none')
  assert.equal(saved.shot_visual_bindings.find((binding: any) => binding.shot_id === visibleId).usage, 'video')
  assert.deepEqual((await f.check()).needs_analysis, [])
  const calls = f.calls()
  await f.invoke('commit', await plan(f))
  assert.equal(f.calls(), calls, 'valid coverage cache avoids another paid request')
})

test('reasoned empty scene templates exclude old scene candidates without deleting them', async t => {
  let sceneId = ''
  const f = await setup(t, async () => JSON.stringify({ profiles: [], visual_coverage: [{ scene_id: sceneId, shot_id: null,
    source_excerpt: '黑屏转场', objects: [], no_reference_reason: '本场只有黑屏转场与画外声音，无可见对象，不需要参考图。' }] }), true)
  sceneId = f.scene.id
  await call('PATCH', `/api/script-scenes/${sceneId}`, { action: '黑屏转场' })
  const historical = (await call('POST', `/api/projects/${f.project.id}/visual-profiles`, { profiles: [profile(sceneId)] })).visual_profiles[0]
  const saved = await f.invoke('commit', await plan(f))
  assert.equal(saved.created_shots, 1)
  assert.equal(saved.shot_visual_bindings.find((binding: any) => binding.profile_id === historical.id).usage, 'none')
  assert.ok(one('SELECT 1 FROM scene_visual_bindings WHERE scene_id=? AND profile_id=?', sceneId, historical.id))
  assert.deepEqual((await f.check()).needs_analysis, [])
})

test('scene template coverage preserves image-only and video-only reference decisions after creating shot IDs', async t => {
  for (const usage of ['image', 'video'] as const) await t.test(usage, async t => {
    let sceneId = ''
    const f = await setup(t, async () => JSON.stringify({ profiles: [{ ...profile(sceneId), shot_usage: [] }], visual_coverage: [{
      scene_id: sceneId, shot_id: null, source_excerpt: '拿起钥匙', objects: [{ kind: 'character', name: '林晚', variant: '默认',
        usage, requires_profile: true, reason: usage === 'video' ? '开镜黑屏，林晚只在动作过程中入画。' : '林晚仅在开镜画面出现，动作后离开画面。' }], no_reference_reason: '',
    }] }), true)
    sceneId = f.scene.id
    const saved = await f.invoke('commit', await plan(f))
    assert.equal(saved.created_shots, 1)
    assert.equal(saved.shot_visual_bindings[0].shot_id, saved.shots[0].id)
    assert.equal(saved.shot_visual_bindings[0].usage, usage)
    assert.deepEqual((await f.check()).needs_analysis, [])
  })
})
