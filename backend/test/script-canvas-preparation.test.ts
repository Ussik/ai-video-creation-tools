import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { ScriptScene, ScriptArtifact } from '../src/db.js'

const testData = await mkdtemp(join(tmpdir(), 'script-canvas-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { all, db, now, one, run } = await import('../src/db.js')
const { registerScriptCanvasRoutes } = await import('../src/script-canvas-preparation.js')
const { installSkillBundle, configureSkill, removeInstalledSkill, setSkillDefault } = await import('../src/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, generator: (prompt: string) => Promise<string> = async () => JSON.stringify({ profiles: [] })) {
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
    generateText: async (_id, model, prompt, contract) => { assert.equal(model, 'mock-text'); assert.equal(contract?.name, 'visual_profiles'); calls++; return generator(prompt) },
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
  const result = await f.invoke('commit', draft)
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
  const f = await setup(t, async () => JSON.stringify({ profiles: [{ ...profile(sceneId), definition: '不能覆盖原文' }] }))
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
