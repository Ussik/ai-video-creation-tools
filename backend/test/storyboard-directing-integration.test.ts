import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import type { ScriptScene, ScriptArtifact } from '../src/infrastructure/database/db.js'
import { withStoryboardDirecting, storyboardOutlineFixture, storyboardBatchFixture, storyboardExactRepairFixture } from './helpers/storyboard-directing.js'

const directory = await mkdtemp(join(tmpdir(), 'storyboard-directing-integration-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, run } = await import('../src/infrastructure/database/db.js')
const { registerStoryboardPlanningRoutes } = await import('../src/modules/storyboard/storyboard-planning.js')
const { configureSkill, installSkillBundle, setSkillDefault, removeInstalledSkill } = await import('../src/modules/skills/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function create(url: string, payload: object) {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
function install(name: string, stage: 'storyboard' | 'video_prompt') {
  const skill = installSkillBundle({ repo: 'fixture/directing-integration', path: name, name, description: name,
    license: null, revision: 'a'.repeat(40), suggested_stages: [stage], tool_requirements: [], url: '',
    files: [{ path: `${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: ${name}\n---\n${stage === 'storyboard' ? 'SCENE_CRAFT_RULE' : 'MOTION_CRAFT_RULE'}` }] })
  configureSkill(skill.id, true, [stage])
  return skill.id
}
type Handler = (name: string, prompt: string, contract: OutputContract | undefined, signal?: AbortSignal) => unknown | Promise<unknown>
const isPlanRequest = (name: string) => name === 'storyboard_scene_plan' || name === 'storyboard_targeted_repair' || name.endsWith('_structure_repair')
async function fixture(t: { after(fn: () => unknown): unknown }, handler?: Handler, rawBatches = false) {
  const project = await create('/api/projects', { name: '门口对峙', brief: '阿宁听见催促后走到门口。' })
  const scene = await create(`/api/projects/${project.id}/script/scenes`, { heading: '内 · 走廊 · 夜', duration: 10,
    action: '阿宁从通道走到门口，随后停住。', dialogue: '阿宁：快走。', episode_number: 1 }) as ScriptScene
  const storyboard = install(`scene-${project.id}`, 'storyboard'), motion = install(`motion-${project.id}`, 'video_prompt')
  setSkillDefault('storyboard', { primary_id: storyboard, auxiliary_ids: [] }, project.id)
  setSkillDefault('video_prompt', { primary_id: motion, auxiliary_ids: [] }, project.id)
  const audio = { version: 1, speech: [], sound_effects: [], music: '', silent: true }
  const raw = withStoryboardDirecting({ scenes: [{ scene_id: scene.id, scene_duration: 10, shots: [
    { shot_id: null, title: '走向门口', prompt: '阿宁走向门口', image_prompt: '阿宁在走廊中段，右前方是门',
      video_prompt: '阿宁朝画面右方走到门前，摄影机向右横移跟随，到门前停住。', duration: 5, audio_plan: audio,
      start_state: '阿宁在走廊中段，面向门口', end_state: '阿宁在门前停住，右手垂落', cut_note: '切在脚步停下后，接阿宁门前的反应' },
    { shot_id: null, title: '门前反应', prompt: '阿宁在门前停住，听见门后响动', image_prompt: '阿宁站在门前，侧面中近景',
      video_prompt: '固定机位，阿宁停在门前，目光转向门缝。', duration: 5, audio_plan: audio,
      start_state: '阿宁已停在门前，右手垂落', end_state: '阿宁目光落向门缝，仍站在门前', cut_note: '目光落到门缝后停留收束' },
  ] }] })
  const routes = Fastify(), calls: Array<{ name: string; prompt: string }> = []
  let batchPlan: any, lastBatchContract: OutputContract | undefined
  let activeRequest: import('fastify').FastifyRequest | undefined
  routes.addHook('onRequest', (request, _reply, done) => { activeRequest = request; done() })
  t.after(async () => { await routes.close(); removeInstalledSkill(storyboard); removeInstalledSkill(motion) })
  registerStoryboardPlanningRoutes(routes, {
    script: () => ({ outline: '', characters: '阿宁', scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position,id', project.id),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position,id', project.id) }),
    scenePrompt: value => value.action,
    generateText: async (_projectId, modelId, prompt, contract, signal) => {
      assert.equal(modelId, 'mock-text')
      const name = contract?.name || ''; calls.push({ name, prompt })
      if (name === 'storyboard_outline_review') return JSON.stringify({ issues: [] })
      if (!rawBatches && name.endsWith('_structure_repair')) {
        const repaired = handler ? await handler(name, prompt, contract, signal) : raw
        const value = name.startsWith('storyboard_scene_plan') ? storyboardOutlineFixture(repaired) : storyboardBatchFixture(repaired, lastBatchContract!)
        const targetsLine = prompt.split('\n').find(line => line.startsWith('目标由程序指定：'))
        assert.ok(targetsLine)
        const targets = JSON.parse(targetsLine.slice('目标由程序指定：'.length))
        const allowed = (contract!.schema as any).properties.repairs.properties
        return JSON.stringify({ repairs: Object.fromEntries(targets.map((target: { key: string; path: Array<string | number> }) => {
          assert.ok(Object.hasOwn(allowed, target.key))
          return [target.key, target.path.reduce((current: any, key) => current[key], value)]
        })) })
      }
      if (!rawBatches && name === 'storyboard_targeted_repair') {
        const repaired = handler ? await handler(name, prompt, contract, signal) : raw
        return JSON.stringify(storyboardExactRepairFixture(repaired, prompt))
      }
      if (!rawBatches && name === 'storyboard_scene_plan') {
        batchPlan = handler ? await handler(name, prompt, contract, signal) : raw
        return JSON.stringify(storyboardOutlineFixture(batchPlan))
      }
      if (!rawBatches && name === 'storyboard_shot_batch') {
        lastBatchContract = contract
        return JSON.stringify(storyboardBatchFixture(batchPlan, contract!))
      }
      return JSON.stringify(handler ? await handler(name, prompt, contract, signal) : { issues: [] })
    },
  })
  const context = await routes.inject({ method: 'POST', url: `/api/projects/${project.id}/script/storyboard/context`, payload: { scene_ids: [scene.id] } })
  assert.equal(context.statusCode, 200, context.body)
  return { project, scene, raw, storyboard, motion, calls, routes, activeRequest: () => activeRequest,
    plan: (extra: object = {}) => routes.inject({ method: 'POST', url: `/api/projects/${project.id}/script/storyboard/plan`,
      payload: { scene_ids: [scene.id], signature: context.json().signature, model_id: 'mock-text', ...extra } }),
  }
}
function issue(sceneId: string, severity: 'error' | 'warning' = 'error') {
  return { code: 'action_mismatch', scene_id: sceneId, shot_index: 1, related_scene_id: sceneId, related_shot_index: 0,
    severity, message: '后一镜不能再次走到门口', evidence: '阿宁在门前停住', repair: '后一镜从已经停住的状态开始，只保留反应',
    evidence_refs: [{ scene_id: sceneId, shot_index: 0, field: 'end_state', quote: '阿宁在门前停住，右手垂落' },
      { scene_id: sceneId, shot_index: 1, field: 'start_state', quote: '阿宁已停在门前，右手垂落' }],
    repair_scope: [{ scene_id: sceneId, shot_index: 0, operation: 'replace', fields: ['end_state'] },
      { scene_id: sceneId, shot_index: 1, operation: 'replace', fields: ['start_state'] }] }
}
function assertNoWrites(projectId: string) {
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', projectId).length, 0)
  assert.equal(all('SELECT id FROM storyboard_designs WHERE project_id=?', projectId).length, 0)
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', projectId).length, 0)
}

test('script planning uses scene and motion rules, reviews the compiled complete sequence, and saves only after confirmation', async t => {
  const f = await fixture(t)
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json(), first = result.scenes[0].shots[0]
  assert.deepEqual(f.calls.map(call => call.name), ['storyboard_scene_plan', 'storyboard_outline_review', 'storyboard_shot_batch', 'storyboard_shot_batch', 'storyboard_directing_review'])
  const outline = f.calls[0]!.prompt, expansion = f.calls[2]!.prompt, review = f.calls[4]!.prompt
  assert.match(outline, /SCENE_CRAFT_RULE/); assert.doesNotMatch(outline, /MOTION_CRAFT_RULE/)
  assert.match(outline, /scene_direction/)
  assert.match(expansion, /SCENE_CRAFT_RULE/); assert.match(expansion, /MOTION_CRAFT_RULE/)
  assert.match(expansion, /不在同一时段要求固定又移动/)
  assert.match(review, /production_scenes/); assert.match(review, /阿宁在门前停住/)
  assert.match(review, /快走/); assert.match(review, /"pairs"/)
  assert.match(first.video_prompt, /路径、方向与速度/)
  assert.match(first.prompt, /场景站位/)
  assert.match(first.cut_note, /切点/)
  assert.equal(first.directing, undefined)
  assert.equal(result.scenes[0].scene_direction, undefined)
  assert.deepEqual(result.used_skills.map((skill: { id: string }) => skill.id), [f.storyboard])
  assert.deepEqual(result.motion_skills.map((skill: { id: string }) => skill.id), [f.motion])
  assert.equal(result.directing_review.status, 'passed')
  assert.equal(result.directing_review.repaired, false)
  assert.deepEqual(result.directing_review.issues, [])
  assert.ok(result.directing_review.review_id)
  assert.match(result.directing_review.content_signature, /^[a-f0-9]{64}$/)
  assert.equal(first.continuity_plan.version, 1)
  assertNoWrites(f.project.id)
  const save = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/commit`, payload: {
    signature: result.signature, review_id: result.directing_review.review_id, request_id: crypto.randomUUID(), save_only: true,
    scenes: result.scenes.map(({ scene_heading: _heading, ...scene }: Record<string, unknown>) => scene),
  } })
  assert.equal(save.statusCode, 200, save.body)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 2)
  const saved = all<any>('SELECT continuity_plan FROM shots WHERE project_id=? ORDER BY position', f.project.id)
  assert.deepEqual(saved[0].continuity_plan, first.continuity_plan)
})

test('manual draft review checks the edited full first-frame text without rewriting or saving it', async t => {
  const f = await fixture(t, (name, prompt) => isPlanRequest(name) ? f.raw : {
    issues: prompt.includes('金芒已经爆发，短尺已经出鞘半寸') ? [{ ...issue(f.scene.id), code: 'first_frame_conflict', shot_index: 0,
      related_scene_id: null, related_shot_index: null, message: '首帧提前呈现终态', evidence: '金芒已经爆发，短尺已经出鞘半寸', repair: '首帧保留暗处和未出鞘的起点',
      evidence_refs: [{ scene_id: f.scene.id, shot_index: 0, field: 'image_prompt', quote: '金芒已经爆发，短尺已经出鞘半寸' }],
      repair_scope: [{ scene_id: f.scene.id, shot_index: 0, operation: 'replace', fields: ['image_prompt'] }] }] : [],
  })
  const planned = (await f.plan()).json()
  const scenes = planned.scenes.map(({ scene_id, scene_duration, shots }: any) => ({ scene_id, scene_duration, shots }))
  scenes[0].shots[0].image_prompt = '金芒已经爆发，短尺已经出鞘半寸'
  scenes[0].shots[0].start_state = '暗处尚未睁眼，短尺仍在鞘中'
  const edited = structuredClone(scenes)
  const response = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`, payload: {
    signature: planned.signature, model_id: 'mock-text', scenes,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().status, 'needs_work')
  assert.equal(response.json().issues[0].code, 'first_frame_conflict')
  assert.match(response.json().content_signature, /^[a-f0-9]{64}$/)
  assert.deepEqual(scenes, edited)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_scene_plan').length, 1)
  assert.match(f.calls.at(-1)!.prompt, /完整image_prompt正文/)
  assertNoWrites(f.project.id)
})

test('an explicitly selected video model supplies its own budget and invalidates a preview when its configuration changes', async t => {
  const f = await fixture(t), providerId = crypto.randomUUID(), videoId = crypto.randomUUID()
  const dialect = installSkillBundle({ repo: 'fixture/target-dialect', path: 'short-drama-video-prompts', name: 'short-drama-video-prompts',
    description: '目标视频方言', license: null, revision: 'd'.repeat(40), suggested_stages: ['video_prompt'], tool_requirements: [], url: '', files: [
      { path: 'short-drama-video-prompts/SKILL.md', content: '---\nname: short-drama-video-prompts\ndescription: motion\n---\nMOTION_RULE' },
      { path: 'short-drama-video-prompts/references/seedance-2.0.md', content: 'TARGET_SEEDANCE_DIALECT_SENTINEL' },
    ] })
  configureSkill(dialect.id, true, ['video_prompt']); setSkillDefault('video_prompt', { primary_id: dialect.id, auxiliary_ids: [] }, f.project.id)
  t.after(() => removeInstalledSkill(dialect.id))
  run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES (?,?,'http','https://example.invalid',?)", providerId, '目标视频模型', new Date().toISOString())
  const settings = { video_reference_profile: 'seedance_2_0', supported_modes: ['reference'], max_reference_images: 6,
    request_templates: { reference: { image_references: '{{image_references}}' } },
    image_reference_template: { image: '{{image}}', role: '{{role}}' }, reference_roles: { reference: ['reference_image'] } }
  run("INSERT INTO models (id,provider_id,name,remote_id,modality,settings) VALUES (?,?,?,?,'video',?)", videoId, providerId, 'Seedance 2.0', 'seedance-2.0', JSON.stringify(settings))
  const currentContext = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/context`, payload: { scene_ids: [f.scene.id] } })
  const response = await f.plan({ target_video_model_id: videoId, signature: currentContext.json().signature })
  assert.equal(response.statusCode, 200, response.body)
  const planned = response.json()
  assert.equal(planned.target_video_model_id, videoId)
  assert.match(f.calls[0]!.prompt, /最多 6 张参考图片/)
  assert.match(f.calls[0]!.prompt, /Seedance 2.0/)
  assert.doesNotMatch(f.calls[0]!.prompt, /TARGET_SEEDANCE_DIALECT_SENTINEL/)
  assert.match(f.calls[2]!.prompt, /TARGET_SEEDANCE_DIALECT_SENTINEL/)
  run('UPDATE models SET settings=? WHERE id=?', JSON.stringify({ ...settings, max_reference_images: 5 }), videoId)
  const save = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/commit`, payload: {
    signature: planned.signature, review_id: planned.directing_review.review_id, request_id: crypto.randomUUID(), target_video_model_id: videoId, save_only: true,
    scenes: planned.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene),
  } })
  assert.equal(save.statusCode, 409, save.body)
  assertNoWrites(f.project.id)
  const invalid = await f.plan({ target_video_model_id: 'missing-video' })
  assert.equal(invalid.statusCode, 422, invalid.body)
})

