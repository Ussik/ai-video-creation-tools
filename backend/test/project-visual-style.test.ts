import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'
import type { Project, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ProjectVisualStyle } from '@video-studio/shared/visuals/visual-style'
import { withProjectStyle, projectStyleTemplateError } from '@video-studio/shared/visuals/visual-style'

const directory = await mkdtemp(join(tmpdir(), 'project-style-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, one, run, now, initDb } = await import('../src/infrastructure/database/db.js')
const { projectVisualStyle } = await import('../src/modules/visuals/project-visual-style.js')
const { documentTools } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const { generate } = await import('../src/infrastructure/providers/providers.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function project(style = '日本二维动画') {
  const p = await call<Project>('POST', '/api/projects', { name: '画风隔离测试' })
  if (style) await settings(p.id, { visual_style: style, visual_style_details: { medium: '二维绘制', rendering: '赛璐璐', exclusions: ['真人摄影', '写实皮肤'] } })
  return p
}
async function settings(id: string, options: object) {
  await call('PUT', `/api/projects/${id}/script`, { outline: '故事', characters: '', generation_options: options })
}
async function model(video = false, requestTemplate: object = { prompt: '{{prompt}}', images: '{{images}}' }, requestTemplates?: Record<string, object>) {
  const p = await call('POST', '/api/providers', { name: '假提供商', base_url: 'https://example.invalid', adapter: 'http' })
  return call('POST', '/api/models', { provider_id: p.id, name: video ? '假视频模型' : '假图片模型', remote_id: 'fake', modality: video ? 'video' : 'image', protocol: video ? 'async_video' : 'image_generations', settings: {
    ...(video ? { create_path: '/video', get_path: '/video/{id}', supported_modes: ['text', 'first_frame', 'reference'] } : { request_path: '/image', image_base64_path: 'data.0.b64_json' }), request_template: requestTemplate, ...(requestTemplates ? { request_templates: requestTemplates } : {}),
  } })
}
async function profile(projectId: string) {
  const result = await call('POST', `/api/projects/${projectId}/visual-profiles`, { profiles: [{ kind: 'prop', name: '铜怀表', variant: '发光态', definition: '旧黄铜、幽蓝光、结绳，掌心大小。', view_requirements: '正侧背、手部握持、材质样本', scene_ids: [] }] })
  return result.visual_profiles[0]
}
function tools(p: Project, source: string, review = false, currentSettings?: Parameters<typeof documentTools>[0]['currentSettings']) {
  const script = () => {
    const row = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', p.id)
    return { outline: row?.outline || '', characters: row?.characters || '', generation_options: JSON.parse(row?.generation_options || '{}'),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', p.id), scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', p.id) }
  }
  return documentTools({ project: p, script, stage: directorStageContext(script()), messages: [{ role: 'user', text: source }], currentSettings,
    ...(review ? { action: { operation: 'review' as const, document_ids: ['legacy:outline'] } } : {}), checkApproval: async () => false, onEvent: () => {} })
}

test('native style tools persist separate structured settings with provenance and reject stale/foreign/read-only writes', async () => {
  const p = await project(''), session = tools(p, '本项目采用日漫二维画风，赛璐璐渲染，不要真人摄影。')
  const style = await session.execute('get_project_visual_style', {}) as ProjectVisualStyle
  await session.execute('set_project_visual_style', { expected_version: style.version, name: '日漫二维画风', details: { medium: '二维绘制', rendering: '赛璐璐', exclusions: ['真人摄影'] }, basis: 'creator_confirmed', source_message_index: 0 })
  const saved = projectVisualStyle(p.id)
  assert.equal(saved.source, 'settings'); assert.equal(saved.details.rendering, '赛璐璐')
  const decision = one<{ id: string; source_text: string }>('SELECT id, source_text FROM script_story_decisions WHERE project_id=? AND topic=?', p.id, '视觉风格')!
  assert.match(decision.source_text, /本项目采用日漫/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', p.id).length, 0)
  await assert.rejects(session.execute('set_project_visual_style', { expected_version: style.version, name: '真人', basis: 'creator_confirmed', source_message_index: 0 }), /画风已更新/)
  await assert.rejects(session.execute('set_project_visual_style', { expected_version: saved.version, name: '真人', basis: 'creator_confirmed', source_message_index: 5 }), /来源不存在/)
  await assert.rejects(session.execute('set_project_visual_style', { expected_version: saved.version, name: '旧版画风', basis: 'creator_confirmed', source_decision_id: decision.id }), /不能用历史决定覆盖/)
  await assert.rejects(tools(p, '评审', true).execute('set_project_visual_style', { expected_version: saved.version, name: '真人', basis: 'creator_confirmed', source_message_index: 0 }), /只评审/)
  await session.execute('record_story_decision', { topic: '视觉风格', content: '改为水彩', basis: 'creator_confirmed', source_message_index: 0, settings_patch: { visual_style: '水彩' } })
  assert.deepEqual(projectVisualStyle(p.id).details, {})
})

test('legacy confirmed anime context reaches boards without writing or guessing the genre, and can be normalized from a saved source', async () => {
  const p = await project(''), session = tools(p, '日漫风格剧场版')
  await session.execute('record_story_decision', { topic: '故事方向', content: '现代都市暗黑奇幻，日漫风格剧场版。', basis: 'creator_confirmed', source_message_index: 0, settings_patch: { genre: '现代都市暗黑奇幻（日漫风格剧场版）', visual_style: '' } })
  const style = projectVisualStyle(p.id), board = await profile(p.id)
  assert.equal(style.source, 'confirmed_context'); assert.match(board.board_prompt, /日漫风格/)
  assert.match(board.board_prompt, /不把题材、时代或剧情推断成画风/)
  assert.equal(JSON.parse(one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', p.id)!.generation_options).visual_style, '')
  const state = await session.execute('get_project_visual_style', {}) as any
  await session.execute('set_project_visual_style', { expected_version: state.version, name: '日漫风格', source_decision_id: state.confirmed_sources[0].id, basis: 'creator_confirmed' })
  assert.equal(projectVisualStyle(p.id).label, '日漫风格')
  const unrelated = await project('')
  assert.equal(projectVisualStyle(unrelated.id).source, 'unspecified')
  assert.doesNotMatch((await profile(unrelated.id)).board_prompt, /日漫|赛璐璐/)
})

test('unrelated decisions cannot overwrite confirmed style with stale or unconfirmed client form settings', async () => {
  const p = await project(), before = projectVisualStyle(p.id)
  const session = tools(p, '全剧共十二集，每集六十秒。', false, { visual_style: '旧版写实', visual_style_details: { medium: '摄影' }, episode_count: 12 })
  const state = await session.execute('get_creation_state', {}) as any
  assert.equal(state.settings.visual_style, before.label)
  assert.equal(state.settings.visual_style_details.rendering, '赛璐璐')
  await session.execute('record_story_decision', { topic: '制作规模', content: '12集，每集60秒', basis: 'creator_confirmed', source_message_index: 0, settings_patch: { episode_count: 12, episode_duration: 60 } })
  assert.deepEqual(projectVisualStyle(p.id), before)
  const saved = JSON.parse(one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', p.id)!.generation_options)
  assert.equal(saved.episode_count, 12); assert.equal(saved.episode_duration, 60)
  const blank = await project(''), blankSession = tools(blank, '全剧十集。', false, { visual_style: '未确认的默认画风' })
  await blankSession.execute('record_story_decision', { topic: '集数', content: '十集', basis: 'creator_confirmed', source_message_index: 0, settings_patch: { episode_count: 10 } })
  assert.equal(JSON.parse(one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', blank.id)!.generation_options).visual_style, undefined)
})

test('manual board overrides receive one current style block and exact preview is queued; style changes invalidate old submissions', async () => {
  const p = await project(), m = await model(), board = await profile(p.id)
  const input = { expected_revision: board.revision, model_id: m.id, prompt_override: '黄铜怀表，掌心大小，完整设定板' }
  const preview = await call('POST', `/api/visual-profiles/${board.id}/board-preview`, input)
  assert.match(preview.prompt, /日本二维动画/); assert.match(preview.prompt, /手部及全部辅助视图/)
  const prompt = withProjectStyle(preview.prompt + '\n图片生成要求：9:16，2K', preview.project_visual_style)
  const payload = { ...input, project_style_version: preview.project_style_version, reference_signature: preview.reference_signature, prompt, ratio: '9:16', resolution: '2K', quality: null, clarity: null, background: null }
  const generated = await call('POST', `/api/visual-profiles/${board.id}/generate`, payload)
  const stored = JSON.parse(generated.job.request)
  assert.equal(stored.prompt, prompt); assert.equal(stored.prompt.split('【项目画风约束】').length, 2)
  assert.equal(stored.project_visual_style.label, '日本二维动画')
  await settings(p.id, { visual_style: '水彩动画' })
  const rejected = await app.inject({ method: 'POST', url: `/api/visual-profiles/${board.id}/generate`, payload })
  assert.equal(rejected.statusCode, 409); assert.match(rejected.body, /画风已更新/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', p.id).length, 1)
})

test('images without bindings and first-frame videos cannot bypass style through final prompts; previews and queue match', async () => {
  const p = await project(), imageModel = await model(), videoModel = await model(true)
  const shot = await call('POST', `/api/projects/${p.id}/shots`, { title: '镜头', prompt: '人物握持铜表', duration: 5 })
  for (const m of [imageModel, videoModel]) {
    const input = { shot_id: shot.id, model_id: m.id, prompt: '手改的动作、构图与运镜', prompt_is_final: true, visual_reference_mode: 'text_only', mode: 'text' }
    const preview = await call('POST', `/api/projects/${p.id}/generate/preview`, input)
    const job = await call('POST', `/api/projects/${p.id}/generate`, preview)
    assert.equal(JSON.parse(job.request).prompt, preview.prompt); assert.match(preview.prompt, /手改的动作/); assert.match(preview.prompt, /赛璐璐/)
  }
  const preview = await call('POST', `/api/projects/${p.id}/generate/preview`, { model_id: imageModel.id, source_artifact_type: 'prop', prompt: '无镜头铜表' })
  assert.match(preview.prompt, /日本二维动画/)
  await settings(p.id, { visual_style: '水墨' })
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/generate`, payload: { ...preview, shot_id: shot.id } })).statusCode, 409)
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'frame.png', '/tmp/frame.png', 'upload', ?)", `frame-${p.id}`, p.id, now())
  const video = await call('POST', `/api/projects/${p.id}/generate/preview`, { shot_id: shot.id, model_id: videoModel.id, prompt: '从首帧连续展开动作', mode: 'first_frame', visual_reference_mode: 'keyframe', reference_asset_ids: [`frame-${p.id}`] })
  assert.match(video.prompt, /水墨/); assert.equal(video.style_warnings.length, 1)
})

test('confirmed boards and frozen shot references require explicit review after a style change; history is retained', async () => {
  const p = await project(), m = await model(), board = await profile(p.id), assetId = `board-${p.id}`
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'board.png', '/tmp/board.png', 'upload', ?)", assetId, p.id, now())
  const approved = await call('PATCH', `/api/visual-profiles/${board.id}`, { expected_revision: board.revision, board_asset_id: assetId })
  const shot = await call('POST', `/api/projects/${p.id}/shots`, { title: '镜头' })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: board.id, required: true }] })
  await settings(p.id, { visual_style: '水彩动画' }); initDb()
  const detail = await call('GET', `/api/projects/${p.id}`)
  assert.equal(detail.visual_profiles[0].board_style_status, 'needs_review')
  const input = { shot_id: shot.id, model_id: m.id, prompt: '铜表近景', mode: 'text' }
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/generate/preview`, payload: input })).statusCode, 422)
  await call('PATCH', `/api/visual-profiles/${board.id}`, { expected_revision: approved.revision, board_asset_id: assetId })
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/generate/preview`, payload: input })).statusCode, 422)
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: board.id, required: true }], refresh_profile_ids: [board.id] })
  const preview = await call('POST', `/api/projects/${p.id}/generate/preview`, input)
  assert.match(preview.prompt, /水彩动画/); assert.deepEqual(preview.reference_asset_ids, [assetId])
  assert.equal(all('SELECT * FROM assets WHERE project_id=?', p.id).length, 1)
})

test('templates that discard the prompt fail before charging or queueing, including mode-specific templates', async () => {
  const p = await project(), models = [await model(false, { prompt: '硬编码写实' }),
    await model(false, { prompt: '{{prompt}}' }, { text: { prompt: '此模式丢掉提示词' }, reference: { prompt: '{{prompt}}' } })]
  for (const m of models) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/generate/preview`, payload: { model_id: m.id, prompt: '铜表' } })
    assert.equal(response.statusCode, 422); assert.match(response.body, /未传递完整提示词/)
  }
  const style = projectVisualStyle(p.id)
  assert.equal(projectStyleTemplateError(style, typeof models[1].settings === 'string' ? JSON.parse(models[1].settings) : models[1].settings, 'reference'), null)
  assert.equal(projectStyleTemplateError(style, { request_template: { messages: '{{content}}' }, content_template: [{ text: '{{prompt}}' }] }, 'text'), null)
  assert.match(projectStyleTemplateError(style, { request_template: { messages: '{{content}}' }, content_template: [{ text: '无提示词' }] }, 'text')!, /未传递完整提示词/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', p.id).length, 0)
})

test('the provider receives the compiled style constraint in its actual request body without an invented negative-prompt parameter', async t => {
  const p = await project(), m = await model(), pixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
  let submitted = false
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /example.invalid\/image$/)
    const body = JSON.parse(String(init.body)); assert.match(body.prompt, /日本二维动画/); assert.match(body.prompt, /真人摄影/)
    assert.equal('negative_prompt' in body, false); submitted = true
    return Response.json({ data: [{ b64_json: pixel.toString('base64') }] })
  })
  const style = projectVisualStyle(p.id)
  await generate({ id: m.id, remote_id: 'fake', modality: 'image', settings: m.settings, protocol: 'image_generations' },
    { adapter: 'http', base_url: 'https://example.invalid' }, { prompt: withProjectStyle('铜表信息图', style) }, [], p.id, () => {})
  assert.ok(submitted)
})
