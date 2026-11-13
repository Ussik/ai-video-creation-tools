import { candidateQualityAccepted } from '@video-studio/shared/api/ai-candidate-quality'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { semanticReviewFixture } from './helpers/prompt-refinement-semantics.js'
import { withFixtureVisualCoverage } from './helpers/visual-coverage.js'
import { withStoryboardDirecting, storyboardOutlineFixture, storyboardBatchFixture } from './helpers/storyboard-directing.js'
import Fastify from 'fastify'
import type { ScriptScene, ScriptArtifact } from '../src/infrastructure/database/db.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
const directory = await mkdtemp(join(tmpdir(), 'creative-unit-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, run } = await import('../src/infrastructure/database/db.js')
const { registerStoryboardPlanningRoutes } = await import('../src/modules/storyboard/storyboard-planning.js')
const { registerVisualProfileRoutes } = await import('../src/modules/visuals/visual-profiles.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function create(url: string, payload: object) {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body); return response.json()
}
async function project(sceneCount: number) {
  const value = await create('/api/projects', { name: '完整创作单元恢复' })
  const scenes: ScriptScene[] = []
  for (let index = 0; index < sceneCount; index++) scenes.push(await create(`/api/projects/${value.id}/script/scenes`, { heading: `场次${index + 1}`, duration: 20 }))
  return { ...value, scenes }
}
function routes() {
  const value = Fastify()
  value.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 500).send({ detail: String(error) }))
  return value
}
function script(id: string) { return { outline: '连续故事', characters: '林晚', scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', id), artifacts: [] as ScriptArtifact[] } }
const transient = () => Object.assign(new Error('测试中断，尚未完成'), { statusCode: 422 })
function shot() { return { audio_plan: { version: 1, speech: [], sound_effects: [], music: '', silent: true }, shot_id: null, title: '等待', duration: 20, prompt: '林晚站在门边等待', image_prompt: '林晚站在门边', video_prompt: '林晚抬头等待', start_state: '站立', end_state: '抬头', cut_note: '顺接' } }

test('three-scene durable planning resumes only unfinished scenes, while a fresh task and changed source generate anew', async t => {
  const f = await project(3), isolated = routes(); t.after(() => isolated.close())
  const calls: string[] = []; let fail = true, outlines = 0
  const full = withStoryboardDirecting({ scenes: f.scenes.map(scene => ({ scene_id: scene.id, scene_duration: 20, shots: [shot()] })) })
  registerStoryboardPlanningRoutes(isolated, { script, scenePrompt: value => value.heading,
    generateText: async (_id, _model, _prompt, contract) => {
      if (contract?.name === 'storyboard_scene_plan') { outlines++; return JSON.stringify(storyboardOutlineFixture(full)) }
      if (contract?.name === 'storyboard_directing_review') return JSON.stringify({ issues: [] })
      assert.equal(contract?.name, 'storyboard_shot_batch')
      const batch = storyboardBatchFixture(full, contract!)
      calls.push(batch.scene_id)
      if (batch.scene_id === f.scenes[1].id && fail) throw transient()
      return JSON.stringify(batch)
    } })
  const url = `/api/projects/${f.id}/script/storyboard`
  const context = () => isolated.inject({ method: 'POST', url: `${url}/context`, payload: { scene_ids: f.scenes.map(value => value.id) } })
  const snapshot = await context(), payload = { scene_ids: f.scenes.map(value => value.id), signature: snapshot.json().signature, model_id: 'mock', skill_ids: [] }
  async function wait(id: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await isolated.inject({ method: 'GET', url: `${url}/tasks/${id}` })
      assert.equal(response.statusCode, 200, response.body)
      if (response.json().status !== 'running') return response.json()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    throw new Error('planning task did not settle')
  }
  async function start(patch = {}) {
    const response = await isolated.inject({ method: 'POST', url: `${url}/tasks`, payload: { ...payload, ...patch, request_id: randomUUID(), fresh: true } })
    assert.equal(response.statusCode, 200, response.body)
    return wait(response.json().id)
  }
  const first = await start(); assert.equal(first.status, 'failed'); assert.equal(first.can_resume, true)
  fail = false
  assert.equal((await isolated.inject({ method: 'POST', url: `${url}/tasks/${first.id}/resume` })).statusCode, 200)
  const resumed = await wait(first.id); assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed))
  assert.equal(outlines, 1, 'resume retains the locked full outline')
  assert.deepEqual(calls, [f.scenes[0].id, f.scenes[1].id, f.scenes[1].id, f.scenes[2].id])
  fail = true; assert.equal((await start()).status, 'failed')
  fail = false; const before = calls.length
  assert.equal((await start()).status, 'succeeded')
  assert.deepEqual(calls.slice(before), f.scenes.map(value => value.id))
  fail = true; const old = await start(); assert.equal(old.status, 'failed')
  run('UPDATE script_scenes SET action=? WHERE id=?', '源剧情更新', f.scenes[0].id)
  assert.equal((await isolated.inject({ method: 'POST', url: `${url}/tasks/${old.id}/resume` })).statusCode, 409)
  fail = false; const changed = await context(), prior = calls.length
  assert.equal((await start({ signature: changed.json().signature })).status, 'succeeded')
  assert.deepEqual(calls.slice(prior), f.scenes.map(value => value.id))
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.id).length, 0)
})

