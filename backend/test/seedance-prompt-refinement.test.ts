import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import { mentionsSeedanceVersion, seedance2PromptGuidance } from '../src/modules/generation/seedance-prompt.js'
import { seedance2VideoSettings, seedance25VideoSettings } from '@video-studio/shared/models/seedance-video-settings'

const testData = await mkdtemp(join(tmpdir(), 'seedance-prompt-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, run, all } = await import('../src/infrastructure/database/db.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const { installSkillBundle, configureSkill, skillContext } = await import('../src/modules/skills/skills.js')
const app = buildApp(), refineApp = Fastify()
let captured = '', calls = 0
refineApp.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
registerSkillRoutes(refineApp, {
  selectSkills: async (_project, _model, input) => ({ skill_ids: input.default_ids, reason: '模型选择当前视频提示词技能。' }),
  generateText: async (_project, _model, prompt) => {
  captured = prompt; calls++
  return JSON.stringify({ prompt: '林晚抬起右手，随后转身。固定机位。{林晚用中文说：“我会回来的。”}保持无字幕。' })
} })
after(async () => { await refineApp.close(); await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

const skill = installSkillBundle({
  repo: 'fixture/seedance', path: 'skills/video', name: 'seedance-video-fixture', description: '视频规则', license: null,
  revision: 'a'.repeat(40), suggested_stages: ['video_prompt'], tool_requirements: [], url: 'https://example.invalid',
  files: [
    { path: 'skills/video/SKILL.md', content: '---\nname: seedance-video-fixture\ndescription: 视频规则\n---\n# 主规则\n保留叙事。' },
    { path: 'skills/video/references/seedance-2.0.md', content: '# Seedance 2.0 专用方言\n保持2.0动作时序。' },
    { path: 'skills/video/references/seedance-2.5.md', content: '# 2.5专用方言\n2.5时间控制。' },
  ],
})
configureSkill(skill.id, true, ['video_prompt'])

async function setup(remoteId = 'doubao-seedance-2-0-mini-260615') {
  async function create(url: string, payload: unknown) {
    const response = await app.inject({ method: 'POST', url, payload })
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
  }
  const project = await create('/api/projects', { name: 'Seedance 指南验证' })
  const provider = await create('/api/providers', { name: '模型配置', adapter: 'http', base_url: 'https://video.invalid/api/v3' })
  const settings = { ...seedance2VideoSettings(), supported_modes: ['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend'],
    video_reference_profile: undefined, max_reference_images: 9,
    content_template: [{ type: 'text', text: '{{prompt}}' }, '{{image_references}}', '{{video_references}}'],
    video_reference_template: { type: 'video_url', video_url: { url: '{{reference_video_url}}' }, role: 'reference_video' } }
  const model = await create('/api/models', { provider_id: provider.id, name: '视频模型', remote_id: remoteId, modality: 'video', protocol: 'async_video', settings })
  const ids = Array.from({ length: 10 }, (_value, index) => `${project.id}-image-${index + 1}`)
  for (const id of ids) run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,'/tmp/fixture.png','upload','2026-10-10')", id, project.id, `${id}.png`)
  return { project, model, ids, settings, input: { model_id: 'text-fixture', target_model_id: model.id, stage: 'video_prompt', skill_ids: [skill.id],
    mode: 'reference', prompt: '林晚抬起右手，随后转身。她说：“我会回来的。”', ratio: '9:16', duration: 5, reference_asset_ids: ids.slice(0, 2) } }
}

test('2.0 dialect references load for official Mini/Fast IDs and explicit labels without loading 2.5 rules', () => {
  for (const label of ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-fast-260128', 'Seedance 2.0', 'seedance_2_0']) {
    assert.equal(mentionsSeedanceVersion(label, '2.0'), true)
    const context = skillContext('video_prompt', `目标模型：${label}`, [skill.id])
    assert.ok(context.files.includes('skills/video/references/seedance-2.0.md'), label)
    assert.ok(!context.files.includes('skills/video/references/seedance-2.5.md'), label)
  }
  assert.equal(mentionsSeedanceVersion('seedance-2-05', '2.0'), false)
  assert.equal(mentionsSeedanceVersion('seedance-2.5', '2.0'), false)
  assert.ok(!skillContext('video_prompt', '其他模型', [skill.id]).files.includes('skills/video/references/seedance-2.0.md'))
  const settings = { video_prompt_dialect: 'seedance-2.0' }
  assert.match(seedance2PromptGuidance({ name: '自定义', remote_id: 'custom', settings }), /Seedance 2.0 系列提示词要求/)
  assert.match(seedance2PromptGuidance({ name: 'Seedance 2.0', remote_id: 'seedance-2.5', settings: {} }), /Seedance 2.5 提示词要求/)
})

test('official 2.5 model ID loads the matching skill and integer-second guidance with thirty ordered references', async () => {
  const { project, model, ids, input } = await setup('doubao-seedance-2-5-260628')
  const updated = await app.inject({ method: 'PATCH', url: `/api/models/${model.id}`, payload: { settings: seedance25VideoSettings() } })
  assert.equal(updated.statusCode, 200, updated.body)
  const extra = Array.from({ length: 20 }, (_, index) => `${project.id}-extra-${index}`)
  for (const id of extra) run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,'/tmp/fixture.png','upload','2026-10-24')", id, project.id, `${id}.png`)
  const references = [...ids, ...extra]
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, reference_asset_ids: references, explicit_reference_asset_ids: references,
    video_reference_usages: references.map(asset_id => ({ asset_id, usage: 'identity' })), duration: 30,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.ok(response.json().loaded_files.includes('skills/video/references/seedance-2.5.md'))
  assert.ok(!response.json().loaded_files.includes('skills/video/references/seedance-2.0.md'))
  assert.match(captured, /【Seedance 2.5 提示词要求】/)
  assert.match(captured, /支持整数秒时间戳/)
  assert.doesNotMatch(captured, /精确时间戳响应不稳定/)
  assert.match(response.json().prompt, /图片30/)
  const before = calls
  const tooMany = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, reference_asset_ids: [...references, 'over-limit'] } })
  assert.equal(tooMany.statusCode, 422)
  assert.equal(calls, before)
})

