import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import Fastify from 'fastify'
import sharp from 'sharp'
import { ZodError } from 'zod'
import type { Asset, Shot, TimelineClip } from '@video-studio/shared/api/contracts'
import type { VideoContinuityFinding } from '@video-studio/shared/media/video-continuity-review'
import type { TextImageInput } from '../src/infrastructure/providers/text-image-input.js'
import { adjacentStoryboardShots, storyboardContinuityContext, storyboardSelectedMedia } from '@video-studio/shared/storyboard/storyboard-media-context'

const directory = await mkdtemp(join(tmpdir(), 'video-continuity-review-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { all, db, initDb, mediaDir, now, run } = await import('../src/infrastructure/database/db.js')
const { registerVideoContinuityReviewRoutes, validateVideoContinuityFindings } = await import('../src/modules/canvas/video-continuity-review.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
run("INSERT INTO providers(id,name,adapter,base_url,created_at) VALUES('continuity-provider','测试','http','https://example.invalid','now')")
for (const [id, modality, enabled, settings] of [
  ['continuity-reader', 'text', 1, { supports_vision: true }],
  ['continuity-no-vision', 'text', 1, {}],
  ['continuity-disabled', 'text', 0, {}],
  ['continuity-video', 'video', 1, {}],
] as const) run('INSERT INTO models(id,provider_id,name,remote_id,modality,settings,enabled) VALUES(?,?,?,?,?,?,?)',
  id, 'continuity-provider', id, `${id}-remote`, modality, JSON.stringify(settings), enabled)

const dialogue = '千万别看窗外！闭眼！'
const speech = { speaker: '陆照霜', text: dialogue, delivery: '急促', mode: 'dialogue', source_text: `陆照霜说：“${dialogue}”` }
const report = () => ({ summary: '核对当前提示词与已确认的镜头边界。', findings: [] as VideoContinuityFinding[], uncertainties: [] as string[] })
const finding = (overrides: Partial<VideoContinuityFinding> = {}): VideoContinuityFinding => ({
  category: 'opening_state', severity: 'error', basis: 'text', observation: '开镜已写出结果，动作段又要求从未发生的状态开始。',
  quotes: ['眼中已经爆发金芒', '双眼尚未睁开'], image_index: null, suggestion: '先确认开镜状态，再统一首帧与动作段。', ...overrides,
})

async function fixture(t: TestContext, generate?: (call: number) => unknown | Promise<unknown>) {
  const projectId = randomUUID(), shotId = randomUUID(), previousId = randomUUID(), timestamp = now()
  run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', projectId, '真实接镜核对测试', timestamp, timestamp)
  for (const [id, position, title, start, end] of [[previousId, 0, '接纸', '右手伸向纸条', '右手夹住纸条'], [shotId, 1, '金芒出鞘', '双眼尚未睁开', '金芒映亮车厢']] as const) {
    run('INSERT INTO shots(id,project_id,position,title,prompt,image_prompt,video_prompt,duration,start_state,end_state,cut_note,audio_plan,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, projectId, position, title, '不增加剧情', '人物处于暗处', '睁眼后出鞘', 4, start, end, '按动作阶段切镜',
      JSON.stringify({ version: 1, speech: id === shotId ? [speech] : [], sound_effects: [], music: '', silent: false }), timestamp)
  }
  const prompts: string[] = [], images: TextImageInput[][] = []
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 422 : (error as Error & { statusCode?: number }).statusCode || 500).send({ detail: error.message }))
  registerVideoContinuityReviewRoutes(app, { generateText: async (id, model, prompt, contract, signal, attached) => {
    assert.equal(id, projectId); assert.equal(model, 'continuity-reader'); assert.equal(contract?.name, 'video_continuity_review')
    assert.equal(signal?.aborted, false); prompts.push(prompt); images.push(attached || [])
    return JSON.stringify(generate ? await generate(prompts.length) : report())
  } })
  t.after(() => app.close())
  const payload = { model_id: 'continuity-reader', target_model_id: 'continuity-video', shot_id: shotId,
    prompt: `开镜：眼中已经爆发金芒。动作起点：双眼尚未睁开。陆照霜说：“${dialogue}”`, generation_duration: 4, source_signature: '0123456789abcdef' }
  const invoke = async (overrides: object = {}, status = 200) => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/canvas/video-continuity-review`, payload: { ...payload, ...overrides } })
    assert.equal(response.statusCode, status, response.body); return response.json()
  }
  const resources = () => Object.fromEntries(['projects', 'shots', 'assets', 'timeline_clips', 'jobs', 'canvas_nodes'].map(table => [table, all(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY rowid`, projectId)]))
  const addAsset = async (shot = previousId, kind = 'video', project = projectId) => {
    const assetId = randomUUID(), path = join(mediaDir, `${assetId}.${kind === 'image' ? 'jpg' : 'mp4'}`)
    if (kind === 'image') await writeFile(path, await sharp({ create: { width: 24, height: 16, channels: 3, background: '#243543' } }).jpeg().toBuffer())
    run('INSERT INTO assets(id,project_id,shot_id,kind,filename,path,source,created_at) VALUES(?,?,?,?,?,?,?,?)', assetId, project, shot, kind, `${assetId}.mp4`, path, 'upload', timestamp)
    return assetId
  }
  const selectPrevious = async () => {
    const assetId = await addAsset()
    run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, previousId)
    run('INSERT INTO timeline_clips(id,project_id,shot_id,asset_id,in_ms,out_ms,source_duration_ms) VALUES(?,?,?,?,?,?,?)', randomUUID(), projectId, previousId, assetId, 100, 3200, 4000)
    return assetId
  }
  return { projectId, shotId, previousId, prompts, images, payload, invoke, resources, addAsset, selectPrevious }
}