test('automatic semantic repair uses targeted patches and a fresh independent review', async t => {
  let generated = 0, reviewed = 0
  const f = await fixture(t, (name, prompt) => {
    if (isPlanRequest(name)) {
      generated++
      if (generated === 2) { assert.match(prompt, /只修复有证据的镜头/); assert.match(prompt, /后一镜不能再次走到门口/) }
      return f.raw
    }
    reviewed++
    return { issues: reviewed === 1 ? [issue(f.scene.id)] : [] }
  })
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(f.calls.map(call => call.name), ['storyboard_scene_plan', 'storyboard_outline_review', 'storyboard_shot_batch', 'storyboard_shot_batch', 'storyboard_directing_review', 'storyboard_targeted_repair', 'storyboard_directing_review'])
  assert.equal(response.json().directing_review.repaired, true)
  assertNoWrites(f.project.id)
})

test('a persistent directing error returns specific repair guidance without saving a draft as success', async t => {
  const f = await fixture(t, name => isPlanRequest(name) ? f.raw : { issues: [issue(f.scene.id)] })
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().directing_review.status, 'needs_work')
  assert.match(response.body, /只保留反应/)
  assert.equal(f.calls.length, 7)
  assertNoWrites(f.project.id)
})

test('review cannot cite shots outside this draft even after its format correction', async t => {
  const f = await fixture(t, name => isPlanRequest(name) ? f.raw : { issues: [issue('unselected-scene')] })
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().directing_review.status, 'inconclusive')
  assert.match(response.body, /范围之外/)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_scene_plan').length, 1)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_directing_review').length, 2)
  assertNoWrites(f.project.id)
})

