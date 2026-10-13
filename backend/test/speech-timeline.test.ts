import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import { resolveSpeechTimeline, sliceSpeechAudio, speechDuckingLevel, speechIntervals, type SpeechData } from '@video-studio/shared/media/speech-timeline'

const directory = await mkdtemp(join(tmpdir(), 'speech-timeline-test-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { render } = await import('../src/infrastructure/media/render.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const voiceFile = join(directory, 'voice.wav'), musicFile = join(directory, 'music.wav'), stillFile = join(directory, 'still.png')
function ffmpeg(...args: string[]) {
  const result = spawnSync(ffmpegPath!, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
}
ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.8', '-c:a', 'pcm_s16le', voiceFile)
ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-c:a', 'pcm_s16le', musicFile)
await writeFile(stillFile, await sharp({ create: { width: 80, height: 45, channels: 3, background: '#37352f' } }).png().toBuffer())
async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function reject(method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown, pattern: RegExp) {
  const response = await app.inject({ method, url, payload })
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body)
  assert.match(response.body, pattern)
}
async function setup() {
  const project = await call('POST', '/api/projects', { name: '配音入片测试' })
  const path = `/api/projects/${project.id}/speech`
  const voice = await call('POST', `${path}/voices`, { name: '旁白', speaker: 'zh_female_vv_uranus_bigtts' })
  const line = await call('POST', `${path}/lines`, { text: '车门缓缓关闭。', voice_id: voice.id })
  const first = await call('POST', `/api/projects/${project.id}/shots`, { title: '站台', duration: 2 })
  const second = await call('POST', `/api/projects/${project.id}/shots`, { title: '列车', duration: 1 })
  for (const shot of [first, second]) {
    const assetId = newId()
    run("INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at) VALUES (?,?,?,'image','still.png',?,'upload',?)", assetId, project.id, shot.id, stillFile, now())
    await call('PUT', `/api/shots/${shot.id}/selection`, { asset_id: assetId })
  }
  const assetId = fixtureTake(project.id, line, voice)
  await call('POST', `${path}/lines/${line.id}/select`, { asset_id: assetId })
  return { project, path, voice, line, first, second, assetId }
}
function fixtureTake(projectId: string, line: { id: string; text: string }, voice: { speaker: string }) {
  const assetId = newId()
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'audio','voice.wav',?,'generated',?)", assetId, projectId, voiceFile, now())
  run('INSERT INTO speech_takes (id,line_id,project_id,asset_id,settings,text,duration_ms,created_at) VALUES (?,?,?,?,?,?,1800,?)',
    newId(), line.id, projectId, assetId, JSON.stringify({ speaker: voice.speaker, instructions: '', context_text: '', speech_rate: 0 }), line.text, now())
  return assetId
}
function amplitude(file: string, start: number, frequency: number) {
  const result = spawnSync(ffmpegPath!, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', file, '-t', '0.2', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { timeout: 30000, maxBuffer: 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr.toString())
  let real = 0, imaginary = 0
  const count = result.stdout.length / 4
  for (let index = 0; index < count; index++) {
    const sample = result.stdout.readFloatLE(index * 4), angle = 2 * Math.PI * frequency * index / 48000
    real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
  }
  return Math.hypot(real, imaginary) * 2 / count
}

test('speech is anchored to edited shot time, spans cuts, and export snapshots its exact placement', async () => {
  const f = await setup()
  await reject('POST', `/api/projects/${f.project.id}/export`, {}, /未入片/)
  await call('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.first.id, offset_ms: 500 })
  const detail = await call('GET', `/api/projects/${f.project.id}`)
  const resolved = resolveSpeechTimeline(detail.shots, detail.timeline_clips, detail.speech.placements)
  assert.equal(resolved.issues.length, 0)
  assert.deepEqual([resolved.audio[0]!.start_ms, resolved.audio[0]!.end_ms], [500, 2300])
  const cropped = sliceSpeechAudio(resolved.audio, 2000, 3000)[0]!
  assert.deepEqual([cropped.start_ms, cropped.end_ms, cropped.in_ms, cropped.out_ms], [0, 300, 1500, 1800])
  assert.equal(speechDuckingLevel(speechIntervals(resolved.audio), 600), 0.25)
  assert.equal(speechDuckingLevel(speechIntervals(resolved.audio), 2300), 1)
  const exported = JSON.parse((await call('POST', `/api/projects/${f.project.id}/export`, {})).request)
  assert.deepEqual([exported.speech_audio[0].start_ms, exported.speech_audio[0].end_ms], [500, 2300])
  await call('PATCH', `${f.path}/lines/${f.line.id}`, { text: '新的旁白。' })
  const state: SpeechData = await call('GET', f.path)
  assert.equal(state.lines[0]!.selected_is_stale, true)
  assert.equal(state.placements![0]!.stale, true)
  assert.equal(state.lines[0]!.takes.length, 1)
  await reject('POST', `/api/projects/${f.project.id}/export`, {}, /不一致/)
  assert.equal(exported.speech_audio[0].text, '车门缓缓关闭。', 'queued export retains the version the user reviewed')
})

test('placement rejects foreign shots, invalid trims, overrun and changed voices without losing history', async () => {
  const f = await setup(), other = await setup()
  await reject('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: other.first.id }, /不属于当前项目/)
  await reject('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.first.id, out_ms: 3000 }, /超出音频时长/)
  await call('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.second.id, offset_ms: 0 })
  await reject('POST', `/api/projects/${f.project.id}/export`, {}, /超出本次成片范围/)
  await call('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.first.id, offset_ms: 500 })
  await call('PATCH', `${f.path}/voices/${f.voice.id}`, { speech_rate: -10 })
  await reject('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.first.id }, /与当前台词和声音设置一致/)
  await reject('POST', `/api/projects/${f.project.id}/export`, {}, /不一致/)
  await call('DELETE', `${f.path}/lines/${f.line.id}/placement`)
  assert.equal((await call('GET', f.path)).lines[0].takes.length, 1)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('FFmpeg export plays speech across a cut at the specified time and ducks looping music', async () => {
  const f = await setup()
  const musicId = newId()
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'audio','music.wav',?,'upload',?)", musicId, f.project.id, musicFile, now())
  await call('PATCH', `/api/projects/${f.project.id}`, { music_asset_id: musicId })
  await call('PUT', `/api/projects/${f.project.id}/audio-settings`, { music_gain: 0.6, duck_music: true, duck_source: true })
  await call('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.first.id, offset_ms: 500 })
  const job = JSON.parse((await call('POST', `/api/projects/${f.project.id}/export`, {})).request)
  const paths = Object.fromEntries(db.prepare('SELECT * FROM assets WHERE project_id=?').all(f.project.id).map((asset: any) => [asset.id, asset]))
  const output = await render(job.project, job.clips, paths, job.speech_audio, job.audio_settings)
  assert.ok(amplitude(output, 0.1, 440) < 0.003, 'speech has not started')
  assert.ok(amplitude(output, 0.8, 440) > 0.04, 'speech is audible at the chosen start')
  assert.ok(amplitude(output, 2.05, 440) > 0.04, 'speech continues across the cut')
  assert.ok(amplitude(output, 2.6, 440) < 0.003, 'speech ends without truncation or repetition')
  const before = amplitude(output, 0.1, 880), during = amplitude(output, 1.2, 880), after = amplitude(output, 2.6, 880)
  assert.ok(during / before > 0.15 && during / before < 0.35, `music ducking ratio ${during / before}`)
  assert.ok(Math.abs(after / before - 1) < 0.15, 'music resumes and loops after speech')
})

test('sync updates only script-owned text, preserves takes and manual changes, and rejects expired previews', async () => {
  const project = await call('POST', '/api/projects', { name: '剧本同步测试' }), path = `/api/projects/${project.id}/speech`
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站', dialogue: '林晚：第一句。\n陈默：第二句。' })
  await call('POST', `${path}/import`, { scene_ids: [scene.id] })
  const original: SpeechData = await call('GET', path)
  const first = original.lines[0]!, second = original.lines[1]!
  const audioId = fixtureTake(project.id, first, original.voices.find(voice => voice.id === first.voice_id)!)
  await call('POST', `${path}/lines/${first.id}/select`, { asset_id: audioId })
  await call('PATCH', `${path}/lines/${second.id}`, { text: '我手动调整的台词。' })
  await call('PATCH', `/api/script-scenes/${scene.id}`, { dialogue: '林晚：新版第一句。\n陈默：新版第二句。' })
  const preview = await call('POST', `${path}/import/preview`, { scene_ids: [scene.id] })
  assert.deepEqual([preview.added, preview.updated, preview.removed, preview.preserved], [0, 1, 0, 1])
  await call('POST', `${path}/import`, { scene_ids: [scene.id], mode: 'sync', sync_token: preview.sync_token })
  const next: SpeechData = await call('GET', path)
  assert.equal(next.lines.find(line => line.id === first.id)!.text, '新版第一句。')
  assert.equal(next.lines.find(line => line.id === first.id)!.takes.length, 1)
  assert.equal(next.lines.find(line => line.id === first.id)!.selected_is_stale, true)
  assert.equal(next.lines.find(line => line.id === second.id)!.text, '我手动调整的台词。')
  await reject('POST', `${path}/import`, { scene_ids: [scene.id], mode: 'sync', sync_token: preview.sync_token }, /已变化/)
  await call('PATCH', `/api/script-scenes/${scene.id}`, { dialogue: '林晚：新版第一句。' })
  const removal = await call('POST', `${path}/import/preview`, { scene_ids: [scene.id] })
  await call('POST', `${path}/import`, { scene_ids: [scene.id], mode: 'sync', sync_token: removal.sync_token })
  assert.equal((await call('GET', path)).lines.find((line: any) => line.id === second.id).source_status, 'removed')
  assert.equal(one('SELECT 1 FROM assets WHERE id=?', audioId) !== undefined, true)
})

test('batch generation skips current candidates and active jobs; selection never chooses stale candidates', async () => {
  const f = await setup()
  await call('PUT', '/api/speech/config', { api_key: 'fixture-no-network-key' })
  const missing = await call('POST', `${f.path}/lines`, { voice_id: f.voice.id, text: '新台词。' })
  const stale = fixtureTake(f.project.id, { ...missing, text: '旧台词。' }, f.voice)
  const result = await call('POST', `${f.path}/batch/generate`, { line_ids: [f.line.id, missing.id] })
  assert.deepEqual(result.results.map((item: any) => item.status), ['skipped', 'generated'])
  const duplicate = await call('POST', `${f.path}/batch/generate`, { line_ids: [missing.id] })
  assert.equal(duplicate.results[0].status, 'skipped')
  const selected = await call('POST', `${f.path}/batch/select`, { line_ids: [missing.id] })
  assert.equal(selected.results[0].status, 'skipped')
  assert.equal((await call('GET', f.path)).lines.find((line: any) => line.id === missing.id).selected_asset_id, null)
  assert.ok(stale)
})

test('insertion and reordering preserve the correct dialogue identities and re-import remains idempotent after sync', async () => {
  const project = await call('POST', '/api/projects', { name: '对白顺序测试' }), path = `/api/projects/${project.id}/speech`
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '站台', dialogue: '林晚：先看我。\n陈默：然后看你。' })
  await call('POST', `${path}/import`, { scene_ids: [scene.id] })
  const before: SpeechData = await call('GET', path)
  await call('PATCH', `/api/script-scenes/${scene.id}`, { dialogue: '陈默：然后看你。\n旁白：灯亮了。\n林晚：新的第一句。' })
  const preview = await call('POST', `${path}/import/preview`, { scene_ids: [scene.id] })
  assert.deepEqual([preview.added, preview.updated, preview.removed], [1, 1, 0])
  await call('POST', `${path}/import`, { scene_ids: [scene.id], mode: 'sync', sync_token: preview.sync_token })
  const after: SpeechData = await call('GET', path)
  assert.equal(after.lines.find(line => line.id === before.lines[0]!.id)!.text, '新的第一句。')
  assert.equal(after.lines.find(line => line.id === before.lines[1]!.id)!.text, '然后看你。')
  assert.equal(after.lines.find(line => line.id === before.lines[0]!.id)!.voice_id, before.lines[0]!.voice_id)
  assert.equal(after.lines.find(line => line.id === before.lines[1]!.id)!.voice_id, before.lines[1]!.voice_id)
  const imported = await call('POST', `${path}/import`, { scene_ids: [scene.id] })
  assert.deepEqual(imported, { added: 0, skipped: 3 })
  assert.equal((await call('GET', path)).lines.length, 3)
})

test('new candidate selection requires explicit placement update; deleted anchors preserve recoverable audio', async () => {
  const f = await setup()
  run('UPDATE speech_takes SET duration_ms=NULL WHERE line_id=?', f.line.id)
  await call('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.first.id, offset_ms: 300 })
  assert.equal((await call('GET', f.path)).lines[0].takes[0].duration_ms, 1800, 'legacy take duration is measured when placed')
  const freshAsset = fixtureTake(f.project.id, f.line, f.voice)
  await call('POST', `${f.path}/lines/${f.line.id}/select`, { asset_id: freshAsset })
  const state: SpeechData = await call('GET', f.path)
  assert.equal(state.placements![0]!.asset_id, f.assetId, 'selection cannot silently swap an export placement')
  assert.equal(state.placements![0]!.stale, true)
  await call('PUT', `${f.path}/lines/${f.line.id}/placement`, { shot_id: f.first.id })
  await call('DELETE', `/api/shots/${f.first.id}`)
  const orphan: SpeechData = await call('GET', f.path)
  assert.equal(orphan.placements![0]!.shot_id, null)
  assert.equal(orphan.lines[0]!.takes.length, 2)
  await reject('POST', `/api/projects/${f.project.id}/export`, {}, /镜头已不存在/)
})

test('muted speech does not lower other tracks, and edited durations drive shot anchors', () => {
  const placement = { id: 'p', project_id: 'project', line_id: 'line', shot_id: 'second', asset_id: 'audio', offset_ms: -200,
    in_ms: 0, out_ms: 800, gain: 0, text: '静音对白', voice_name: '旁白', stale: false }
  const result = resolveSpeechTimeline([{ id: 'first', position: 0, duration: 5 }, { id: 'second', position: 1, duration: 2 }],
    [{ shot_id: 'first', in_ms: 2500, out_ms: 3500 }, { shot_id: 'second', in_ms: 0, out_ms: 2000 }], [placement])
  assert.equal(result.audio[0]!.start_ms, 800)
  assert.equal(result.audio[0]!.end_ms, 1600)
  assert.deepEqual(speechIntervals(result.audio), [])
  assert.equal(speechDuckingLevel(speechIntervals(result.audio), 1000), 1)
  const part = sliceSpeechAudio(result.audio, 1000, 1700)[0]!
  assert.equal(part.fade_in_ms, 0, 'cutting through speech does not add a new fade')
})

test('output settings validate the whole request before saving any field', async () => {
  const f = await setup(), other = await setup()
  await reject('PUT', `/api/projects/${f.project.id}/audio-settings`, { ratio: '9:16', music_asset_id: other.assetId, music_gain: 0.8, duck_music: false, duck_source: false }, /不属于当前项目/)
  const unchanged = await call('GET', `/api/projects/${f.project.id}`)
  assert.equal(unchanged.ratio, '16:9')
  assert.equal(unchanged.audio_settings.music_gain, 0.24)
  await call('PUT', `/api/projects/${f.project.id}/audio-settings`, { ratio: '9:16', music_asset_id: null, music_gain: 0.8, duck_music: false, duck_source: false })
  const changed = await call('GET', `/api/projects/${f.project.id}`)
  assert.equal(changed.ratio, '9:16')
  assert.equal(changed.audio_settings.music_gain, 0.8)
})