test('final-prompt review uses exact evidence, model capabilities and confirmed dialogue without writing project state', async t => {
  const f = await fixture(t, () => ({ ...report(), findings: [finding()] })), before = f.resources()
  const result = await f.invoke()
  assert.deepEqual(result.findings[0].quotes, ['眼中已经爆发金芒', '双眼尚未睁开'])
  assert.equal(result.source_signature, f.payload.source_signature)
  assert.match(result.context_signature, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.images, [])
  assert.equal(f.images[0]!.length, 0)
  assert.match(f.prompts[0]!, /continuity-video-remote/)
  assert.ok(f.prompts[0]!.includes(dialogue))
  assert.match(f.prompts[0]!, /本次不允许改动已确认的台词、说话者或改为画外声/)
  assert.match(result.uncertainties.join(''), /未验证实际音轨/)
  assert.deepEqual(f.resources(), before)
})

test('disabling generated sound conflicts with confirmed speech even when the prompt retains its exact text', async t => {
  const f = await fixture(t)
  const result = await f.invoke({ generate_audio: false, mode: 'reference' })
  assert.equal(result.findings[0].category, 'dialogue_change')
  assert.match(result.findings[0].observation, /生成声音已关闭/)
  assert.match(f.prompts[0]!, /"generation_mode":"reference","generate_audio":false/)
  const allowed = await f.invoke({ generate_audio: false, modify_audio: true })
  assert.equal(allowed.findings.length, 0)
})

test('another project shot or storyboard image cannot enter review context', async t => {
  const f = await fixture(t), otherProject = randomUUID(), foreignShot = randomUUID(), timestamp = now()
  run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', otherProject, '其他项目', timestamp, timestamp)
  run('INSERT INTO shots(id,project_id,position,title,prompt,created_at) VALUES(?,?,0,?,?,?)', foreignShot, otherProject, '其他镜头', '保密其他内容', timestamp)
  const foreignImage = await f.addAsset(foreignShot, 'image', otherProject)
  await f.invoke({ shot_id: foreignShot }, 404)
  await f.invoke({ storyboard_asset_id: foreignImage }, 422)
  const wrongShotImage = await f.addAsset(f.previousId, 'image')
  await f.invoke({ storyboard_asset_id: wrongShotImage }, 422)
  assert.equal(f.prompts.length, 0)
})

test('missing, disabled or wrong-modality review and target models fail before inference', async t => {
  const f = await fixture(t)
  for (const model_id of ['missing', 'continuity-disabled', 'continuity-video']) await f.invoke({ model_id }, 422)
  for (const target_model_id of ['missing', 'continuity-reader']) await f.invoke({ target_model_id }, 422)
  await f.invoke({ include_frames: true, model_id: 'continuity-no-vision' }, 422)
  assert.equal(f.prompts.length, 0)
})

test('invented quotes and text findings without quotes are rejected after bounded correction', async t => {
  for (const quotes of [['来源中不存在的血书变剑'], []]) {
    const f = await fixture(t, () => ({ ...report(), findings: [finding({ quotes })] })), before = f.resources()
    const result = await f.invoke({}, 422)
    assert.match(result.detail, /逐字引用/)
    assert.equal(f.prompts.length, 2)
    assert.deepEqual(f.resources(), before)
  }
})

test('a model cannot report pixels findings when no actual images were attached', async t => {
  const f = await fixture(t, () => ({ ...report(), findings: [finding({ basis: 'pixels', image_index: 1, quotes: [] })] }))
  const result = await f.invoke({}, 422)
  assert.match(result.detail, /未提供的真实画面/)
  assert.equal(f.images.every(images => images.length === 0), true)
})