test('source-backed speech and selected scope are revalidated during semantic repair', async t => {
  let generated = 0
  const f = await fixture(t, name => {
    if (!isPlanRequest(name)) return { issues: [issue(f.scene.id)] }
    if (++generated === 1) return f.raw
    const bad = structuredClone(f.raw)
    bad.scenes[0]!.shots[0]!.audio_plan = { version: 1, speech: [{ speaker: '阿宁', text: '不存在的台词', delivery: '平静', mode: 'dialogue', source_text: '伪造的来源' }], sound_effects: [], music: '', silent: false } as never
    return bad
  })
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().directing_review.status, 'needs_work')
  assert.equal(generated, 2, 'field-only repair never accepts a supplied replacement speech plan')
  assert.equal(response.json().scenes[0].shots[0].audio_plan.silent, true)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_directing_review').length, 2)
  assertNoWrites(f.project.id)
})

test('video skill changes during review invalidate the preview before it can be returned', async t => {
  const f = await fixture(t, name => {
    if (isPlanRequest(name)) return f.raw
    run('UPDATE installed_skills SET revision=? WHERE id=?', 'b'.repeat(40), f.motion)
    return { issues: [] }
  })
  const response = await f.plan()
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /技能配置已更新/)
  assertNoWrites(f.project.id)
})

test('explicit base mode omits both external rule sets while retaining the professional application contract', async t => {
  const f = await fixture(t)
  const response = await f.plan({ skill_ids: [] })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().used_skills, [])
  assert.deepEqual(response.json().motion_skills, [])
  assert.doesNotMatch(f.calls[0]!.prompt, /SCENE_CRAFT_RULE|MOTION_CRAFT_RULE/)
  assert.match(f.calls[0]!.prompt, /场面调度、摄影与剪辑设计/)
  assertNoWrites(f.project.id)
})

test('a nonblocking pacing warning is visible and does not cause an unsolicited rewrite', async t => {
  const f = await fixture(t, name => isPlanRequest(name) ? f.raw : { issues: [issue(f.scene.id, 'warning')] })
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().directing_review.status, 'warnings')
  assert.equal(response.json().directing_review.issues.length, 1)
  assert.equal(response.json().directing_review.repaired, false)
  assert.equal(f.calls.length, 5)
  assertNoWrites(f.project.id)
})

test('canceling a model request propagates the signal and stops before the review or repair', async t => {
  const f = await fixture(t, (name, _prompt, _contract, signal) => {
    assert.equal(name, 'storyboard_scene_plan')
    assert.ok(signal)
    f.activeRequest()!.raw.emit('aborted')
    assert.equal(signal.aborted, true)
    return f.raw
  })
  const response = await f.plan({ skill_ids: [] })
  assert.equal(response.statusCode, 499, response.body)
  assert.match(response.body, /分镜规划已取消/)
  assert.equal(f.calls.length, 1)
  assertNoWrites(f.project.id)
})

