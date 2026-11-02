import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { ScriptScene, ScriptArtifact } from '../src/infrastructure/database/db.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'

const testData = await mkdtemp(join(tmpdir(), 'script-canvas-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const { registerScriptCanvasRoutes } = await import('../src/modules/canvas/script-canvas-preparation.js')
const { installSkillBundle, configureSkill, removeInstalledSkill, setSkillDefault } = await import('../src/modules/skills/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, generator: (prompt: string, contract: OutputContract) => Promise<string> = async () => JSON.stringify({ profiles: [] })) {
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
      // Without an injected native selector, automatic skill selection is its own structured request (not a profile
      // analysis). It chooses nothing here, so the project/temporary skill settings under test decide what loads.
      if (contract.name === 'creation_skill_selection') {
        // A model that has no better idea adopts the project default shown to it (defaults are references, not locks).
        const shown = /"default_ids":(\[[^\]]*\])/.exec(prompt)
        return JSON.stringify({ skill_ids: shown ? JSON.parse(shown[1]!) : [], reason: '测试：沿用目录中给出的项目默认技能。' })
      }
      assert.equal(contract.name, 'visual_profiles'); calls++; return generator(prompt, contract)
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
  const { signature, scene_ids, profiles } = await f.invoke('prepare', { scene_ids: checked.scene_ids, signature: checked.signature, model_id: 'mock-text' })
  return { signature, scene_ids, profiles }
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
  t.after(async () => { removeInstalledSkill(main); removeInstalledSkill(alternate) })
  let captured = ''
  const f = await setup(t, async prompt => { captured = prompt; return JSON.stringify({ profiles: [] }) })
  setSkillDefault('visual_assets', { primary_id: alternate, auxiliary_ids: [] }, f.project.id)
  const checked = await f.check(), request = { signature: checked.signature, scene_ids: checked.scene_ids, model_id: 'mock-text' }
  const inherited = await f.invoke('prepare', request)
  assert.deepEqual(inherited.used_skills.map((value: { id: string }) => value.id), [alternate])
  assert.match(captured, /RULE_visual-alternate/); assert.doesNotMatch(captured, /RULE_visual-primary/)
  assert.ok(inherited.loaded_files.length > 0)
  const switched = await f.invoke('prepare', { ...request, skill_ids: [main] })
  assert.deepEqual(switched.used_skills.map((value: { id: string; role: string }) => [value.id, value.role]), [[main, 'primary']])
  assert.match(captured, /RULE_visual-primary/); assert.doesNotMatch(captured, /RULE_visual-alternate/)
  const base = await f.invoke('prepare', { ...request, skill_ids: [] })
  assert.deepEqual(base.used_skills, []); assert.deepEqual(base.loaded_files, []); assert.doesNotMatch(captured, /RULE_visual-/)
  await f.invoke('prepare', { ...request, skill_ids: ['foreign'] }, 422)
  assert.equal(f.calls(), 3)
  await f.invoke('commit', { signature: base.signature, scene_ids: base.scene_ids, profiles: base.profiles })
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
    reference_usage_version: draft.reference_usage_version })
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

test('strict model output with nullable optional fields prepares and commits legacy and independent design references', async t => {
  for (const redesign of [false, true]) await t.test(redesign ? 'independent design' : 'legacy design', async t => {
    let sceneId = '', shotId = '', profileContract: { properties: Record<string, unknown>; required: string[] } | undefined
    const f = await setup(t, async (_prompt, contract) => {
      profileContract = (contract.schema.properties as { profiles: { items: typeof profileContract } }).profiles.items
      assert.ok(profileContract)
      const drafts: Array<Record<string, unknown>> = [
        { ...profile(sceneId), draft_key: 'base', shot_usage: [{ shot_id: shotId, usage: 'none' }] },
        { ...profile(sceneId), variant: '蓝衣', draft_key: 'derived', base_draft_key: 'base', state_delta: '换蓝衣',
          shot_usage: [{ shot_id: shotId, usage: 'both' }] },
      ]
      // Strict providers emit every required wire field, using null for absent optional values.
      for (const draft of drafts) for (const key of profileContract.required) if (!(key in draft)) draft[key] = null
      return JSON.stringify({ profiles: drafts })
    })
    sceneId = f.scene.id
    const designId = redesign ? independentDesign(f.project.id, [sceneId], '严格输出新方案') : null
    shotId = designId ? independentShot(f.project.id, sceneId, designId)
      : (await call('POST', `/api/projects/${f.project.id}/shots`, { title: '原方案镜头', source_scene_id: sceneId })).id
    const draft = await plan(f)
    assert.equal(f.calls(), 1, 'valid strict output must not need a format correction')
    assert.ok(profileContract)
    assert.ok(!('design_id' in profileContract.properties), 'model output cannot choose the server-owned design scope')
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
  const saved = await f.invoke('commit', { scene_ids, signature: draft.signature, profiles: draft.profiles, reference_usage_version: 1 })
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
