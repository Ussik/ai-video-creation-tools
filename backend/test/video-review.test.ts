import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import Fastify from 'fastify'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const directory = await mkdtemp(join(tmpdir(), 'video-review-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, run, all, mediaDir } = await import('../src/infrastructure/database/db.js')
const { registerVideoReviewRoutes } = await import('../src/modules/assets/video-review.js')
const { reviewContactSheets, reviewNativeVideo, reviewVideoDuration, reviewFrame } = await import('../src/modules/assets/video-review-media.js')
initDb()
run("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','测试','now','now'),('other','其他项目','now','now')")
run("INSERT INTO shots (id,project_id,position,title,prompt,duration,start_state,end_state,video_prompt,created_at) VALUES ('shot','project',0,'跑入','跑向桌边',2,'远处','站稳','背景完全静止，拍肩拍空','now'),('other-shot','project',1,'反应','反应',2,'带笑','迟疑','保持原意','now')")
run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES ('provider','测试','http','https://example.invalid','now')")
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('reader','provider','复核模型','reader','text','chat_completions',?,1)", JSON.stringify({ supports_vision: true }))
const videoPath = join(mediaDir, 'clip.mp4')
const made = spawnSync(ffmpegPath as unknown as string, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { timeout: 20_000 })
assert.equal(made.status, 0, made.stderr?.toString())
const addAsset = (id: string, path: string, project = 'project', kind = 'video') => run("INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,prompt,created_at) VALUES (?,?,NULL,?,?,?,'upload','不得更改背景静止与拍空剧情','now')", id, project, kind, 'not-evidence.mp4', path)
addAsset('video', videoPath); run("UPDATE assets SET shot_id='shot' WHERE id='video'")
addAsset('foreign', videoPath, 'other'); addAsset('image', videoPath, 'project', 'image')
const outside = join(directory, 'outside.mp4'); await writeFile(outside, 'not video'); addAsset('outside', outside)
const linked = join(mediaDir, 'linked.mp4'); await symlink(outside, linked); addAsset('linked', linked)
addAsset('missing', join(mediaDir, 'missing.mp4'))
const jpeg = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#334455' } }).jpeg().toBuffer()
const image = { data_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'high' as const }
let result = () => ({ verdict: 'usable', summary: '可见主角状态发生变化，连续运动待播放确认。',
  checks: ['action', 'continuity', 'composition', 'style', 'dialogue_audio'].map(category => ({ category, status: 'pass', detail: '画面可见。' })),
  findings: [{ category: 'action', severity: 'warning', start_ms: 250, end_ms: 1500, observation: '人物位移不足。', expected: '跑近并站稳。', suggestion: '明确落脚和结束状态。', evidence_times_ms: [500, 1000] }],
  usable_ranges: [{ start_ms: 250, end_ms: 1750, reason: '建议候选片段，需播放确认。' }], limitations: [] })
let captured: import('../src/infrastructure/providers/providers.js').TextStreamRequest | undefined, calls = 0, mode: 'normal' | 'abort' | 'stale' | 'bad-time' = 'normal', raw: IncomingMessage
const app = Fastify()
app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
app.addHook('preHandler', async request => { raw = request.raw })
registerVideoReviewRoutes(app, { probe: async () => 2000, prepareFrames: async () => ({ images: [image], sample_times_ms: [0, 500, 1000, 1500] }),
  generate: async (_model, _provider, request, signal) => {
    calls++; captured = request
    if (mode === 'abort') { raw.emit('aborted'); signal.throwIfAborted() }
    if (mode === 'stale') run("UPDATE shots SET end_state='改变了终态' WHERE id='shot'")
    const output = result()
    if (mode === 'bad-time') output.findings[0]!.end_ms = 5000
    return JSON.stringify(output)
  } })
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const base = '/api/projects/project/assets/video/video-reviews'
const post = (payload: unknown = { model_id: 'reader' }, url = base) => app.inject({ method: 'POST', url, payload })
const count = () => all('SELECT id FROM video_reviews').length

test('review sends actual media, retains intended stillness/miss and stores an independent report with bounded evidence', async () => {
  const before = { assets: all('SELECT * FROM assets'), reviews: all('SELECT * FROM asset_reviews'), clips: all('SELECT * FROM timeline_clips') }
  const response = await post()
  assert.equal(response.statusCode, 200, response.body)
  const report = response.json()
  assert.equal(report.input_mode, 'sampled_frames'); assert.equal(report.stale, false)
  assert.equal(report.target_duration_ms, 2000); assert.equal(report.verdict, 'uncertain')
  assert.equal(report.checks.find((check: any) => check.category === 'dialogue_audio').status, 'uncertain')
  assert.equal(report.evidence_frames.length, 2); assert.match(report.evidence_frames[0].url, /time_ms=500/)
  assert.match(captured!.prompt, /背景完全静止/); assert.match(captured!.prompt, /拍空/)
  assert.match(captured!.prompt, /离散画面/); assert.equal(captured!.images![0]!.data_url, image.data_url)
  assert.deepEqual({ assets: all('SELECT * FROM assets'), reviews: all('SELECT * FROM asset_reviews'), clips: all('SELECT * FROM timeline_clips') }, before)
  const history = (await app.inject({ method: 'GET', url: base })).json().reviews
  assert.equal(history[0].id, report.id); assert.equal(history[0].stale, false)
  run("UPDATE shots SET duration=3 WHERE id='shot'")
  assert.equal((await app.inject({ method: 'GET', url: base })).json().reviews[0].stale, true)
  run("UPDATE shots SET duration=2 WHERE id='shot'")
})
test('explicit native video capability submits actual local MP4 bytes without pretending audio was verified', async () => {
  run("UPDATE models SET settings=? WHERE id='reader'", JSON.stringify({ supports_video: true }))
  const response = await post(); assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().input_mode, 'native_video')
  assert.match(captured!.video!.data_url, /^data:video\/mp4;base64,/)
  assert.equal(captured!.images, undefined); assert.equal(captured!.video!.duration_ms, 2000)
  assert.match(response.json().limitations.join(' '), /声音/)
  run("UPDATE models SET settings=? WHERE id='reader'", JSON.stringify({ supports_vision: true }))
})
test('explicit Doubao Responses capability stays native even when image understanding is also configured', async () => {
  run("UPDATE models SET protocol='responses',settings=? WHERE id='reader'", JSON.stringify({ supports_video: true, video_input_format: 'doubao_ark', supports_vision: true }))
  try {
    const response = await post(); assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().input_mode, 'native_video')
    assert.match(captured!.video!.data_url, /^data:video\/mp4;base64,/)
    assert.equal(captured!.images, undefined)
    assert.equal(captured!.video!.duration_ms, 2000)
    assert.match(response.json().limitations.join(' '), /声音/)
  } finally { run("UPDATE models SET protocol='chat_completions',settings=? WHERE id='reader'", JSON.stringify({ supports_vision: true })) }
})
test('foreign, wrong-kind, missing, escaping and incompatible sources fail before provider calls', async () => {
  const before = calls
  for (const id of ['foreign', 'image', 'outside', 'linked', 'missing', 'absent']) {
    assert.ok([404, 422].includes((await post({ model_id: 'reader' }, `/api/projects/project/assets/${id}/video-reviews`)).statusCode))
  }
  assert.equal((await post({ model_id: 'reader', shot_id: 'other-shot' })).statusCode, 422)
  run("UPDATE models SET settings='{}' WHERE id='reader'")
  assert.equal((await post()).statusCode, 422)
  run("UPDATE models SET settings=? WHERE id='reader'", JSON.stringify({ supports_vision: true }))
  assert.equal(calls, before)
})
test('cancelled, stale and out-of-range model output never save an apparently valid review', async () => {
  const before = count()
  mode = 'abort'; assert.equal((await post()).statusCode, 499)
  mode = 'stale'; assert.equal((await post()).statusCode, 409)
  run("UPDATE shots SET end_state='站稳' WHERE id='shot'")
  mode = 'bad-time'; assert.equal((await post()).statusCode, 422)
  mode = 'normal'; assert.equal(count(), before)
})
test('real FFmpeg extraction produces chronological labeled sheets and playable evidence frame', async () => {
  const signal = new AbortController().signal
  const duration = await reviewVideoDuration(videoPath, signal)
  assert.ok(duration >= 1900 && duration <= 2100)
  const sheets = await reviewContactSheets(videoPath, duration, signal)
  assert.ok(sheets.sample_times_ms.length >= 8); assert.equal(sheets.sample_times_ms[0], 0)
  assert.ok(sheets.sample_times_ms.every((time, index) => time < duration && (index === 0 || time > sheets.sample_times_ms[index - 1]!)))
  const info = await sharp(Buffer.from(sheets.images[0]!.data_url.split(',')[1]!, 'base64')).metadata()
  assert.equal(info.width, 1152)
  assert.ok((await reviewFrame(videoPath, 500, signal)).length > 0)
  assert.match((await reviewNativeVideo(videoPath, duration, signal)).data_url, /^data:video\/mp4;base64,/)
  const frame = await app.inject({ method: 'GET', url: '/api/projects/project/assets/video/video-review-frame?time_ms=500' })
  assert.equal(frame.statusCode, 200); assert.match(frame.headers['content-type']!, /image\/jpeg/)
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/project/assets/video/video-review-frame?time_ms=2500' })).statusCode, 422)
})