test('metadata compilation limits participate in the existing one format correction', async t => {
  let firstShotExpansions = 0, plan: any
  const f = await fixture(t, (name, prompt, contract) => {
    if (name === 'storyboard_scene_plan') return storyboardOutlineFixture(plan)
    if (name !== 'storyboard_shot_batch') {
      assert.equal(name, 'storyboard_directing_review')
      return { issues: [] }
    }
    const batch = structuredClone(storyboardBatchFixture(plan, contract!))
    if (batch.shots[0]!.shot_index === 0) {
      firstShotExpansions++
      if (firstShotExpansions === 1) batch.shots[0]!.expansion.directing.purpose = '职责'.repeat(200)
      else { assert.match(prompt, /一次格式修正/); assert.match(prompt, /超过 10000 字符/) }
    }
    return batch
  }, true)
  plan = structuredClone(f.raw)
  plan.scenes[0].shots[0].prompt = '原'.repeat(9600)
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(firstShotExpansions, 2)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_scene_plan').length, 1)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_shot_batch').length, 3)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_directing_review').length, 1)
  assert.ok(response.json().scenes[0].shots[0].prompt.startsWith('原'.repeat(9600)), 'format correction preserves the locked outline narrative')
  assertNoWrites(f.project.id)
})

test('the reviewer receives latest formal source precedence when old scene action disagrees', async t => {
  const f = await fixture(t, (name, prompt) => {
    if (isPlanRequest(name)) return f.raw
    assert.match(prompt, /最新正式正文优先于滞后的场次摘要和旧镜头/)
    assert.match(prompt, /"source_policy"/)
    assert.match(prompt, /"artifact_type":"episode_script"/)
    assert.match(prompt, /"episode_number":1/)
    assert.match(prompt, /"version"/)
    assert.match(prompt, /正式版本：阿宁一直停在门边，没有再次走向门口/)
    assert.match(prompt, /阿宁从通道走到门口，随后停住/)
    return { issues: [] }
  })
  const update = await app.inject({ method: 'PUT', url: `/api/projects/${f.project.id}/script/artifacts`, payload: { artifacts: [{
    artifact_type: 'episode_script', episode_number: 1, title: '第一集正式正文',
    content: '内 · 走廊 · 夜\n正式版本：阿宁一直停在门边，没有再次走向门口。', status: 'ready',
  }] } })
  assert.equal(update.statusCode, 200, update.body)
  const context = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/context`, payload: { scene_ids: [f.scene.id] } })
  const response = await f.plan({ signature: context.json().signature })
  assert.equal(response.statusCode, 200, response.body)
  assertNoWrites(f.project.id)
})

async function currentPlanningContext(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/context`,
    payload: { scene_ids: [f.scene.id] } })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
function timedPlan(f: Awaited<ReturnType<typeof fixture>>, seconds: number) {
  const value = structuredClone(f.raw), scene = value.scenes[0]!
  scene.scene_duration = seconds
  scene.shots[0]!.duration = Math.floor(seconds / 2)
  scene.shots[1]!.duration = seconds - scene.shots[0]!.duration
  return value
}
function editableScenes(result: any) {
  return result.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene)
}

test('reestimating a historical two-second scene previews a longer plan and saves it only on confirmation', async t => {
  const speech = '这一路我想了很久。门后的声音不对，我们得先确认里面是谁，再决定要不要开门。你留在这里，等我给你信号。'
  const f = await fixture(t, (name, prompt) => {
    if (isPlanRequest(name)) {
      assert.match(prompt, /历史估计，不是本次硬性时长/)
      const value = timedPlan(f, 40)
      value.scenes[0]!.shots[0]!.audio_plan = { version: 1, speech: [{ speaker: '阿宁', text: speech,
        delivery: '谨慎，保留句间停顿', mode: 'dialogue', source_text: `阿宁：${speech}` }],
      sound_effects: [], music: '', silent: false } as never
      return value
    }
    assert.match(prompt, /"timing_policy"/)
    assert.match(prompt, /按完整对白、旁白、动作|当前草稿已按剧情重新估时/)
    return { issues: [] }
  })
  run('UPDATE script_scenes SET duration=?,dialogue=? WHERE id=?', 2, `阿宁：${speech}`, f.scene.id)
  const source = await currentPlanningContext(f)
  const response = await f.plan({ signature: source.signature, duration_mode: 'reestimate' })
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json(), scenes = editableScenes(result)
  assert.equal(result.duration_mode, 'reestimate')
  assert.notEqual(result.signature, source.signature)
  assert.equal(result.scenes[0].scene_duration, 40)
  assert.equal(result.scenes[0].shots[0].audio_plan.speech[0].text, speech)
  assert.ok(result.scenes[0].shots.every((shot: any) => shot.duration <= 30))
  assert.equal(all<ScriptScene>('SELECT * FROM script_scenes WHERE id=?', f.scene.id)[0]!.duration, 2)
  assertNoWrites(f.project.id)

  const reviewPayload = { signature: result.signature, model_id: 'mock-text', scenes }
  const wrongReview = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`, payload: reviewPayload })
  assert.equal(wrongReview.statusCode, 409, wrongReview.body)
  const review = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`,
    payload: { ...reviewPayload, duration_mode: 'reestimate' } })
  assert.equal(review.statusCode, 200, review.body)
  const payload = { signature: result.signature, review_id: result.directing_review.review_id, request_id: crypto.randomUUID(), save_only: true, scenes }
  const wrongSave = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/commit`, payload })
  assert.equal(wrongSave.statusCode, 409, wrongSave.body)
  assertNoWrites(f.project.id)
  const save = () => f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/commit`,
    payload: { ...payload, duration_mode: 'reestimate' } })
  const saved = await save()
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().created_shots, 2)
  assert.equal(all<ScriptScene>('SELECT * FROM script_scenes WHERE id=?', f.scene.id)[0]!.duration, 40)
  const after = await currentPlanningContext(f)
  assert.equal(after.scenes[0].planned, true)
  assert.equal(after.scenes[0].needs_replan, false, 'the confirmed duration must be part of the saved freshness fingerprint')
  const replay = await save()
  assert.equal(replay.statusCode, 200, replay.body)
  assert.equal(replay.json().replayed, true)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 2)
})

test('preserving the source estimate rejects silent retiming while a legitimate short scene remains allowed', async t => {
  let seconds = 40
  const f = await fixture(t, name => isPlanRequest(name) ? timedPlan(f, seconds) : { issues: [] })
  const changed = await f.plan()
  assert.equal(changed.statusCode, 422, changed.body)
  assert.match(changed.body, /保留源场次时长/)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_scene_plan').length, 2)
  assertNoWrites(f.project.id)
  run('UPDATE script_scenes SET duration=?,action=?,dialogue=? WHERE id=?', 2, '阿宁抬眼。', '', f.scene.id)
  seconds = 2
  const source = await currentPlanningContext(f)
  const short = await f.plan({ signature: source.signature })
  assert.equal(short.statusCode, 200, short.body)
  assert.equal(short.json().scenes[0].scene_duration, 2)
  assert.equal(short.json().duration_mode, undefined)
  assert.equal(short.json().signature, source.signature, 'legacy preserve signatures remain compatible')
})

