import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import type { Shot } from '../src/infrastructure/database/db.js'
import type { CreationSkillSelector } from '../src/modules/skills/model-skill-selection.js'
import { withClipDirecting } from './helpers/storyboard-directing.js'

const testData = await mkdtemp(join(tmpdir(), 'clip-storyboard-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const { registerClipStoryboardRoutes } = await import('../src/modules/storyboard/clip-storyboard.js')
const { registerAiOperations } = await import('../src/modules/generation/ai-operations.js')
const { recordCreatorRequirement } = await import('../src/modules/script/script-creator-requirements.js')
const { installSkillBundle, configureSkill, removeInstalledSkill, setSkillDefault, resetSkillTaskDefault } = await import('../src/modules/skills/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, status, response.body)
  return response.json()
}
const shot = (duration = 4, title = '抬头') => ({ title, duration, prompt: '旅人抬头看灯。', image_prompt: '旅人站在雨巷左侧，近景，侧面机位。',
  video_prompt: '旅人缓慢抬头，镜头向前推进。', audio_plan: { version: 1 as const, speech: [], sound_effects: [], music: '', silent: true },
  start_state: '低头', end_state: '抬头望灯', cut_note: '承接视线方向' })
const source = { source_text: '旅人走进雨巷，停下脚步，抬头看灯。', total_duration: 12, instructions: '强调灯光变化' }
const draft = () => ({ shots: [shot(), shot(4, '停步'), shot(4, '望灯')] })
function resources(projectId: string) {
  return Object.fromEntries(['script_scenes', 'script_artifacts', 'shots', 'storyboard_designs', 'storyboard_clip_plans', 'project_canvases', 'canvas_nodes', 'visual_profiles', 'jobs']
    .map(table => [table, all(`SELECT * FROM ${table} WHERE project_id=? ORDER BY rowid`, projectId)]))
}
async function fixture(t: TestContext, options: {
  generate?: (prompt: string, call: number, signal?: AbortSignal) => Promise<string>
  review?: (prompt: string, call: number, signal?: AbortSignal) => unknown | Promise<unknown>
  repair?: (data: any, prompt: string, call: number, signal?: AbortSignal) => unknown | Promise<unknown>
  modelId?: string; operations?: boolean; select?: CreationSkillSelector
} = {}) {
  const project = await api('POST', '/api/projects', { name: '无剧本片段测试', brief: '雨夜的一个动作' })
  const routes = Fastify(), prompts: string[] = [], reviewPrompts: string[] = [], repairPrompts: string[] = [], selections: unknown[] = []
  const modelId = options.modelId || 'mock-text'
  let activeRequest: import('fastify').FastifyRequest | undefined
  routes.addHook('onRequest', (request, _reply, done) => { activeRequest = request; done() })
  routes.setErrorHandler((issue, _request, reply) => reply.code(issue instanceof ZodError ? 422 : (issue as Error & { statusCode?: number }).statusCode || 500)
    .send({ detail: issue.message }))
  if (options.operations) registerAiOperations(routes)
  registerClipStoryboardRoutes(routes, {
    generateText: async (projectId, requestedModelId, prompt, contract, signal) => {
      assert.equal(projectId, project.id); assert.equal(requestedModelId, modelId)
      if (contract?.name === 'storyboard_directing_review') { reviewPrompts.push(prompt); return JSON.stringify(await options.review?.(prompt, reviewPrompts.length, signal) || { issues: [] }) }
      if (contract?.name === 'storyboard_targeted_repair') {
        repairPrompts.push(prompt)
        const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
        const result = options.repair ? await options.repair(data, prompt, repairPrompts.length, signal) : {
          patches: data.targets.map((target: any) => ({ ...target, shot: data.readonly_plan.scenes.find((scene: any) => scene.scene_id === target.scene_id).shots[target.shot_index] })),
        }
        return JSON.stringify(result)
      }
      assert.equal(contract?.name, 'clip_storyboard')
      prompts.push(prompt)
      const response = options.generate ? await options.generate(prompt, prompts.length, signal) : JSON.stringify(draft())
      try { const value = JSON.parse(response); return value.shots && !value.groups ? JSON.stringify(withClipDirecting(value)) : response } catch { return response }
    },
    selectSkills: async (...args) => { selections.push(args[2]); return options.select ? options.select(...args) : { skill_ids: [], reason: '本次仅需基础规则' } },
  })
  t.after(() => routes.close())
  const invoke = async (action: string, payload?: object, status = 200, projectId = project.id) => {
    const response = await routes.inject({ method: action === 'context' ? 'GET' : 'POST', url: `/api/projects/${projectId}/storyboard/clip/${action}`,
      ...(payload === undefined ? {} : { payload }) })
    assert.equal(response.statusCode, status, response.body); return response.json()
  }
  const context = () => invoke('context')
  const plan = async (extra: object = {}) => invoke('plan', { signature: (await context()).signature, ...source, model_id: modelId, skill_ids: [], ...extra })
  const commitPayload = (result: any) => ({ request_id: randomUUID(), signature: result.signature, source_text: result.source_text,
    total_duration: result.total_duration, instructions: result.instructions, shots: result.shots, review_id: result.directing_review.review_id, ...(result.target_video_model_id ? { target_video_model_id: result.target_video_model_id } : {}) })
  const save = async () => { const planned = await plan(), payload = commitPayload(planned); return { planned, payload, saved: await invoke('commit', payload) } }
  return { project, invoke, context, plan, save, commitPayload, prompts, reviewPrompts, repairPrompts, selections, modelId, activeRequest: () => activeRequest }
}
function installSkill(t: TestContext, name: string, sentinel: string) {
  const bundle = { repo: 'qa/clip-storyboard', path: name, name, description: '片段分镜技能', license: 'MIT', revision: 'a'.repeat(40),
    tool_requirements: [], suggested_stages: ['storyboard' as const], url: '', files: [{ path: `${name}/SKILL.md`,
      content: `---\nname: ${name}\ndescription: 片段分镜技能\n---\n${sentinel}` }] }
  const installed = installSkillBundle(bundle); configureSkill(installed.id, true, ['storyboard'])
  t.after(() => { removeInstalledSkill(installed.id); resetSkillTaskDefault('storyboard') })
  return { id: installed.id, bundle }
}

test('clip context is registered on the app and reads metadata without scenes or model work', async t => {
  const f = await fixture(t), before = resources(f.project.id)
  const context = await api('GET', `/api/projects/${f.project.id}/storyboard/clip/context`)
  assert.equal(context.skill_policy.stage, 'storyboard'); assert.equal(context.project.name, f.project.name)
  assert.match(context.signature, /^[a-f0-9]{64}$/)
  assert.deepEqual(resources(f.project.id), before); assert.equal(f.prompts.length, 0); assert.equal(f.selections.length, 0)
})

test('clip planning recovers source punctuation in generated speech without relaxing manual saves', async t => {
  const original = '等等，别走！', generated = '等等,别走!', source_text = `旅人说：${original}`
  const f = await fixture(t, { generate: async () => JSON.stringify({ shots: [{ ...shot(12), audio_plan: {
    version: 1, speech: [{ speaker: '旅人', text: generated, source_text, delivery: '', mode: 'dialogue' }],
    sound_effects: [], music: '', silent: false,
  } }] }) })
  const before = resources(f.project.id), planned = await f.plan({ source_text })
  assert.equal(planned.shots[0].audio_plan.speech[0].text, original)
  assert.equal(f.prompts.length, 1)
  assert.ok(f.reviewPrompts[0]!.includes(original))
  assert.deepEqual(resources(f.project.id), before)
  const edited = f.commitPayload(planned)
  edited.shots = structuredClone(edited.shots)
  edited.shots[0].audio_plan.speech[0].text = generated
  const rejected = await f.invoke('commit', edited, 422)
  assert.match(rejected.detail, /必须逐字包含/)
  assert.deepEqual(resources(f.project.id), before)
})

test('independent clips inherit explicit project constraints and art defaults without importing formal plot', async t => {
  const f = await fixture(t)
  run('UPDATE projects SET brief=? WHERE id=?', 'FORMAL_PROJECT_BRIEF_PLOT_AND_ENDING', f.project.id)
  run('INSERT INTO scripts (project_id, outline, characters, generation_options, updated_at) VALUES (?,?,?,?,?)',
    f.project.id, 'FORMAL_PLOT_OUTLINE', 'FORMAL_CHARACTERS', JSON.stringify({ genre: 'PROJECT_GENRE', audience: 'PROJECT_AUDIENCE',
      story_structure: 'FORMAL_STRUCTURE', core_hook: 'FORMAL_CORE_HOOK', character_notes: 'FORMAL_CHARACTER_NOTES', episode_count: 8, episode_duration: 60 }), now())
  const record = (quote: string, scope: string, extra = {}) => recordCreatorRequirement(f.project.id, { quote, scope, source: { text: quote }, ...extra })
  const old = record('SUPERSEDED_PROJECT_RULE', 'project')
  record('ACTIVE_PROJECT_RULE', 'project', { supersedes: [old.id] })
  record('CLIP_ONLY_RULE', 'clip')
  record('PROJECT_MUSIC_OPEN_QUESTION', '项目级', { kind: 'open_question' })
  record('UNSCOPED_LOCAL_REQUIREMENT', '')
  record('LEGACY_LOCAL_REQUIREMENT', '这一场')
  record('OTHER_EPISODE_RULE', 'episode:1')
  run(`INSERT INTO script_story_decisions (id,project_id,topic,content,basis,source_text,created_at,updated_at)
    VALUES (?,?,?,?,'creator_confirmed',?,?,?)`, randomUUID(), f.project.id, '结局', 'FORMAL_PLOT_DECISION', 'FORMAL_DECISION_SOURCE', now(), now())
  const planned = await f.plan({ instructions: '当前片段保留静默长镜头' }), payload = f.commitPayload(planned)
  const { request_id: _request, review_id: _review, ...review } = payload
  await f.invoke('review', { ...review, model_id: 'mock-text' })
  for (const prompt of [...f.prompts, ...f.reviewPrompts]) {
    for (const marker of ['ACTIVE_PROJECT_RULE', 'CLIP_ONLY_RULE', 'PROJECT_MUSIC_OPEN_QUESTION', 'PROJECT_GENRE', 'PROJECT_AUDIENCE', '当前片段保留静默长镜头']) assert.ok(prompt.includes(marker), marker)
    assert.doesNotMatch(prompt, /SUPERSEDED_PROJECT_RULE|UNSCOPED_LOCAL_REQUIREMENT|LEGACY_LOCAL_REQUIREMENT|OTHER_EPISODE_RULE|FORMAL_/)
    assert.match(prompt, /创作者本次明确指令优先/)
    assert.match(prompt, /kind=open_question是尚未确定的问题/)
  }
  const signature = (await f.context()).signature
  run('UPDATE projects SET brief=? WHERE id=?', 'FORMAL_PROJECT_BRIEF_CHANGED', f.project.id)
  assert.equal((await f.context()).signature, signature, 'a formal-series brief is not an independent clip input')
  await f.invoke('review', { ...review, model_id: 'mock-text' })
  assert.doesNotMatch(f.reviewPrompts.at(-1)!, /FORMAL_/)
  record('ANOTHER_UNSCOPED_LOCAL_RULE', '')
  run('UPDATE script_story_decisions SET content=? WHERE project_id=?', 'FORMAL_PLOT_CHANGED', f.project.id)
  assert.equal((await f.context()).signature, signature, 'formal plot and unknown scopes do not invalidate independent clips')
  record('NEW_PROJECT_RESTRAINT', 'project')
  assert.notEqual((await f.context()).signature, signature)
  await f.invoke('commit', payload, 409)
  await f.invoke('review', { ...review, model_id: 'mock-text' }, 409)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('a project requirement changed during clip generation rejects the late preview', async t => {
  const f = await fixture(t, { generate: async () => {
    recordCreatorRequirement(f.project.id, { quote: '保留人物沉默', scope: 'project', source: { text: '保留人物沉默' } })
    return JSON.stringify(draft())
  } })
  await f.invoke('plan', { signature: (await f.context()).signature, ...source, model_id: 'mock-text', skill_ids: [] }, 409)
  assert.equal(f.reviewPrompts.length, 0)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('clips with explicit art direction keep that style and exclude story decisions from generation and review', async t => {
  const f = await fixture(t)
  run('INSERT INTO scripts (project_id, generation_options, updated_at) VALUES (?,?,?)', f.project.id,
    JSON.stringify({ visual_style: '水彩动画', visual_style_details: { palette: '蓝灰' } }), now())
  run(`INSERT INTO script_story_decisions (id,project_id,topic,content,basis,source_text,created_at,updated_at)
    VALUES (?,?,?,?,'creator_confirmed',?,?,?)`, randomUUID(), f.project.id, '身份', 'PRIVATE_SERIES_IDENTITY', 'PRIVATE_SERIES_SOURCE', now(), now())
  const before = (await f.context()).signature
  await f.plan()
  assert.match(f.prompts[0]!, /水彩动画|蓝灰/)
  for (const prompt of [...f.prompts, ...f.reviewPrompts]) {
    assert.ok(prompt.includes('水彩动画'))
    assert.ok(prompt.includes('蓝灰'))
    assert.doesNotMatch(prompt, /PRIVATE_SERIES_/)
  }
  run('UPDATE script_story_decisions SET content=? WHERE project_id=?', 'CHANGED_PRIVATE_IDENTITY', f.project.id)
  assert.equal((await f.context()).signature, before)
})

test('clip planning reviews adjacent shots, repairs once, and preserves the accepted group and sound design', async t => {
  const f = await fixture(t, { review: (prompt, call) => {
    assert.match(prompt, /完整image_prompt正文/)
    assert.match(prompt, /"pairs"/)
    return { issues: call === 1 ? [{ code: 'first_frame_conflict', scene_id: 'clip-main', shot_index: 0,
      related_scene_id: null, related_shot_index: null, severity: 'error', message: '首帧提前呈现抬头结果',
      evidence: '旅人缓慢抬头', repair: '开镜保持低头状态' }] : [] }
  } })
  const planned = await f.plan()
  assert.equal(f.prompts.length, 1)
  assert.equal(f.repairPrompts.length, 1)
  assert.equal(f.reviewPrompts.length, 2)
  assert.match(f.repairPrompts[0]!, /只修复有证据的镜头/)
  assert.equal(planned.directing_review.repaired, true)
  assert.equal(planned.shots[0].continuity_plan.group_id, 'clip-main')
  assert.equal(planned.shots[0].continuity_plan.scene.sound.music_policy, 'timeline')
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
  const saved = await f.invoke('commit', f.commitPayload(planned))
  assert.deepEqual(saved.shots[0].continuity_plan, planned.shots[0].continuity_plan)
})

test('explicit clip draft review preserves manual text and returns a new content snapshot without saving', async t => {
  const f = await fixture(t), planned = await f.plan(), payload = f.commitPayload(planned)
  payload.shots[0].image_prompt = '手工更改的开镜画面，不自动重写'
  const { request_id: _id, review_id: _review, ...review } = payload
  const report = await f.invoke('review', { ...review, model_id: 'mock-text' })
  assert.equal(report.status, 'passed')
  assert.notEqual(report.content_signature, planned.directing_review.content_signature)
  assert.match(f.reviewPrompts.at(-1)!, /手工更改的开镜画面/)
  assert.equal(f.prompts.length, 1)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('fixed storyboard binding loads its SKILL body without a model selection request', async t => {
  const selected = installSkill(t, 'clip-fixed-sentinel', 'CLIP_FIXED_BODY_SENTINEL')
  const f = await fixture(t, { select: async () => { throw new Error('Known storyboard tasks must use their fixed binding') } })
  setSkillDefault('storyboard', { primary_id: selected.id, auxiliary_ids: [] }, f.project.id)
  const context = await f.context()
  const result = await f.invoke('plan', { signature: context.signature, ...source, model_id: 'mock-text' })
  assert.equal(f.selections.length, 0); assert.equal(f.prompts.length, 1)
  assert.match(f.prompts[0]!, /CLIP_FIXED_BODY_SENTINEL/)
  assert.match(f.prompts[0]!, /本次结构化返回契约/)
  assert.deepEqual(result.used_skills.map((skill: any) => skill.id), [selected.id])
  assert.deepEqual(result.used_skills[0].files, ['clip-fixed-sentinel/SKILL.md'])
  assert.equal(result.skill_assignment.source, 'fixed'); assert.equal(result.skill_assignment.task, 'storyboard')
  assert.match(result.skill_assignment.reason, /项目绑定/)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('the application planning route sends real skill body and a clip contract through its text provider', async t => {
  const selected = installSkill(t, 'clip-provider-sentinel', 'CLIP_PROVIDER_BODY_SENTINEL')
  const project = await api('POST', '/api/projects', { name: '真实路由假上游' })
  const provider = await api('POST', '/api/providers', { name: '片段隔离上游', base_url: 'https://clip-test.invalid/v1', api_key: 'clip-test-only' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '片段测试文本模型', remote_id: 'mock-clip-text', modality: 'text', protocol: 'responses',
    settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}', stream: false },
      text_path: 'output_text', structured_output_mode: 'json_schema' } })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls++; assert.equal(String(url), 'https://clip-test.invalid/v1/responses')
    const request = JSON.parse(String(init.body))
    if (request.text.format.name === 'storyboard_directing_review') return Response.json({ output_text: JSON.stringify({ issues: [] }) })
    assert.equal(request.text.format.name, 'clip_storyboard'); assert.equal(request.text.format.strict, true)
    assert.match(request.input, /CLIP_PROVIDER_BODY_SENTINEL/)
    assert.match(request.input, /旅人走进雨巷/)
    assert.equal(request.text.format.schema.properties.shots.maxItems, 30)
    return Response.json({ output_text: JSON.stringify(withClipDirecting(draft())) })
  })
  const context = await api('GET', `/api/projects/${project.id}/storyboard/clip/context`)
  const planned = await api('POST', `/api/projects/${project.id}/storyboard/clip/plan`, {
    signature: context.signature, ...source, model_id: model.id, skill_ids: [selected.id],
  })
  assert.equal(calls, 2); assert.equal(planned.used_skills[0].id, selected.id)
  assert.equal(all('SELECT id FROM script_scenes WHERE project_id=?', project.id).length, 0)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', project.id).length, 0)
})

test('manual primary and auxiliary rules are loaded while an explicit empty choice overrides defaults', async t => {
  const primary = installSkill(t, 'clip-manual-primary', 'CLIP_PRIMARY_BODY_SENTINEL')
  const auxiliary = installSkill(t, 'clip-manual-auxiliary', 'CLIP_AUX_BODY_SENTINEL')
  const f = await fixture(t); setSkillDefault('storyboard', { primary_id: primary.id, auxiliary_ids: [auxiliary.id] }, f.project.id)
  const manual = await f.plan({ skill_ids: [primary.id, auxiliary.id] })
  assert.equal(manual.skill_assignment.source, 'manual'); assert.equal(f.selections.length, 0)
  assert.match(f.prompts[0]!, /CLIP_PRIMARY_BODY_SENTINEL/); assert.match(f.prompts[0]!, /CLIP_AUX_BODY_SENTINEL/)
  assert.deepEqual(manual.used_skills.map((skill: any) => skill.role), ['primary', 'auxiliary'])
  const base = await f.plan({ skill_ids: [] })
  assert.deepEqual(base.used_skills, []); assert.equal(base.skill_assignment.source, 'manual'); assert.equal(f.selections.length, 0)
  assert.doesNotMatch(f.prompts[1]!, /CLIP_PRIMARY_BODY_SENTINEL|CLIP_AUX_BODY_SENTINEL/)
})

test('planning corrects an invalid duration once and never saves the failed preview', async t => {
  const f = await fixture(t, { generate: async (prompt, call) => {
    if (call === 2) assert.match(prompt, /一次格式修正[\s\S]*总时长 12 秒/)
    return JSON.stringify(call === 1 ? { shots: [shot(11)] } : draft())
  } })
  const before = resources(f.project.id), planned = await f.plan()
  assert.equal(planned.shots.reduce((sum: number, shot: any) => sum + shot.duration, 0), 12)
  assert.equal(f.prompts.length, 2); assert.deepEqual(resources(f.project.id), before)
})

test('new model drafts require an explicit audio plan rather than inferring silence from prose', async t => {
  const f = await fixture(t, { generate: async (prompt, call) => {
    const value: any = draft()
    if (call === 1) delete value.shots[0].audio_plan
    else assert.match(prompt, /一次格式修正[\s\S]*audio_plan/)
    return JSON.stringify(value)
  } })
  const before = resources(f.project.id), planned = await f.plan()
  assert.deepEqual(planned.shots[0].audio_plan, { ...shot().audio_plan, scene_sound: { ambience: [], acoustics: '', music_policy: 'timeline' } })
  assert.equal(f.prompts.length, 2)
  assert.deepEqual(resources(f.project.id), before)
})

test('clip dialogue keeps its exact source through commit and invented source text cannot be saved', async t => {
  const spoken = '别过去。', sourceText = `旅人留下一句话：${spoken}`
  const audio = { version: 1, speech: [{ speaker: '旅人', text: spoken, delivery: '低声', mode: 'voiceover', source_text: sourceText }],
    sound_effects: ['雨声'], music: '', silent: false }
  const f = await fixture(t, { generate: async () => JSON.stringify({ shots: [{ ...shot(12), audio_plan: audio }] }) })
  const planned = await f.plan({ source_text: sourceText }), payload = f.commitPayload(planned)
  const saved = await f.invoke('commit', payload)
  const expectedAudio = { ...audio, scene_sound: { ambience: [], acoustics: '', music_policy: 'timeline' } }
  assert.deepEqual(saved.shots[0].audio_plan, expectedAudio)
  assert.deepEqual(one<any>('SELECT audio_plan FROM shots WHERE id=?', saved.shots[0].id)!.audio_plan, expectedAudio)
  const before = resources(f.project.id), invented = structuredClone(payload)
  invented.request_id = randomUUID()
  invented.shots[0].audio_plan.speech[0].source_text = '模型补写的原文。'
  await f.invoke('commit', invented, 422)
  assert.deepEqual(resources(f.project.id), before)
})

test('the clip duration and shot-count contracts accept 1 and 120 seconds and reject invalid boundaries', async t => {
  let output = { shots: [shot(1)] }
  const f = await fixture(t, { generate: async () => JSON.stringify(output) })
  assert.equal((await f.plan({ total_duration: 1, shots_count: 1 })).shots.length, 1)
  output = { shots: Array.from({ length: 30 }, () => shot(4)) }
  const maximum = await f.plan({ total_duration: 120, shots_count: 30 })
  assert.equal(maximum.shots.length, 30)
  const context = await f.context(), base = { signature: context.signature, ...source, model_id: 'mock-text', skill_ids: [] }
  for (const extra of [{ total_duration: 0 }, { total_duration: 121 }, { total_duration: 1.5 }, { shots_count: 0 }, { shots_count: 31 }, { source_text: '' }]) {
    await f.invoke('plan', { ...base, ...extra }, 422)
  }
  for (const shots of [[], Array.from({ length: 31 }, () => shot(1)), [shot(31)], [shot(0)]]) {
    await f.invoke('commit', { ...f.commitPayload(maximum), shots }, 422)
  }
})

test('saving a clip creates only pending clip shots and preserves all existing script and scheme records', async t => {
  const f = await fixture(t)
  const scene = await api('POST', `/api/projects/${f.project.id}/script/scenes`, { heading: '既有剧本场次', duration: 12 })
  const oldShot = await api('POST', `/api/projects/${f.project.id}/shots`, { title: '原镜头', prompt: '旧故事', source_scene_id: scene.id })
  const before = resources(f.project.id), { saved } = await f.save(), afterSave = resources(f.project.id)
  assert.deepEqual(saved.scene_ids, []); assert.equal(saved.target_canvas_id, null); assert.equal(saved.created_shots, 3)
  assert.deepEqual(saved.visual_profiles, []); assert.deepEqual(saved.shot_visual_bindings, [])
  assert.ok(saved.shots.every((shot: Shot) => shot.source_scene_id === null && shot.design_id === saved.design_id && !shot.superseded_by))
  for (const table of ['script_scenes', 'script_artifacts', 'project_canvases', 'canvas_nodes', 'visual_profiles', 'jobs']) assert.deepEqual(afterSave[table], before[table], table)
  assert.deepEqual(one('SELECT * FROM shots WHERE id=?', oldShot.id), (before.shots as Shot[]).find(shot => shot.id === oldShot.id))
  const metadata = await api('GET', `/api/projects/${f.project.id}/shot-management`)
  assert.deepEqual(metadata.designs.find((design: any) => design.id === saved.design_id), {
    id: saved.design_id, name: '片段方案 1', canvas_id: null, canvas_pending: true, source_type: 'clip', source_text: source.source_text, total_duration: 12,
  })
  const second = await f.save()
  assert.ok(saved.shots.every((shot: Shot) => !one<Shot>('SELECT * FROM shots WHERE id=?', shot.id)!.superseded_by))
  assert.notEqual(second.saved.design_id, saved.design_id)
})

test('saving is strictly idempotent and a changed replay cannot overwrite its source or shots', async t => {
  const f = await fixture(t), { saved, payload } = await f.save(), before = resources(f.project.id)
  const replay = await f.invoke('commit', payload)
  assert.equal(replay.replayed, true); assert.equal(replay.created_shots, 0)
  assert.deepEqual(replay.shots.map((shot: Shot) => shot.id), saved.shots.map((shot: Shot) => shot.id))
  assert.deepEqual(resources(f.project.id), before)
  await f.invoke('commit', { ...payload, source_text: '改写过的内容' }, 409)
  await f.invoke('commit', { ...payload, shots: [shot(12, '替换镜头')] }, 409)
  const other = await api('POST', '/api/projects', { name: '其他项目' })
  await f.invoke('commit', payload, 409, other.id)
  assert.deepEqual(resources(f.project.id), before)
})

test('preview edits require a current review while a changed duration sum is rejected', async t => {
  const f = await fixture(t), planned = await f.plan(), payload = f.commitPayload(planned)
  const edited = { ...payload, shots: payload.shots.map((item: any, index: number) => ({ ...item,
    title: index === 0 ? '手动调整的镜头' : item.title, duration: index === 0 ? 3 : index === 1 ? 5 : 4 })) }
  await f.invoke('commit', { ...edited, shots: [shot(11)] }, 422)
  await f.invoke('commit', edited, 409)
  const { request_id: _id, review_id: _oldReview, ...review } = edited
  const reviewed = await f.invoke('review', { ...review, model_id: 'mock-text' })
  const saved = await f.invoke('commit', { ...edited, review_id: reviewed.review_id })
  assert.equal(saved.shots[0].title, '手动调整的镜头')
  assert.deepEqual(saved.shots.map((item: Shot) => item.duration), [3, 5, 4])
})

test('plan signatures bind source text, duration, instructions and project or skill configuration', async t => {
  const selected = installSkill(t, 'clip-version-sentinel', 'CLIP_VERSION_ONE')
  const f = await fixture(t), planned = await f.plan({ skill_ids: [selected.id] }), payload = f.commitPayload(planned)
  for (const extra of [{ source_text: '不同的原文' }, { instructions: '不同要求' }, { total_duration: 13, shots: [shot(13)] }]) {
    await f.invoke('commit', { ...payload, ...extra }, 409)
  }
  installSkillBundle({ ...selected.bundle, revision: 'b'.repeat(40), files: [{ path: 'clip-version-sentinel/SKILL.md', content: '---\nname: clip-version-sentinel\ndescription: 分镜\n---\nCLIP_VERSION_TWO' }] }, selected.id)
  await f.invoke('commit', payload, 409)
  await f.invoke('plan', { signature: planned.signature, ...source, model_id: 'mock-text', skill_ids: [] }, 409)
  const refreshed = await f.plan({ skill_ids: [selected.id] })
  run('UPDATE projects SET ratio=? WHERE id=?', '9:16', f.project.id)
  await f.invoke('commit', f.commitPayload(refreshed), 409)
  assert.equal(all('SELECT id FROM storyboard_designs WHERE project_id=?', f.project.id).length, 0)
})

test('configuration drift during generation rejects a late result without saving it', async t => {
  const f = await fixture(t, { generate: async () => {
    run('UPDATE projects SET ratio=? WHERE id=?', '9:16', f.project.id)
    return JSON.stringify(draft())
  } })
  const context = await f.context()
  await f.invoke('plan', { signature: context.signature, ...source, model_id: 'mock-text', skill_ids: [] }, 409)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('canvas handoff returns only selected clip shots and creates one reusable dedicated canvas', async t => {
  const f = await fixture(t), { saved } = await f.save(), ids = [saved.shots[1].id], before = resources(f.project.id)
  const first = await f.invoke('canvas', { design_id: saved.design_id, shot_ids: ids })
  assert.deepEqual(first.shots.map((shot: Shot) => shot.id), ids); assert.deepEqual(first.scene_ids, [])
  assert.notEqual(first.target_canvas_id, f.project.id)
  const second = await f.invoke('canvas', { design_id: saved.design_id, shot_ids: saved.shots.map((shot: Shot) => shot.id) })
  assert.equal(second.target_canvas_id, first.target_canvas_id); assert.equal(second.shots.length, 3)
  assert.equal(all('SELECT id FROM project_canvases WHERE project_id=?', f.project.id).length, (before.project_canvases as unknown[]).length + 1)
  for (const table of ['script_scenes', 'script_artifacts', 'canvas_nodes', 'visual_profiles', 'jobs']) assert.deepEqual(resources(f.project.id)[table], before[table], table)
  const metadata = await api('GET', `/api/projects/${f.project.id}/shot-management`)
  assert.equal(metadata.designs.find((design: any) => design.id === saved.design_id).canvas_pending, false)
})

test('invalid, recycled, cross-project and mixed-design selections cannot create a canvas', async t => {
  const f = await fixture(t), { saved } = await f.save(), second = (await f.save()).saved
  const other = await api('POST', '/api/projects', { name: '禁止串项目' })
  const before = resources(f.project.id)
  await f.invoke('canvas', { design_id: saved.design_id, shot_ids: [] }, 422)
  await f.invoke('canvas', { design_id: saved.design_id, shot_ids: [saved.shots[0].id, saved.shots[0].id] }, 422)
  await f.invoke('canvas', { design_id: saved.design_id, shot_ids: [saved.shots[0].id, second.shots[0].id] }, 409)
  await f.invoke('canvas', { design_id: saved.design_id, shot_ids: [saved.shots[0].id] }, 422, other.id)
  await f.invoke('canvas', { design_id: 'missing', shot_ids: [saved.shots[0].id] }, 422)
  run('UPDATE shots SET deleted_at=? WHERE id=?', now(), saved.shots[0].id)
  await f.invoke('canvas', { design_id: saved.design_id, shot_ids: [saved.shots[0].id] }, 409)
  assert.deepEqual(resources(f.project.id).project_canvases, before.project_canvases)
})

test('a deleted dedicated canvas is not recreated by a repeated handoff', async t => {
  const f = await fixture(t), { saved } = await f.save(), input = { design_id: saved.design_id, shot_ids: [saved.shots[0].id] }
  const handoff = await f.invoke('canvas', input)
  run('DELETE FROM project_canvases WHERE id=?', handoff.target_canvas_id)
  const before = resources(f.project.id)
  await f.invoke('canvas', input, 409)
  assert.deepEqual(resources(f.project.id), before)
})

const localIssue = { code: 'first_frame_conflict', scene_id: 'clip-main', shot_index: 0,
  related_scene_id: null, related_shot_index: null, severity: 'error', message: '首帧提前呈现抬头结果',
  evidence: '旅人缓慢抬头', repair: '开镜保持低头状态' }
function reviewPayload(payload: any, modelId = 'mock-text') {
  const { request_id: _request, review_id: _review, ...review } = payload
  return { ...review, model_id: modelId }
}

test('review outages retain a complete clip and review-only recovery never regenerates it', async t => {
  let unavailable = true
  const f = await fixture(t, { review: () => { if (unavailable) throw new Error('temporary review outage'); return { issues: [] } } })
  const before = resources(f.project.id), planned = await f.plan(), payload = f.commitPayload(planned)
  assert.equal(planned.shots.length, 3)
  assert.equal(planned.directing_review.status, 'inconclusive')
  assert.equal(planned.directing_review.error.retryable, true)
  assert.ok(planned.directing_review.review_id)
  assert.equal(f.prompts.length, 1); assert.equal(f.repairPrompts.length, 0)
  await f.invoke('commit', payload, 409)
  const retry = await f.invoke('review', reviewPayload(payload))
  assert.equal(retry.status, 'inconclusive'); assert.notEqual(retry.review_id, payload.review_id)
  assert.deepEqual(resources(f.project.id), before)
  unavailable = false
  const accepted = await f.invoke('review', reviewPayload(payload))
  assert.equal(accepted.status, 'passed')
  assert.equal(accepted.content_signature, planned.directing_review.content_signature)
  assert.equal(f.prompts.length, 1); assert.equal(f.repairPrompts.length, 0)
  assert.equal((await f.invoke('commit', { ...payload, review_id: accepted.review_id })).created_shots, 3)
})

test('targeted repair copies untouched shots and retains a needs-work candidate after the second review', async t => {
  let originalTargets: any
  const f = await fixture(t, {
    review: () => ({ issues: [localIssue] }),
    repair: data => {
      originalTargets = structuredClone(data.readonly_plan.scenes[0].shots)
      const target = data.targets[0]
      return { patches: [{ ...target, shot: { ...originalTargets[0], image_prompt: '低头的开镜画面已局部修复' } }] }
    },
  })
  const planned = await f.plan()
  assert.equal(planned.directing_review.status, 'needs_work')
  assert.equal(planned.directing_review.repaired, true)
  assert.equal(f.prompts.length, 1); assert.equal(f.reviewPrompts.length, 2); assert.equal(f.repairPrompts.length, 1)
  assert.match(planned.shots[0].image_prompt, /已局部修复/)
  assert.equal(planned.shots[1].title, originalTargets[1].title)
  assert.equal(planned.shots[2].title, originalTargets[2].title)
  const baseline = await fixture(t)
  const original = await baseline.plan()
  assert.deepEqual(planned.shots.slice(1), original.shots.slice(1))
  assert.deepEqual(planned.shots.map((s: any) => s.audio_plan), original.shots.map((s: any) => s.audio_plan))
  assert.deepEqual(planned.shots.map((s: any) => s.duration), [4, 4, 4])
  await f.invoke('commit', f.commitPayload(planned), 409)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('failed local patches keep the original clip without broad regeneration or lost review evidence', async t => {
  for (const mode of ['transport', 'duration', 'audio', 'unrelated']) {
    const f = await fixture(t, { review: () => ({ issues: [localIssue] }), repair: data => {
      if (mode === 'transport') throw new Error('patch provider unavailable')
      const target = data.targets[0], original = data.readonly_plan.scenes[0].shots[0]
      return { patches: [{ ...target, ...(mode === 'unrelated' ? { shot_index: 1 } : {}),
        shot: { ...original, ...(mode === 'duration' ? { duration: 5 } : {}), ...(mode === 'audio' ? { audio_plan: { ...original.audio_plan, sound_effects: ['新增音乐'] } } : {}) } }] }
    } })
    const planned = await f.plan()
    assert.equal(planned.directing_review.status, 'inconclusive', mode)
    assert.equal(planned.directing_review.repaired, false, mode)
    assert.deepEqual(planned.directing_review.issues, [localIssue], mode)
    assert.equal(planned.shots.length, 3); assert.equal(planned.shots[0].duration, 4)
    assert.doesNotMatch(planned.shots[0].audio_plan.sound_effects.join(','), /新增/)
    assert.equal(f.prompts.length, 1); assert.equal(f.reviewPrompts.length, 1)
    assert.equal(f.repairPrompts.length, mode === 'transport' ? 1 : 2)
  }
})

test('fresh clip saves require a matching receipt and replay ignores review-only metadata', async t => {
  const f = await fixture(t), planned = await f.plan(), payload = f.commitPayload(planned), before = resources(f.project.id)
  const { review_id: _id, ...missing } = payload
  await f.invoke('commit', missing, 409)
  await f.invoke('commit', { ...payload, review_id: randomUUID() }, 409)
  await f.invoke('commit', { ...payload, shots: payload.shots.map((s: any, i: number) => ({ ...s, title: i ? s.title : 'receipt tamper' })) }, 409)
  assert.deepEqual(resources(f.project.id), before)
  const saved = await f.invoke('commit', payload)
  const replay = await f.invoke('commit', { ...payload, review_id: randomUUID() })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.shots.map((s: any) => s.id), saved.shots.map((s: any) => s.id))
  // Historical hashes used the original schema property order, without review_id.
  const legacy = { source_text: payload.source_text, total_duration: payload.total_duration, instructions: payload.instructions,
    request_id: payload.request_id, signature: payload.signature, shots: payload.shots }
  run('UPDATE storyboard_clip_plans SET payload_hash=? WHERE design_id=?', createHash('sha256').update(JSON.stringify(legacy)).digest('hex'), payload.request_id)
  run('UPDATE projects SET ratio=? WHERE id=?', '9:16', f.project.id)
  assert.equal((await f.invoke('commit', missing)).replayed, true)
})

test('clip model and provider drift reject generation, review correction and fresh commit', async t => {
  for (const phase of ['generation', 'review', 'correction', 'commit']) {
    const provider = await api('POST', '/api/providers', { name: `clip-${phase}`, base_url: 'https://clip-config.invalid/v1', api_key: 'isolated' })
    const model = await api('POST', '/api/models', { provider_id: provider.id, name: 'clip model', remote_id: 'clip', modality: 'text', protocol: 'responses', settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } })
    let drifted = false
    const drift = () => { if (!drifted) { run('UPDATE providers SET base_url=? WHERE id=?', 'https://changed.invalid/v1', provider.id); drifted = true } }
    const f = await fixture(t, { modelId: model.id,
      generate: async () => { if (phase === 'generation') drift(); return JSON.stringify(draft()) },
      review: () => { if (phase === 'review' || phase === 'correction') drift(); return phase === 'correction' ? {} : { issues: [] } },
    })
    if (phase !== 'commit') {
      await f.invoke('plan', { signature: (await f.context()).signature, ...source, model_id: model.id, skill_ids: [] }, 409)
      assert.equal(f.prompts.length, 1)
      assert.equal(f.reviewPrompts.length, phase === 'generation' ? 0 : 1, 'config guard must stop format retry dispatch')
    } else {
      const planned = await f.plan(), payload = f.commitPayload(planned)
      run('UPDATE models SET remote_id=? WHERE id=?', 'changed-model', model.id)
      await f.invoke('commit', payload, 409)
    }
    assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
  }
})

test('review-only source and model changes reject late judgments instead of recording inconclusive quality', async t => {
  let mutate = false
  const f = await fixture(t, { review: () => { if (mutate) run('UPDATE projects SET ratio=? WHERE id=?', '9:16', f.project.id); return { issues: [] } } })
  const planned = await f.plan(), payload = f.commitPayload(planned)
  mutate = true
  await f.invoke('review', reviewPayload(payload), 409)
  assert.equal(f.prompts.length, 1)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('clip cancellation stops before any further review, repair or receipt', async t => {
  for (const phase of ['generation', 'review', 'repair', 'review-only']) {
    let cancel = phase !== 'review-only'
    const abort = (signal?: AbortSignal) => { f.activeRequest()!.raw.emit('aborted'); assert.equal(signal?.aborted, true) }
    const f = await fixture(t, {
      generate: async (_prompt, _call, signal) => { if (phase === 'generation') abort(signal); return JSON.stringify(draft()) },
      review: (_prompt, _call, signal) => { if (cancel && (phase === 'review' || phase === 'review-only')) abort(signal); return { issues: phase === 'repair' ? [localIssue] : [] } },
      repair: (_data, _prompt, _call, signal) => { abort(signal); throw new Error('aborted patch') },
    })
    if (phase === 'review-only') {
      const planned = await f.plan()
      cancel = true
      await f.invoke('review', reviewPayload(f.commitPayload(planned)), 499)
    } else await f.invoke('plan', { signature: (await f.context()).signature, ...source, model_id: 'mock-text', skill_ids: [] }, 499)
    assert.equal(f.prompts.length, 1)
    assert.equal(f.repairPrompts.length, phase === 'repair' ? 1 : 0)
    assert.equal(f.reviewPrompts.length, phase === 'generation' ? 0 : phase === 'review-only' ? 2 : 1)
    assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
  }
})

test('clip target-video changes during planning and review stop before any later dispatch', async t => {
  for (const phase of ['generation', 'review-only']) {
    const providerId = randomUUID(), videoId = randomUUID()
    run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES (?,?,'http','https://video.invalid',?)", providerId, 'clip video', now())
    run("INSERT INTO models (id,provider_id,name,remote_id,modality,settings) VALUES (?,?,?,?,'video','{}')", videoId, providerId, 'clip video', 'clip-video')
    let mutate = phase === 'generation'
    const f = await fixture(t, {
      generate: async () => { if (mutate) run('UPDATE models SET enabled=0 WHERE id=?', videoId); return JSON.stringify(draft()) },
      review: () => { if (mutate) run('UPDATE models SET enabled=0 WHERE id=?', videoId); return { issues: [] } },
    })
    if (phase === 'generation') await f.invoke('plan', { signature: (await f.context()).signature, ...source, model_id: 'mock-text', skill_ids: [], target_video_model_id: videoId }, 409)
    else {
      const planned = await f.plan({ target_video_model_id: videoId })
      mutate = true
      await f.invoke('review', reviewPayload(f.commitPayload(planned)), 409)
    }
    assert.equal(f.prompts.length, 1)
    assert.equal(f.reviewPrompts.length, phase === 'generation' ? 0 : 2)
    assert.equal(f.repairPrompts.length, 0)
    assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
  }
})

test('local clip repair preserves actual shot order when group definitions list a different order', async t => {
  const raw = withClipDirecting(draft())
  raw.groups.push({ ...raw.groups[0]!, group_id: 'later-group' })
  raw.shots[2]!.group_id = 'later-group'
  raw.groups.reverse()
  const f = await fixture(t, { generate: async () => JSON.stringify(raw), review: (_prompt, call) => ({ issues: call === 1 ? [localIssue] : [] }) })
  const planned = await f.plan()
  assert.deepEqual(planned.shots.map((s: any) => s.title), draft().shots.map(s => s.title))
  assert.deepEqual(planned.shots.map((s: any) => s.continuity_plan.group_id), ['clip-main', 'clip-main', 'later-group'])
  assert.equal(planned.directing_review.status, 'passed')
  assert.equal(f.prompts.length, 1); assert.equal(f.repairPrompts.length, 1)
  assert.equal((await f.invoke('commit', f.commitPayload(planned))).created_shots, 3)
})

test('complete original and locally repaired clips are checkpointed before their independent reviews', async t => {
  const snapshots: any[] = []
  const f = await fixture(t, { operations: true,
    review: (_prompt, call) => {
      const row = one<{ candidate: string }>('SELECT candidate FROM ai_operations WHERE project_id=? ORDER BY rowid DESC LIMIT 1', f.project.id)!
      const retained = JSON.parse(row.candidate)
      snapshots.push(retained)
      assert.equal(retained.shots.length, 3)
      assert.equal(retained.source_text, source.source_text)
      assert.equal(retained.directing_review.status, 'inconclusive')
      assert.equal(retained.directing_review.review_id, undefined)
      assert.equal(retained.directing_review.error.message, '处理中断，草稿已保留，请复查后保存')
      return { issues: call === 1 ? [localIssue] : [] }
    },
    repair: data => ({ patches: data.targets.map((target: any) => ({ ...target,
      shot: { ...data.readonly_plan.scenes[0].shots[target.shot_index], image_prompt: 'CHECKPOINT_REPAIRED_FRAME' } })) }),
  })
  const planned = await f.plan()
  assert.equal(planned.directing_review.status, 'passed')
  assert.equal(snapshots.length, 2)
  assert.doesNotMatch(snapshots[0].shots[0].image_prompt, /CHECKPOINT_REPAIRED_FRAME/)
  assert.match(snapshots[1].shots[0].image_prompt, /CHECKPOINT_REPAIRED_FRAME/)
  assert.deepEqual(snapshots[0].shots.slice(1), snapshots[1].shots.slice(1))
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('clip candidate checkpoint failures stop before review and cannot become quality success', async t => {
  for (const phase of ['first', 'repaired']) {
    const f = await fixture(t, { operations: true, review: () => ({ issues: [localIssue] }),
      repair: data => ({ patches: data.targets.map((target: any) => ({ ...target,
        shot: { ...data.readonly_plan.scenes[0].shots[target.shot_index], image_prompt: 'CHECKPOINT_REPAIRED_FRAME' } })) }),
    })
    const trigger = `clip_candidate_${randomUUID().replaceAll('-', '')}`
    db.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF candidate ON ai_operations
      WHEN NEW.project_id='${f.project.id}' ${phase === 'repaired' ? "AND OLD.candidate IS NOT NULL" : ''}
      BEGIN SELECT RAISE(ABORT,'isolated candidate persistence failure'); END`)
    try {
      await f.invoke('plan', { signature: (await f.context()).signature, ...source, model_id: 'mock-text', skill_ids: [] }, 503)
      assert.equal(f.prompts.length, 1)
      assert.equal(f.reviewPrompts.length, phase === 'first' ? 0 : 1)
      assert.equal(f.repairPrompts.length, phase === 'first' ? 0 : 1)
      assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
      if (phase === 'repaired') {
        const row = one<{ candidate: string }>('SELECT candidate FROM ai_operations WHERE project_id=? ORDER BY rowid DESC LIMIT 1', f.project.id)!
        assert.doesNotMatch(JSON.parse(row.candidate).shots[0].image_prompt, /CHECKPOINT_REPAIRED_FRAME/)
      }
    } finally { db.exec(`DROP TRIGGER ${trigger}`) }
  }
})