test('large visual analysis keeps the shared object catalog and base definition across a variant failure', async t => {
  const f = await project(10), isolated = routes(); t.after(() => isolated.close())
  const scene_ids = f.scenes.map(value => value.id)
  const base = { draft_key: 'base', kind: 'character', name: '林晚', variant: '默认', scene_ids }
  const variant = { ...base, draft_key: 'mud', variant: '手背泥点', base_draft_key: 'base', state_delta: '右手背少量泥点' }
  const calls: string[] = []; let fail = true
  registerVisualProfileRoutes(isolated, { script, generateText: async (_id, _model, prompt, contract) => {
    if (contract?.name === 'visual_profile_catalog') { calls.push('catalog'); return JSON.stringify({ profiles: [variant, base] }) }
    assert.equal(contract?.name, 'visual_profiles')
    const current = JSON.parse(prompt.split('【当前完整对象单元】')[1]!.split('：')[1]!.split('\n')[0]!)
    calls.push(current.draft_key)
    if (current.draft_key === 'mud' && fail) throw transient()
    if (current.draft_key === 'mud') assert.match(prompt, /已完成基础版本.*黑色短发/)
    return JSON.stringify({ profiles: [{ ...current, definition: '黑色短发，蓝色夹克；派生状态只改变手背。', view_requirements: '正侧背与手背局部', shot_usage: [] }] })
  } })
  const invoke = () => isolated.inject({ method: 'POST', url: `/api/projects/${f.id}/visual-profiles/analyze`, payload: { model_id: 'mock', scene_ids, skill_ids: [] } })
  assert.equal((await invoke()).statusCode, 422)
  run('UPDATE projects SET updated_at=? WHERE id=?', 'unrelated-touch', f.id)
  fail = false
  const response = await invoke(); assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(calls, ['catalog', 'base', 'mud', 'mud'])
  assert.equal(response.json().profiles[1].base_draft_key, 'base')
  assert.equal(all('SELECT id FROM visual_profiles WHERE project_id=?', f.id).length, 0)
})