test('semantic repair may revise estimated scene duration and must review the revised timing', async t => {
  let generated = 0, reviewed = 0
  const f = await fixture(t, (name, prompt) => {
    if (isPlanRequest(name)) {
      generated++
      if (generated === 2) assert.match(prompt, /只有issues明确timing_change:true/)
      const plan = timedPlan(f, generated === 1 ? 40 : 50)
      if (generated > 1) { plan.scenes[0].shots[0].duration = 20; plan.scenes[0].shots[1].duration = 30 }
      return plan
    }
    reviewed++
    assert.match(prompt, new RegExp(`"scene_duration":${reviewed === 1 ? 40 : 50}`))
    const defect = { ...issue(f.scene.id), code: 'unfilmable_motion', timing_change: true,
      message: '本镜对白与动作无法在当前时长内完成', repair: '保留完整内容并增加表演和停顿时间' }
    defect.evidence_refs.push({ scene_id: f.scene.id, shot_index: 1, field: 'duration', quote: '20' })
    defect.repair_scope[1]!.fields.push('duration')
    return { issues: reviewed === 1 ? [defect] : [] }
  })
  const response = await f.plan({ duration_mode: 'reestimate' })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().scenes[0].scene_duration, 50)
  assert.equal(response.json().directing_review.repaired, true)
  assert.equal(reviewed, 2)
  assertNoWrites(f.project.id)
})

test('an explicit total stays exact during semantic repair and conflicts with reestimation before any model call', async t => {
  let generated = 0, reviewed = 0
  const f = await fixture(t, name => {
    if (isPlanRequest(name)) return timedPlan(f, ++generated === 1 ? 40 : 60)
    return { issues: ++reviewed === 1 ? [issue(f.scene.id)] : [] }
  })
  const conflict = await f.plan({ duration_mode: 'reestimate', target_duration: 40 })
  assert.notEqual(conflict.statusCode, 200)
  assert.match(conflict.body, /不能同时使用/)
  assert.equal(f.calls.length, 0)
  const response = await f.plan({ target_duration: 40 })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().directing_review.status, 'passed')
  assert.equal(response.json().scenes[0].scene_duration, 40)
  assert.deepEqual(response.json().scenes[0].shots.map((shot: any) => shot.duration), [20, 20])
  assert.equal(generated, 2, 'unrequested replacement timing cannot enter fixed field patches')
  assert.equal(reviewed, 2)
  assertNoWrites(f.project.id)
})

test('a changed source invalidates a reestimated preview before confirmation', async t => {
  const f = await fixture(t, name => isPlanRequest(name) ? timedPlan(f, 40) : { issues: [] })
  const response = await f.plan({ duration_mode: 'reestimate' })
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json()
  run('UPDATE script_scenes SET duration=? WHERE id=?', 11, f.scene.id)
  const saved = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/commit`, payload: {
    signature: result.signature, review_id: result.directing_review.review_id, request_id: crypto.randomUUID(), save_only: true,
    duration_mode: 'reestimate', scenes: editableScenes(result),
  } })
  assert.equal(saved.statusCode, 409, saved.body)
  assertNoWrites(f.project.id)
})

async function taskState(routes: ReturnType<typeof Fastify>, projectId: string, taskId: string, done = (value: any) => value.status !== 'running') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await routes.inject({ method: 'GET', url: `/api/projects/${projectId}/script/storyboard/tasks/${taskId}` })
    assert.equal(response.statusCode, 200, response.body)
    const value = response.json()
    if (done(value)) return value
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Task did not reach expected test phase')
}
async function taskInput(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/context`, payload: { scene_ids: [f.scene.id] } })
  assert.equal(response.json().planning_task_version, 1)
  return { scene_ids: [f.scene.id], signature: response.json().signature, model_id: 'mock-text', skill_ids: [] }
}

function longScenePlan(f: Awaited<ReturnType<typeof fixture>>, revision = '') {
  const value = structuredClone(f.raw), scene = value.scenes[0]!
  scene.scene_duration = 90
  scene.shots = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(f.raw.scenes[0]!.shots[index % 2]!),
    title: `${revision}动作节拍${index + 1}`, duration: 18,
    audio_plan: index === 0 ? { version: 1, speech: [{ speaker: '阿宁', text: '快走。', source_text: '阿宁：快走。',
      delivery: '', mode: 'dialogue' }], sound_effects: [], music: '', silent: false } as never : structuredClone(f.raw.scenes[0]!.shots[1]!.audio_plan),
  }))
  return value
}

test('a 90-second initial draft retains completed shots and resumes only the interrupted batch before full review', async t => {
  let interrupted = true, fullPlan: any
  const offsets: number[] = []
  const f = await fixture(t, (name, prompt, contract) => {
    if (name === 'storyboard_scene_plan') {
      assert.match(prompt, /SCENE_CRAFT_RULE/); assert.doesNotMatch(prompt, /MOTION_CRAFT_RULE/)
      return storyboardOutlineFixture(fullPlan)
    }
    if (name === 'storyboard_shot_batch') {
      assert.match(prompt, /MOTION_CRAFT_RULE/)
      const batch = storyboardBatchFixture(fullPlan, contract!), offset = batch.shots[0]!.shot_index
      offsets.push(offset)
      if (offset === 2 && interrupted) throw Object.assign(new Error('upstream stream disconnected: connection reset by peer'), {
        statusCode: 502, code: 'stream_read_error', retryable: true, raw_output: '{"scene_id":',
      })
      return batch
    }
    assert.equal(name, 'storyboard_directing_review')
    assert.match(prompt, /"scene_duration":90/)
    return { issues: [] }
  }, true)
  fullPlan = longScenePlan(f)
  run('UPDATE script_scenes SET duration=? WHERE id=?', 90, f.scene.id)
  const input = { ...await taskInput(f), skill_ids: [f.storyboard] }
  const start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`,
    payload: { ...input, request_id: crypto.randomUUID() } })
  assert.equal(start.statusCode, 200, start.body)
  const taskId = start.json().id, failed = await taskState(f.routes, f.project.id, taskId)
  assert.equal(failed.status, 'failed'); assert.equal(failed.stage, 'generating')
  assert.equal(failed.error.code, 'stream_read_error', failed.error.message)
  assert.equal(failed.candidate, undefined, 'partial shots never unlock a preview or save')
  assert.deepEqual(failed.progress, { phase: 'shots', completed_shots: 2, total_shots: 5 })
  assert.equal(failed.can_resume, true)
  assert.deepEqual(offsets, [0, 1, 2])
  assertNoWrites(f.project.id)
  interrupted = false
  const resumed = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks/${taskId}/resume`, payload: {} })
  assert.equal(resumed.statusCode, 200, resumed.body)
  const completed = await taskState(f.routes, f.project.id, taskId)
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.progress, undefined)
  assert.deepEqual(offsets, [0, 1, 2, 2, 3, 4])
  assert.equal(f.calls.filter(call => call.name === 'storyboard_scene_plan').length, 1)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_directing_review').length, 1)
  assert.equal(completed.result.scenes[0].shots.reduce((sum: number, shot: any) => sum + shot.duration, 0), 90)
  assert.deepEqual(completed.result.scenes[0].shots.flatMap((shot: any) => shot.audio_plan.speech.map((speech: any) => speech.text)), ['快走。'])
  assertNoWrites(f.project.id)
})