test('Mini refinement combines installed dialect with current-node guidance and preserves the draft contract', async () => {
  const { project, input, ids } = await setup()
  const before = { jobs: all('SELECT * FROM jobs'), nodes: all('SELECT * FROM canvas_nodes'), shots: all('SELECT * FROM shots') }
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: input })
  assert.equal(response.statusCode, 200, response.body)
  assert.ok(response.json().loaded_files.includes('skills/video/references/seedance-2.0.md'))
  assert.match(captured, /Seedance 2.0 专用方言/)
  assert.doesNotMatch(captured, /2.5专用方言/)
  assert.match(captured, /不增加其他镜头/)
  assert.match(captured, /精确时间戳响应不稳定/)
  assert.match(captured, /一种主要运镜/)
  assert.match(captured, /不猜测图片/)
  assert.match(captured, /未提供实际音视频绑定/)
  assert.match(captured, /角色名的面部特征参考图片1/)
  assert.match(captured, /"ratio":"9:16","duration":5,"mode":"reference"/)
  assert.ok(captured.indexOf(`"id":"${ids[0]}"`) < captured.indexOf(`"id":"${ids[1]}"`))
  assert.match(captured, /只输出合法 JSON/)
  assert.match(response.json().prompt, /我会回来的/)
  assert.deepEqual(all('SELECT * FROM jobs'), before.jobs)
  assert.deepEqual(all('SELECT * FROM canvas_nodes'), before.nodes)
  assert.deepEqual(all('SELECT * FROM shots'), before.shots)
})

test('2.5 editing refinement follows source duration without comparing it against positive shot planning duration', async () => {
  const { project, model, input } = await setup('doubao-seedance-2-5-260628')
  const updated = await app.inject({ method: 'PATCH', url: `/api/models/${model.id}`, payload: { settings: seedance25VideoSettings() } })
  assert.equal(updated.statusCode, 200, updated.body)
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, skill_ids: [], mode: 'edit', duration: 5, reference_asset_ids: [],
    prompt: '视频时长：20秒。\n编辑视频，保留人物转身，删除背景字幕。',
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(captured, /"ratio":"adaptive","duration":null,"mode":"edit"/)
  assert.match(captured, /"duration_follows_source":true/)
  assert.match(captured, /原视频画幅和时长跟随输入/)
})