test('prompt review failures preserve the validated candidate and explicit restart replaces it', async t => {
  const f = await project(0), isolated = routes(); t.after(() => isolated.close())
  let candidates = 0, reviews = 0, fail = true
  registerSkillRoutes(isolated, { generateText: async (_id, _model, _prompt, contract) => {
    if (contract?.name === 'refined_prompt') { candidates++; return JSON.stringify({ prompt: '林晚站在门边，抬头等待。' }) }
    assert.equal(contract?.name, 'prompt_refinement_semantic_review'); reviews++
    if (fail) throw transient()
    return JSON.stringify({ ...semanticReviewFixture(), content_review: { primary_action: '抬头', secondary_actions: [], start_state: '站立', end_state: '抬头', visible_result: '看向门口', facts: [], issues: [], reference_findings: [] } })
  } })
  const invoke = (restart = false) => isolated.inject({ method: 'POST', url: `/api/projects/${f.id}/skills/refine-prompt`, payload: { model_id: 'mock', stage: 'video_prompt', prompt: '林晚站在门边，抬头等待。', skill_ids: [], check_video_content: true, restart } })
  const interrupted = await invoke()
  assert.equal(interrupted.statusCode, 200)
  assert.equal(interrupted.json().quality.status, 'inconclusive')
  assert.equal(candidateQualityAccepted(interrupted.json().quality), false)
  assert.equal(interrupted.json().prompt_body, '林晚站在门边，抬头等待。')
  fail = false
  const resumed = await invoke()
  assert.equal(resumed.statusCode, 200)
  assert.equal(candidateQualityAccepted(resumed.json().quality), true)
  assert.equal(candidates, 1); assert.equal(reviews, 2)
  fail = true
  const next = await invoke()
  assert.equal(next.statusCode, 200)
  assert.equal(next.json().quality.status, 'inconclusive')
  assert.equal(candidateQualityAccepted(next.json().quality), false)
  fail = false
  const restarted = await invoke(true)
  assert.equal(restarted.statusCode, 200)
  assert.equal(candidateQualityAccepted(restarted.json().quality), true)
  assert.equal(candidates, 3, 'restart deliberately discards the interrupted candidate')
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', f.id).length, 0)
})

test('disconnecting during the first scene stops all later dispatches', async t => {
  const f = await project(3), isolated = routes(); t.after(() => isolated.close())
  let raw: import('node:http').IncomingMessage, calls = 0
  isolated.addHook('preHandler', async request => { raw = request.raw })
  registerStoryboardPlanningRoutes(isolated, { script, scenePrompt: value => value.heading,
    generateText: async (_id, _model, _prompt, contract, signal) => {
      calls++; raw.emit('aborted'); assert.equal(signal?.aborted, true)
      const item = (contract!.schema.properties as any).scenes.items.properties.scene_id
      return JSON.stringify({ scenes: [{ scene_id: item.const || item.enum[0], scene_duration: 20, shots: [shot()] }] })
    } })
  const scene_ids = f.scenes.map(value => value.id)
  const context = await isolated.inject({ method: 'POST', url: `/api/projects/${f.id}/script/storyboard/context`, payload: { scene_ids } })
  const response = await isolated.inject({ method: 'POST', url: `/api/projects/${f.id}/script/storyboard/plan`, payload: { scene_ids, signature: context.json().signature, model_id: 'mock', skill_ids: [] } })
  assert.equal(response.statusCode, 499, response.body); assert.equal(calls, 1)
})

test('canvas preparation resumes the failed design group without regenerating its completed sibling', async t => {
  const { registerScriptCanvasRoutes } = await import('../src/modules/canvas/script-canvas-preparation.js')
  const f = await project(2), isolated = routes(); t.after(() => isolated.close())
  const designIds = ['a', 'b'].map(value => `${f.id}-${value}`)
  for (let index = 0; index < 2; index++) run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?)',
    designIds[index], f.id, index === 0 ? 'GROUP_ONE' : 'GROUP_TWO', JSON.stringify([f.scenes[index].id]), '', 'now')
  const calls: string[] = []; let fail = true
  registerScriptCanvasRoutes(isolated, { script, scenePrompt: value => value.heading, generateText: async (_id, _model, prompt, contract) => {
    assert.equal(contract?.name, 'visual_profiles')
    const key = prompt.includes('GROUP_ONE') ? 'one' : 'two'; calls.push(key)
    if (key === 'two' && fail) throw transient()
    return withFixtureVisualCoverage(JSON.stringify({ profiles: [] }), prompt)
  } })
  const scene_ids = f.scenes.map(value => value.id)
  const checked = await isolated.inject({ method: 'POST', url: `/api/projects/${f.id}/script/canvas/check`, payload: { scene_ids } })
  assert.equal(checked.statusCode, 200, checked.body)
  const invoke = () => isolated.inject({ method: 'POST', url: `/api/projects/${f.id}/script/canvas/prepare`, payload: { scene_ids, signature: checked.json().signature, model_id: 'mock', skill_ids: [] } })
  assert.equal((await invoke()).statusCode, 422)
  fail = false
  const response = await invoke(); assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(calls, ['one', 'two', 'two'])
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', f.id).length, 0)
})