test('reestimating a two-second historical scene into 90 seconds uses recoverable batches', async t => {
  const f = await fixture(t, name => isPlanRequest(name) ? longScenePlan(f) : { issues: [] })
  run('UPDATE script_scenes SET duration=? WHERE id=?', 2, f.scene.id)
  const source = await currentPlanningContext(f)
  const response = await f.plan({ signature: source.signature, duration_mode: 'reestimate' })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(f.calls.map(call => call.name), ['storyboard_scene_plan', 'storyboard_outline_review', 'storyboard_shot_batch', 'storyboard_shot_batch', 'storyboard_shot_batch', 'storyboard_shot_batch', 'storyboard_shot_batch', 'storyboard_directing_review'])
  assert.equal(response.json().scenes[0].scene_duration, 90)
  assert.equal(all<ScriptScene>('SELECT * FROM script_scenes WHERE id=?', f.scene.id)[0]!.duration, 2)
  assertNoWrites(f.project.id)
})

test('a long-scene local repair keeps unrelated completed shots and never repeats outline batches', async t => {
  let outlines = 0, reviews = 0, initial: any
  const f = await fixture(t, (name, prompt, contract) => {
    if (name === 'storyboard_scene_plan') { outlines++; return storyboardOutlineFixture(initial) }
    if (name === 'storyboard_shot_batch') return storyboardBatchFixture(initial, contract!)
    if (name === 'storyboard_targeted_repair') {
      const revised = structuredClone(initial)
      revised.scenes[0].shots[0].end_state = '阿宁在门前保持站定，右手垂落'
      revised.scenes[0].shots[1].start_state = '阿宁已站定在门前，右手垂落'
      return storyboardExactRepairFixture(revised, prompt)
    }
    return { issues: ++reviews === 1 ? [issue(f.scene.id)] : [] }
  }, true)
  initial = longScenePlan(f)
  run('UPDATE script_scenes SET duration=? WHERE id=?', 90, f.scene.id)
  const start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`,
    payload: { ...await taskInput(f), request_id: crypto.randomUUID() } })
  const completed = await taskState(f.routes, f.project.id, start.json().id)
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.result.directing_review.repaired, true)
  assert.equal(outlines, 1); assert.equal(reviews, 2)
  const shots = completed.result.scenes[0].shots
  assert.equal(shots[0].end_state, '阿宁在门前保持站定，右手垂落'); assert.equal(shots[1].start_state, '阿宁已站定在门前，右手垂落')
  assert.deepEqual(shots.map((shot: any) => shot.title), initial.scenes[0].shots.map((shot: any) => shot.title))
  assert.deepEqual(shots.slice(2).map((shot: any) => shot.title), initial.scenes[0].shots.slice(2).map((shot: any) => shot.title))
  assertNoWrites(f.project.id)
})

test('background tasks expose a validated read-only candidate, deduplicate starts and share active work with the synchronous endpoint', async t => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(t, async name => {
    if (isPlanRequest(name)) return f.raw
    await held; return { issues: [] }
  })
  const input = await taskInput(f), request_id = crypto.randomUUID()
  const start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id } })
  assert.equal(start.statusCode, 200, start.body)
  const id = start.json().id
  const candidate = await taskState(f.routes, f.project.id, id, value => value.stage === 'reviewing')
  assert.equal(candidate.candidate.directing_review.status, 'pending_review')
  assert.equal(candidate.result, undefined)
  assert.equal(candidate.candidate.scenes[0].shots.length, 2)
  const repeat = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id } })
  assert.equal(repeat.json().id, id)
  const attach = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id: crypto.randomUUID() } })
  assert.equal(attach.json().id, id)
  const conflict = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, instructions: '不同的设计要求', request_id: crypto.randomUUID() } })
  assert.equal(conflict.statusCode, 409)
  const synchronous = f.plan({ skill_ids: [] }).then(response => response)
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = all<{ payload: string }>('SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', f.project.id, `storyboard-planning-task:${id}`)[0]!
    if (JSON.parse(row.payload).request_ids.length === 3) break
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(f.calls.length, 5, 'another entry point joins the existing generation and review')
  release()
  assert.equal((await synchronous).statusCode, 200)
  const finished = await taskState(f.routes, f.project.id, id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.result.directing_review.status, 'passed')
  assert.equal(finished.candidate, undefined)
  const stored = JSON.parse(all<{ payload: string }>('SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', f.project.id, `storyboard-planning-task:${id}`)[0]!.payload)
  assert.deepEqual(Object.keys(stored.steps), ['storyboard_task_budget:v1'], 'completed tasks compact duplicate rules and candidate text while retaining durable usage')
  assert.equal(stored.steps['storyboard_task_budget:v1'].version, 1)
  assert.deepEqual(stored.steps['storyboard_task_budget:v1'].usage.pending_requests, [])
  assert.ok(finished.timings.generating >= 0); assert.ok(finished.timings.reviewing >= 0)
  const lostResponseRetry = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id, fresh: true } })
  assert.equal(lostResponseRetry.json().id, id)
  assert.equal(f.calls.length, 5, 'retrying a lost start response never regenerates completed work')
  assertNoWrites(f.project.id)
})

test('a failed director review retains an inconclusive result and explicit review never regenerates', async t => {
  let reviews = 0
  const f = await fixture(t, name => {
    if (isPlanRequest(name)) return f.raw
    if (++reviews === 1) throw new Error('review transport failed')
    return { issues: [] }
  })
  const input = await taskInput(f)
  const start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id: crypto.randomUUID() } })
  const id = start.json().id, finished = await taskState(f.routes, f.project.id, id)
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.result.directing_review.status, 'inconclusive')
  assert.equal(finished.can_resume, false)
  const lookup = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks/lookup`, payload: input })
  assert.equal(lookup.json().task.id, id)
  assert.equal(f.calls.length, 5)
  const review = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`, payload: {
    signature: finished.result.signature, model_id: 'mock-text', scenes: finished.result.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene),
  } })
  assert.equal(review.statusCode, 200, review.body); assert.equal(review.json().status, 'passed')
  assert.deepEqual(f.calls.map(call => call.name), ['storyboard_scene_plan', 'storyboard_outline_review', 'storyboard_shot_batch', 'storyboard_shot_batch', 'storyboard_directing_review', 'storyboard_directing_review'])
  assertNoWrites(f.project.id)
})

test('a failed second review retains the revised draft and re-review never regenerates or repairs', async t => {
  let reviews = 0
  const f = await fixture(t, name => {
    if (isPlanRequest(name)) return f.raw
    reviews++
    if (reviews === 1) return { issues: [issue(f.scene.id)] }
    if (reviews === 2) throw new Error('second review disconnected')
    return { issues: [] }
  })
  const start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...await taskInput(f), request_id: crypto.randomUUID() } })
  const finished = await taskState(f.routes, f.project.id, start.json().id)
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.result.directing_review.status, 'inconclusive')
  assert.equal(finished.result.directing_review.repaired, true); assert.equal(finished.result.directing_review.issues.length, 1)
  const review = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`, payload: {
    signature: finished.result.signature, model_id: 'mock-text', scenes: finished.result.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene),
  } })
  assert.equal(review.statusCode, 200, review.body); assert.equal(review.json().status, 'passed')
  assert.equal(f.calls.filter(call => call.name === 'storyboard_scene_plan').length, 1)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_targeted_repair').length, 1)
  assert.equal(f.calls.filter(call => call.name === 'storyboard_directing_review').length, 3)
  assertNoWrites(f.project.id)
})

