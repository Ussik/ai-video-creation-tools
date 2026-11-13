import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { ScriptScene, Shot } from '../src/infrastructure/database/db.js'
import { storyboardBatchFixture, storyboardOutlineFixture, withStoryboardDirecting } from './helpers/storyboard-directing.js'
import { fixtureVisualCoverage, withFixtureVisualCoverage } from './helpers/visual-coverage.js'

const directory = await mkdtemp(join(tmpdir(), 'storyboard-reference-budget-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, now, run } = await import('../src/infrastructure/database/db.js')
const { registerScriptCanvasRoutes } = await import('../src/modules/canvas/script-canvas-preparation.js')
const { registerStoryboardPlanningRoutes } = await import('../src/modules/storyboard/storyboard-planning.js')
const { storyboardReferenceBudget, storyboardReferenceBudgetIssues } = await import('../src/modules/storyboard/storyboard-reference-budget.js')
const { projectVisualStyle } = await import('../src/modules/visuals/project-visual-style.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call(method: 'POST' | 'GET', url: string, payload?: object) {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project = await call('POST', '/api/projects', { name: '参考图预算' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '两组人员', duration: 20 })
  const first = await call('POST', `/api/projects/${project.id}/shots`, { title: '第一组八人', source_scene_id: scene.id, duration_ms: 10000,
    image_prompt: '第一组八人正面站立', video_prompt: '第一组八人转身', start_state: '站立' })
  const second = await call('POST', `/api/projects/${project.id}/shots`, { title: '第九人反应', source_scene_id: scene.id, duration_ms: 10000,
    image_prompt: '第九人正面特写', video_prompt: '第九人回头', start_state: '站立' })
  const profiles = Array.from({ length: 9 }, (_, index) => ({ kind: 'character' as const, name: `人物${index + 1}`, variant: '默认',
    definition: `人物${index + 1}的固定形象`, view_requirements: '正侧背', scene_ids: [scene.id],
    shot_usage: [{ shot_id: first.id, usage: index < 8 ? 'both' as const : 'none' as const },
      { shot_id: second.id, usage: index === 8 ? 'both' as const : 'none' as const }] }))
  return { project, scene, first, second, profiles }
}
function coverage(f: Awaited<ReturnType<typeof fixture>>, profiles = f.profiles) {
  return { coverage_version: 1, visual_coverage: fixtureVisualCoverage(profiles, [f.scene], [f.first, f.second].map(shot => ({ ...shot, shot_id: shot.id, scene_id: f.scene.id }))) }
}

test('planning reserves one composition slot, respects stricter models and invalidates stale model budgets', async () => {
  const f = await fixture()
  const context = await call('POST', `/api/projects/${f.project.id}/script/storyboard/context`, { scene_ids: [f.scene.id] })
  assert.deepEqual(context.reference_budget, { max_images: 9, storyboard_images: 1, max_setting_images: 8 })
  const provider = await call('POST', '/api/providers', { name: '预算模型', adapter: 'http', base_url: 'https://example.invalid' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '五图视频', remote_id: 'configured', modality: 'video', protocol: 'async_video',
    settings: { supported_modes: ['reference'], create_path: '/video', get_path: '/video/{id}', request_template: { images: '{{images}}' }, max_reference_images: 5 } })
  try {
    assert.deepEqual(storyboardReferenceBudget(), { max_images: 5, storyboard_images: 1, max_setting_images: 4 })
    const next = await call('POST', `/api/projects/${f.project.id}/script/storyboard/context`, { scene_ids: [f.scene.id] })
    assert.notEqual(next.signature, context.signature)
  } finally { run('UPDATE models SET enabled=0 WHERE id=?', model.id) }
})

test('nine scene candidates are allowed when each shot fits eight settings plus one storyboard; over-budget analysis gets corrected', async () => {
  const f = await fixture(), routes = Fastify()
  let calls = 0
  registerScriptCanvasRoutes(routes, {
    script: id => ({ outline: '', characters: '', scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', id) }),
    scenePrompt: scene => scene.heading,
    generateText: async (_project, _model, prompt) => {
      assert.match(prompt, /视频最多 9 张.*预留 1 张/)
      if (++calls === 1) return withFixtureVisualCoverage(JSON.stringify({ profiles: f.profiles.map(profile => ({ ...profile,
        shot_usage: profile.shot_usage.map(item => item.shot_id === f.first.id ? { ...item, usage: 'both' } : item) })) }), prompt)
      assert.match(prompt, /一次格式修正[\s\S]*需 9 张设定参考图，最多允许 8 张/)
      return withFixtureVisualCoverage(JSON.stringify({ profiles: f.profiles }), prompt)
    },
  })
  try {
    const url = `/api/projects/${f.project.id}/script/canvas`
    const checked = (await routes.inject({ method: 'POST', url: `${url}/check`, payload: { scene_ids: [f.scene.id] } })).json()
    const response = await routes.inject({ method: 'POST', url: `${url}/prepare`, payload: { signature: checked.signature, scene_ids: [f.scene.id], model_id: 'mock' } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(calls, 2)
    const prepared = response.json()
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0, 'analysis must stay read-only')
    const saved = await routes.inject({ method: 'POST', url: `${url}/commit`, payload: { signature: prepared.signature,
      scene_ids: prepared.scene_ids, profiles: prepared.profiles, reference_usage_version: prepared.reference_usage_version,
      coverage_version: prepared.coverage_version, visual_coverage: prepared.visual_coverage } })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 9)
    assert.deepEqual(storyboardReferenceBudgetIssues(f.project.id, [f.scene.id]), [])
    const ready = (await routes.inject({ method: 'POST', url: `${url}/check`, payload: { scene_ids: [f.scene.id] } })).json()
    assert.deepEqual(ready.needs_analysis, [])
  } finally { await routes.close() }
})

test('over-budget drafts are rejected before writing references; existing shots and media stay intact', async () => {
  const f = await fixture(), routes = Fastify()
  registerScriptCanvasRoutes(routes, {
    script: id => ({ outline: '', characters: '', scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', id) }),
    scenePrompt: scene => scene.heading, generateText: async () => { throw new Error('No model calls while committing') },
  })
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=?', f.project.id)
  try {
    const url = `/api/projects/${f.project.id}/script/canvas`
    const checked = (await routes.inject({ method: 'POST', url: `${url}/check`, payload: { scene_ids: [f.scene.id] } })).json()
    const overProfiles = f.profiles.map(profile => ({ ...profile, shot_usage: profile.shot_usage.map(item => ({ ...item, usage: 'both' as const })) }))
    const response = await routes.inject({ method: 'POST', url: `${url}/commit`, payload: { signature: checked.signature, scene_ids: [f.scene.id], reference_usage_version: 1,
      profiles: overProfiles, ...coverage(f, overProfiles) } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /最多允许 8 张.*分镜图预留 1 张/)
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
    assert.deepEqual(all('SELECT * FROM shots WHERE project_id=?', f.project.id), shots)
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
  } finally { await routes.close() }
})

test('budget counts frozen images instead of profiles and deduplicates images shared by multiple objects', async () => {
  const f = await fixture(), stamp = now()
  const snapshots = Array.from({ length: 9 }, (_, i) => ({ id: `ref-${i}`, asset_id: `image-${i}`, view: 'front', purpose: 'costume', label: '', revision: 1, style_version: null }))
  for (let i = 0; i < 2; i++) {
    const id = `${f.project.id}-profile-${i}`
    run(`INSERT INTO visual_profiles (id,project_id,kind,name,variant,definition,view_requirements,created_at,updated_at)
      VALUES (?,?,'character',?,'默认','固定外观','正面',?,?)`, id, f.project.id, `人物${i}`, stamp, stamp)
    run(`INSERT INTO shot_visual_bindings (shot_id,profile_id,required,revision,kind,name,variant,definition,view_requirements,reference_assets,usage)
      VALUES (?,?,1,1,'character',?,'默认','固定外观','正面',?,'both')`, f.first.id, id, `人物${i}`, JSON.stringify(snapshots.slice(i ? 7 : 0, i ? 9 : 8)))
  }
  assert.match(storyboardReferenceBudgetIssues(f.project.id, [f.scene.id])[0]!.message, /需 9 张设定参考图/)
  run('UPDATE shot_visual_bindings SET reference_assets=? WHERE shot_id=? AND name=?', JSON.stringify(snapshots.slice(6, 8)), f.first.id, '人物1')
  assert.deepEqual(storyboardReferenceBudgetIssues(f.project.id, [f.scene.id]), [])
})

test('analysis that remains over budget after correction rejects without changing shots or creating assets', async () => {
  const f = await fixture(), routes = Fastify()
  let calls = 0
  registerScriptCanvasRoutes(routes, {
    script: id => ({ outline: '', characters: '', scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', id) }),
    scenePrompt: scene => scene.heading,
    generateText: async (_project, _model, prompt) => {
      calls++
      return withFixtureVisualCoverage(JSON.stringify({ profiles: f.profiles.map(profile => ({ ...profile,
        shot_usage: profile.shot_usage.map(item => ({ ...item, usage: 'both' })) })) }), prompt)
    },
  })
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=?', f.project.id)
  try {
    const url = `/api/projects/${f.project.id}/script/canvas`
    const checked = (await routes.inject({ method: 'POST', url: `${url}/check`, payload: { scene_ids: [f.scene.id] } })).json()
    const response = await routes.inject({ method: 'POST', url: `${url}/prepare`, payload: { signature: checked.signature, scene_ids: [f.scene.id], model_id: 'mock' } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /已修正一次.*需 9 张设定参考图/)
    assert.equal(calls, 2)
    assert.deepEqual(all('SELECT * FROM shots WHERE project_id=?', f.project.id), shots)
    for (const table of ['visual_profiles', 'assets', 'jobs']) assert.deepEqual(all(`SELECT * FROM ${table} WHERE project_id=?`, f.project.id), [])
    assert.deepEqual(all('SELECT * FROM script_canvas_preparations WHERE scene_id=?', f.scene.id), [])
  } finally { await routes.close() }
})

test('prepared scenes need analysis again when frozen references grow beyond the setting budget', async () => {
  const f = await fixture()
  const url = `/api/projects/${f.project.id}/script/canvas`
  const checked = await call('POST', `${url}/check`, { scene_ids: [f.scene.id] })
  await call('POST', `${url}/commit`, { signature: checked.signature, scene_ids: [f.scene.id], profiles: f.profiles, reference_usage_version: 1, ...coverage(f) })
  const ready = await call('POST', `${url}/check`, { scene_ids: [f.scene.id] })
  assert.deepEqual(ready.needs_analysis, [])
  const snapshots = ['face', 'front'].map(view => ({ id: `${f.project.id}-${view}`, asset_id: `${f.project.id}-${view}`, view,
    purpose: view === 'face' ? 'identity' : 'costume', label: '', revision: 1, style_version: null }))
  run('UPDATE shot_visual_bindings SET reference_assets=? WHERE shot_id=? AND name=?', JSON.stringify(snapshots), f.first.id, '人物1')
  const next = await call('POST', `${url}/check`, { scene_ids: [f.scene.id] })
  assert.deepEqual(next.needs_analysis, [f.scene.id])
  assert.notEqual(next.signature, ready.signature)
  assert.match(storyboardReferenceBudgetIssues(f.project.id, [f.scene.id])[0]!.message, /需 9 张设定参考图/)
})

test('projected references use confirmed defaults for both video and inheritance, counting face plus body separately', async () => {
  const f = await fixture(), stamp = now(), style = projectVisualStyle(f.project.id)
  run('UPDATE shots SET video_prompt=? WHERE id=?', '五人背面行走', f.first.id)
  const profiles = f.profiles.slice(0, 5).map(profile => ({ ...profile,
    shot_usage: profile.shot_usage.map(item => ({ ...item, usage: item.shot_id === f.first.id ? 'video' as const : 'none' as const })) }))
  const saved = await call('POST', `/api/projects/${f.project.id}/visual-profiles`, {
    profiles: profiles.map(({ shot_usage: _usage, ...profile }) => ({ ...profile, scene_ids: [] })),
  })
  for (const profile of saved.visual_profiles) for (const view of ['face', 'front', 'back']) {
    const id = `${profile.id}-${view}`, purpose = view === 'face' ? 'identity' : 'costume'
    run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','ref.png','/tmp/ref.png','upload',?)", id, f.project.id, stamp)
    run(`INSERT INTO visual_profile_reference_assets
      (id,profile_id,asset_id,revision,style_version,view,purpose,label,status,is_default,created_at,updated_at)
      VALUES (?,?,?,1,?,?,?,'','confirmed',1,?,?)`, id, profile.id, id, style.version, view, purpose, stamp, stamp)
  }
  assert.match(storyboardReferenceBudgetIssues(f.project.id, [f.scene.id], profiles)[0]!.message,
    /视频过程.*需 10 张设定参考图/, 'a back-view mention in prose cannot remove confirmed face/default references')
  assert.match(storyboardReferenceBudgetIssues(f.project.id, [f.scene.id], profiles, { inheritSceneReferences: true })[0]!.message,
    /视频过程.*需 10 张设定参考图/, 'canvas inheritance freezes five face and five front images')
  const url = `/api/projects/${f.project.id}/script/canvas`
  const checked = await call('POST', `${url}/check`, { scene_ids: [f.scene.id] })
  const response = await app.inject({ method: 'POST', url: `${url}/commit`, payload: { signature: checked.signature,
    scene_ids: [f.scene.id], profiles, reference_usage_version: 1, ...coverage(f, profiles) } })
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /需 10 张设定参考图/)
  assert.deepEqual(all('SELECT * FROM scene_visual_bindings WHERE scene_id=?', f.scene.id), [])
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', f.first.id), [])
})

test('the storyboard director receives the reference budget before planning shots', async () => {
  const f = await fixture(), routes = Fastify()
  registerStoryboardPlanningRoutes(routes, {
    script: id => ({ outline: '', characters: '', scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', id) }),
    scenePrompt: scene => scene.heading,
    generateText: async (_project, _model, prompt, contract) => {
      if (contract?.name === 'storyboard_directing_review') return JSON.stringify({ issues: [] })
      assert.match(prompt, /视频最多 9 张.*预留 1 张.*各最多使用 8 张/)
      assert.match(prompt, /面部图和身体图是两张/)
      assert.match(prompt, /拆成有叙事意义.*保留原有剧情、对白和关键对象/)
      if (contract?.name === 'storyboard_outline_review') return JSON.stringify({ issues: [] })
      const plan = withStoryboardDirecting({ scenes: [{ scene_id: f.scene.id, scene_duration: 20,
        shots: [f.first, f.second].map(shot => ({ shot_id: shot.id, title: shot.title, prompt: '保留当前叙事',
          image_prompt: shot.image_prompt, video_prompt: shot.video_prompt, duration: 10,
          audio_plan: { version: 1, speech: [], sound_effects: [], music: '', silent: true },
          start_state: shot.start_state, end_state: '人物动作完成，保持原有站位关系', cut_note: '按人物反应承接并收束' })) }] })
      return JSON.stringify(contract?.name === 'storyboard_scene_plan' ? storyboardOutlineFixture(plan)
        : contract?.name === 'storyboard_shot_batch' ? storyboardBatchFixture(plan, contract) : plan)
    },
  })
  try {
    const url = `/api/projects/${f.project.id}/script/storyboard`
    const context = (await routes.inject({ method: 'POST', url: `${url}/context`, payload: { scene_ids: [f.scene.id] } })).json()
    const response = await routes.inject({ method: 'POST', url: `${url}/plan`, payload: { signature: context.signature,
      scene_ids: [f.scene.id], model_id: 'mock', skill_ids: [] } })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().scenes[0].shots.map((shot: { shot_id: string }) => shot.shot_id), [f.first.id, f.second.id])
  } finally { await routes.close() }
})