test('built-in 2.0 guidance applies without an external skill but not to other target models', async () => {
  const mini = await setup(), other = await setup('other-video-model')
  for (const [state, shouldUseGuide] of [[mini, true], [other, false]] as const) {
    const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${state.project.id}/skills/refine-prompt`, payload: { ...state.input, skill_ids: [] } })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().skills, [])
    assert.equal(captured.includes('【Seedance 2.0 系列提示词要求】'), shouldUseGuide)
  }
})

test('explicit nine-image cap rejects before refinement or generation and retains video/edit/extend settings', async () => {
  const { project, model, ids, input, settings } = await setup()
  const url = `/api/projects/${project.id}/skills/refine-prompt`, before = calls
  const tooMany = await refineApp.inject({ method: 'POST', url, payload: { ...input, reference_asset_ids: ids } })
  assert.equal(tooMany.statusCode, 422)
  assert.match(tooMany.body, /9 张/)
  assert.equal(calls, before)
  const preview = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: {
    model_id: model.id, mode: 'reference', prompt: input.prompt, reference_asset_ids: ids,
  } })
  assert.equal(preview.statusCode, 422, preview.body)
  assert.match(preview.body, /9 张/)
  const valid = await refineApp.inject({ method: 'POST', url, payload: { ...input, reference_asset_ids: ids.slice(0, 9) } })
  assert.equal(valid.statusCode, 200, valid.body)
  assert.equal(calls, before + 1)
  const stored = all<{ settings: string }>('SELECT settings FROM models WHERE id=?', model.id)[0]!
  assert.deepEqual(JSON.parse(stored.settings).video_reference_template, settings.video_reference_template)
  assert.deepEqual(JSON.parse(stored.settings).supported_modes, settings.supported_modes)
  const generic = await app.inject({ method: 'PATCH', url: `/api/models/${model.id}`, payload: { remote_id: 'custom-video-model', settings: { ...settings, max_reference_images: 10 } } })
  assert.equal(generic.statusCode, 200, generic.body)
  const customLimit = await refineApp.inject({ method: 'POST', url, payload: { ...input, reference_asset_ids: ids } })
  assert.equal(customLimit.statusCode, 200, customLimit.body)
})

test('refinement receives ending and scale purposes in actual order and returns the same managed uses', async () => {
  const { project, ids, input } = await setup()
  const usages = [{ asset_id: ids[0], usage: 'ending' }, { asset_id: ids[1], usage: 'scale' }]
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, storyboard_reference_asset_id: ids[0], video_reference_usages: usages,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(captured, /"image_number":1.*"usage":"ending".*不提前作为开场/)
  assert.match(captured, /"image_number":2.*"usage":"scale".*不继承人物五官/)
  assert.match(captured, /开场状态、动作先后、运镜、收镜状态/)
  assert.doesNotMatch(captured, /分镜图用于构图与动作起点/)
  assert.match(response.json().prompt, /图片1：分镜构图.*结尾构图/)
  assert.match(response.json().prompt, /图片2：手动参考.*只参考.*相对大小/)
  const before = calls
  for (const video_reference_usages of [[...usages, usages[0]], [{ asset_id: ids[9], usage: 'identity' }]]) {
    const invalid = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, video_reference_usages } })
    assert.equal(invalid.statusCode, 422)
  }
  assert.equal(calls, before)
})

test('video refinement omits inactive bindings but keeps excluded definitions without their input images', async () => {
  const { project, ids, input } = await setup()
  async function create(method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown) {
    const response = await app.inject({ method, url, payload })
    assert.equal(response.statusCode, 200, response.body); return response.json()
  }
  const shot = await create('POST', `/api/projects/${project.id}/shots`, { title: '仅视频对象', video_prompt: input.prompt })
  const { visual_profiles: profiles } = await create('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind: 'character', name: '视频演员', definition: '视频演员固定外观', view_requirements: '正侧面' },
    { kind: 'character', name: '静态专用人物', definition: '静态专用人物固定外观', view_requirements: '正侧面' },
    { kind: 'prop', name: '不出镜道具', definition: '不出镜道具固定外观', view_requirements: '正侧面' },
    { kind: 'location', name: '排除场地', definition: '排除场地固定外观', view_requirements: '正侧面' },
  ] })
  const byName = ['视频演员', '静态专用人物', '不出镜道具', '排除场地'].map(name => profiles.find((profile: any) => profile.name === name))
  for (let index = 0; index < 4; index++) await create('PATCH', `/api/visual-profiles/${byName[index].id}`, { expected_revision: 1, board_asset_id: ids[index] })
  await create('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: byName.map((profile, index) => ({ profile_id: profile.id, required: index === 0, usage: ['video', 'image', 'none', 'both'][index] })) })
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, shot_id: shot.id, reference_asset_ids: ids.slice(0, 4), excluded_visual_profile_ids: [byName[3].id],
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(captured, /视频演员固定外观/)
  assert.match(captured, /排除场地固定外观/)
  assert.doesNotMatch(captured, /静态专用人物固定外观|不出镜道具固定外观/)
  const result = response.json()
  assert.match(result.prompt, /排除场地固定外观/)
  const mapping = result.prompt.split('【视频参考图用途】')[1]!.split('【视频参考图用途结束】')[0]!
  assert.doesNotMatch(mapping, /排除场地/)
  const referenceLine = captured.split('\n').find(line => line.startsWith('实际参考图'))!
  assert.match(referenceLine, new RegExp(ids[0]))
  for (const id of ids.slice(1, 4)) assert.ok(!referenceLine.includes(id))
})