test('explicit cancellation retains the candidate and stale source inputs cannot resume or reuse a request id', async t => {
  const f = await fixture(t, async (name, _prompt, _contract, signal) => {
    if (isPlanRequest(name)) return f.raw
    await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    return { issues: [] }
  })
  const input = await taskInput(f), request_id = crypto.randomUUID()
  const start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id } })
  const id = start.json().id
  await taskState(f.routes, f.project.id, id, value => value.stage === 'reviewing')
  const cancelled = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks/${id}/cancel`, payload: {} })
  assert.equal(cancelled.json().status, 'cancelled')
  assert.equal(cancelled.json().candidate.directing_review.status, 'pending_review')
  assert.equal(cancelled.json().can_resume, true)
  run('UPDATE script_scenes SET action=? WHERE id=?', '阿宁留在走廊原地，不走向门口。', f.scene.id)
  const resume = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks/${id}/resume`, payload: {} })
  assert.equal(resume.statusCode, 409)
  const repeat = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id } })
  assert.equal(repeat.statusCode, 409)
  assert.equal(f.calls.length, 5)
  assertNoWrites(f.project.id)
})

test('a failed planning task cannot reuse checkpoints after the selected model configuration changes', async t => {
  let reviews = 0
  const f = await fixture(t, name => {
    if (isPlanRequest(name)) return f.raw
    if (++reviews === 1) throw new Error('review failed before settings changed')
    return { issues: [] }
  })
  const provider = await create('/api/providers', { name: '任务模型配置', base_url: 'https://unused.invalid/v1', api_key: 'task-test' })
  const model = await create('/api/models', { provider_id: provider.id, name: '分镜任务模型', modality: 'text', protocol: 'responses', remote_id: 'test-model',
    settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } })
  const input = await taskInput(f), start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id: crypto.randomUUID() } })
  const id = start.json().id
  await taskState(f.routes, f.project.id, id)
  // Fixture initially has no DB model for mock-text. Giving that same ID a
  // real configuration changes identity without changing script source.
  run('UPDATE models SET id=? WHERE id=?', 'mock-text', model.id)
  t.after(() => run('DELETE FROM models WHERE id=?', 'mock-text'))
  const read = await f.routes.inject({ method: 'GET', url: `/api/projects/${f.project.id}/script/storyboard/tasks/${id}` })
  assert.equal(read.statusCode, 409, read.body)
  const resume = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks/${id}/resume`, payload: {} })
  assert.equal(resume.statusCode, 409, resume.body)
  assert.equal(f.calls.length, 5)
})

test('completed task GET rejects changed settings under the same selected model id', async t => {
  const f = await fixture(t), input = await taskInput(f)
  const start = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/tasks`, payload: { ...input, request_id: crypto.randomUUID() } })
  const id = start.json().id
  assert.equal((await taskState(f.routes, f.project.id, id)).status, 'succeeded')
  const provider = await create('/api/providers', { name: '已完成任务模型配置', base_url: 'https://unused.invalid/v1', api_key: 'task-test' })
  const model = await create('/api/models', { provider_id: provider.id, name: '已完成分镜任务模型', modality: 'text', protocol: 'responses', remote_id: 'test-model',
    settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } })
  run('UPDATE models SET id=? WHERE id=?', 'mock-text', model.id)
  t.after(() => run('DELETE FROM models WHERE id=?', 'mock-text'))
  const stale = await f.routes.inject({ method: 'GET', url: `/api/projects/${f.project.id}/script/storyboard/tasks/${id}` })
  assert.equal(stale.statusCode, 409, stale.body)
  assert.equal(f.calls.length, 5)
})