test('pixel findings require the supplied image index and cannot certify audio from a still', async t => {
  const f = await fixture(t, () => ({ ...report(), findings: [finding({ basis: 'pixels', image_index: 1, quotes: [] })] }))
  const storyboardId = await f.addAsset(f.shotId, 'image'), before = f.resources()
  const result = await f.invoke({ include_frames: true, storyboard_asset_id: storyboardId })
  assert.equal(f.images[0]!.length, 1)
  assert.match(f.images[0]![0]!.data_url!, /^data:image\/jpeg;base64,/)
  assert.deepEqual(result.images, [{ role: 'current_storyboard', asset_id: storyboardId, time_ms: null }])
  assert.deepEqual(f.resources(), before)
  for (const category of ['audio_continuity', 'dialogue_change'] as const) assert.throws(() => validateVideoContinuityFindings([
    finding({ category, basis: 'pixels', image_index: 1, quotes: [] }),
  ], {}, 1), /静帧不能作为音轨/)
  assert.throws(() => validateVideoContinuityFindings([finding({ basis: 'pixels', image_index: 2, quotes: [] })], {}, 1), /未提供的真实画面/)
})

test('replacing a previous selected take invalidates an in-flight final-prompt review', async t => {
  let replace = () => {}
  const f = await fixture(t, () => { replace(); return report() })
  await f.selectPrevious()
  const replacement = await f.addAsset()
  replace = () => { run('UPDATE shots SET selected_asset_id=? WHERE id=?', replacement, f.previousId) }
  const result = await f.invoke({}, 409)
  assert.match(result.detail, /选用素材或取段/)
  assert.equal(f.prompts.length, 1)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.projectId).length, 0)
})

test('changing only the previous accepted trim invalidates an in-flight review', async t => {
  let projectId = ''
  const f = await fixture(t, () => { run('UPDATE timeline_clips SET out_ms=3100 WHERE project_id=?', projectId); return report() })
  projectId = f.projectId
  await f.selectPrevious()
  await f.invoke({}, 409)
  assert.equal(f.prompts.length, 1)
})

test('explicit audio revision changes the review instruction without rewriting saved speech', async t => {
  const f = await fixture(t), before = f.resources()
  await f.invoke({ modify_audio: true })
  assert.match(f.prompts[0]!, /创作者显式允许按最新设计调整声音/)
  assert.doesNotMatch(f.prompts[0]!, /本次不允许改动已确认/)
  assert.ok(f.prompts[0]!.includes('"mode":"dialogue"'))
  assert.ok(f.prompts[0]!.includes('"speaker":"陆照霜"'))
  assert.deepEqual(f.resources(), before)
})

test('missing confirmed dialogue is reported even when semantic review returns no findings', async t => {
  const f = await fixture(t), before = f.resources()
  const result = await f.invoke({ prompt: '人物从暗处睁眼，青铜短尺出鞘。' })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].category, 'dialogue_change')
  assert.equal(result.findings[0].severity, 'error')
  assert.deepEqual(result.findings[0].quotes, [dialogue])
  assert.match(result.findings[0].observation, /未完整出现在最终生成提示词/)
  assert.deepEqual(f.resources(), before)
})

test('an explicit audio revision may intentionally retain only part of a confirmed line', async t => {
  const f = await fixture(t), before = f.resources()
  const result = await f.invoke({ modify_audio: true, prompt: '人物只说：“闭眼！”随后出鞘。' })
  assert.deepEqual(result.findings, [])
  assert.deepEqual(f.resources(), before)
})

test('shared media selector uses actual accepted trims and excludes foreign, deleted or superseded neighbors', () => {
  const shot = (id: string, position: number, extra: Partial<Shot> = {}): Shot => ({ id, project_id: 'p', position, title: id,
    prompt: '', duration: 4, selected_asset_id: null, source_scene_id: 'scene', start_state: '', end_state: '', cut_note: '', ...extra })
  const previous = shot('previous', 0, { selected_asset_id: 'take' }), current = shot('current', 10), next = shot('next', 20)
  const asset = { id: 'take', project_id: 'p', shot_id: 'previous', kind: 'video', filename: 'take.mp4', created_at: 'now' } as Asset
  const clip: TimelineClip = { id: 'clip', project_id: 'p', shot_id: previous.id, asset_id: asset.id, in_ms: 100, out_ms: 3200, source_duration_ms: 4000 }
  const shots = [previous, current, next, shot('foreign', 9, { project_id: 'foreign' }), shot('alternative', 9, { design_id: 'other' }),
    shot('deleted', 9, { deleted_at: 'now' }), shot('superseded', 11, { superseded_by: 'new' })]
  assert.equal(adjacentStoryboardShots(shots, current).previous?.id, previous.id)
  assert.equal(adjacentStoryboardShots(shots, current).next?.id, next.id)
  const context = storyboardContinuityContext(shots, current, [asset], [clip])
  assert.equal(context.previous?.media.range_status, 'accepted_trim')
  assert.equal(context.previous?.media.tail_time_ms, 3150)
  assert.equal(storyboardSelectedMedia(previous, [{ ...asset, project_id: 'foreign' }], [clip]).asset, null)
  assert.equal(storyboardSelectedMedia(previous, [asset], [{ ...clip, out_ms: 4100 }]).range_status, 'unavailable')
  assert.equal(storyboardSelectedMedia(previous, [asset], [clip, { ...clip, id: 'duplicate' }]).range_status, 'ambiguous')
})