test('commit requires a server review of the current body and preserves accepted request replay', async t => {
  const f = await fixture(t), response = await f.plan(), plan = response.json()
  const scenes = plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene)
  const request = { signature: plan.signature, request_id: crypto.randomUUID(), save_only: true, scenes }
  const commit = (payload: object) => f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/commit`, payload })
  for (const review_id of [undefined, 'forged-review']) {
    const rejected = await commit({ ...request, review_id })
    assert.equal(rejected.statusCode, 409, rejected.body); assertNoWrites(f.project.id)
  }
  const edited = structuredClone(scenes); edited[0].shots[0].title += '手工修改'
  const rejected = await commit({ ...request, scenes: edited, review_id: plan.directing_review.review_id })
  assert.equal(rejected.statusCode, 409, rejected.body); assertNoWrites(f.project.id)
  const saved = await commit({ ...request, review_id: plan.directing_review.review_id })
  assert.equal(saved.statusCode, 200, saved.body)
  const replay = await commit(request)
  assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().replayed, true)
  assert.equal(f.calls.length, 5, 'commit and replay never request another model')
})

test('manual repair permits authorized retiming and carries the same latest formal sources into repair and re-review', async t => {
  let generated = 0, reviewed = 0
  const f = await fixture(t, (name, prompt) => {
    if (isPlanRequest(name)) {
      generated++
      const value = timedPlan(f, generated < 3 ? 40 : 50)
      if (generated === 3) {
        assert.match(prompt, /"source_scenes"/); assert.match(prompt, /"source_documents"/)
        assert.match(prompt, /LATEST_FORMAL_EPISODE/); assert.match(prompt, /"source_policy"/); assert.match(prompt, /"creative_authority"/)
        value.scenes[0]!.shots[0]!.duration = 20; value.scenes[0]!.shots[1]!.duration = 30
        const previous = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).readonly_plan.scenes[0]
        value.scenes[0]!.shots.forEach((shot: any, index: number) => { shot.audio_plan = previous.shots[index].audio_plan })
      }
      return value
    }
    reviewed++
    if (reviewed === 3) {
      assert.match(prompt, /"scene_duration":50/); assert.match(prompt, /LATEST_FORMAL_EPISODE/)
      assert.match(prompt, /"source_policy"/); assert.match(prompt, /"creative_authority"/)
    }
    const defect = { ...issue(f.scene.id), code: reviewed === 2 ? 'weak_cut' : 'action_mismatch', timing_change: true }
    defect.evidence_refs.push({ scene_id: f.scene.id, shot_index: 1, field: 'duration', quote: '20' })
    defect.repair_scope[1]!.fields.push('duration')
    return { issues: reviewed < 3 ? [defect] : [] }
  })
  const update = await app.inject({ method: 'PUT', url: `/api/projects/${f.project.id}/script/artifacts`, payload: { artifacts: [{
    artifact_type: 'episode_script', episode_number: 1, title: '本集最新正式正文', content: 'LATEST_FORMAL_EPISODE：阿宁停在门前，听门内声音。', status: 'ready',
  }] } })
  assert.equal(update.statusCode, 200, update.body)
  const response = await f.plan({ signature: (await currentPlanningContext(f)).signature, duration_mode: 'reestimate' })
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json()
  assert.equal(result.directing_review.status, 'needs_work')
  const scenes = result.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene)
  const repaired = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/repair`, payload: {
    signature: result.signature, duration_mode: 'reestimate', model_id: 'mock-text', review_id: result.directing_review.review_id, scenes,
  } })
  assert.equal(repaired.statusCode, 200, repaired.body)
  assert.equal(repaired.json().directing_review.status, 'passed', repaired.body)
  assert.equal(repaired.json().scenes[0].scene_duration, 50)
  assert.equal(repaired.json().scenes[0].shots[0].duration, 20)
  assert.equal(generated, 3); assert.equal(reviewed, 3)
  assertNoWrites(f.project.id)
})

test('manual repair requires a current needs-work review and cannot reuse an inconclusive report', async t => {
  for (const inconclusive of [false, true]) {
    const f = await fixture(t, name => {
      if (isPlanRequest(name)) return f.raw
      if (inconclusive) throw new Error('review disconnected')
      return { issues: [] }
    })
    const plan = (await f.plan()).json(), before = f.calls.length
    const repaired = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/repair`, payload: {
      signature: plan.signature, model_id: 'mock-text', review_id: plan.directing_review.review_id,
      scenes: plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene),
    } })
    assert.equal(repaired.statusCode, 409, repaired.body); assert.equal(f.calls.length, before)
    assertNoWrites(f.project.id)
  }
})

test('same problem stops stale repair receipts and unchanged re-reviews, while edits start a new candidate lineage', async t => {
  let editedStart: string | undefined
  const f = await fixture(t, name => {
    if (isPlanRequest(name)) return f.raw
    const defect = issue(f.scene.id)
    if (editedStart) defect.evidence_refs[1]!.quote = editedStart
    return { issues: [defect] }
  })
  const response = await f.plan(); assert.equal(response.statusCode, 200, response.body)
  const result = response.json(), scenes = result.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene)
  assert.equal(result.directing_review.status, 'needs_work'); assert.equal(result.directing_review.error.code, 'storyboard_repeated_issues')
  const before = f.calls.length
  const payload = { signature: result.signature, model_id: 'mock-text', scenes }
  const stopped = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/repair`, payload: { ...payload, review_id: result.directing_review.review_id } })
  assert.equal(stopped.statusCode, 409); assert.equal(f.calls.length, before)
  const reviewed = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`, payload })
  assert.equal(reviewed.statusCode, 200, reviewed.body); assert.equal(reviewed.json().error.code, 'storyboard_repeated_issues')
  const second = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/repair`, payload: { ...payload, review_id: reviewed.json().review_id } })
  assert.equal(second.statusCode, 409); assert.equal(f.calls.length, before + 1)
  editedStart = '阿宁维持门前站定，只转头听门内动静'; scenes[0].shots[1].start_state = editedStart
  const fresh = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`, payload: { ...payload, scenes } })
  assert.equal(fresh.statusCode, 200, fresh.body); assert.equal(fresh.json().status, 'needs_work'); assert.equal(fresh.json().error, undefined)
  assertNoWrites(f.project.id)
})

test('manual scene-direction repair recompiles every dependent shot while preserving their authored facts and audio', async t => {
  let needsRepair = false, repaired = false
  const blocking = '阿宁保持门前站定；门在人物前方，摄影机留在走廊同侧。'
  const f = await fixture(t, name => {
    if (name === 'storyboard_targeted_repair') {
      repaired = true
      const value = structuredClone(f.raw); value.scenes[0].scene_direction.blocking = blocking; return value
    }
    if (isPlanRequest(name)) return f.raw
    const defect = issue(f.scene.id)
    defect.evidence_refs = [{ scene_id: f.scene.id, shot_index: null as any, field: 'scene_direction.blocking', quote: f.raw.scenes[0].scene_direction.blocking }]
    defect.repair_scope = [{ scene_id: f.scene.id, shot_index: null as any, operation: 'replace', fields: ['scene_direction.blocking'] }]
    return { issues: needsRepair && !repaired ? [defect] : [] }
  })
  const response = await f.plan(); assert.equal(response.statusCode, 200, response.body)
  const result = response.json(), scenes = result.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene)
  needsRepair = true
  const payload = { signature: result.signature, model_id: 'mock-text', scenes }
  const reviewed = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/review`, payload })
  assert.equal(reviewed.statusCode, 200, reviewed.body); assert.equal(reviewed.json().status, 'needs_work')
  const fixed = await f.routes.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/repair`, payload: { ...payload, review_id: reviewed.json().review_id } })
  assert.equal(fixed.statusCode, 200, fixed.body); assert.equal(fixed.json().directing_review.status, 'passed')
  for (const [index, shot] of fixed.json().scenes[0].shots.entries()) {
    assert.ok(shot.prompt.includes(blocking)); assert.ok(shot.image_prompt.includes(blocking))
    assert.equal(shot.continuity_plan.scene.blocking, blocking)
    assert.equal(shot.title, scenes[0].shots[index].title); assert.equal(shot.duration, scenes[0].shots[index].duration)
    assert.deepEqual(shot.audio_plan, scenes[0].shots[index].audio_plan)
    assert.ok(shot.prompt.startsWith(f.raw.scenes[0].shots[index]!.prompt))
  }
  assertNoWrites(f.project.id)
})
