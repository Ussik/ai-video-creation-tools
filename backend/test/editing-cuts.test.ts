import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import type { EditingCut, EditingCutInput } from '@video-studio/shared/media/editing-cut'

const directory = await mkdtemp(join(tmpdir(), 'studio-editing-cuts-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp, startWorker } = await import('../src/app.js')
const { all, db, initDb, now, one, run } = await import('../src/infrastructure/database/db.js')
const { probeVideoDurationMs, render } = await import('../src/infrastructure/media/render.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

function ffmpeg(...args: string[]): Buffer {
  const result = spawnSync(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 20 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr.toString())
  return result.stdout
}
async function call<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json<T>()
}
function input(cut: EditingCut): EditingCutInput {
  const { id: _id, project_id: _project, created_at: _created, updated_at: _updated, ...data } = cut
  return structuredClone(data)
}
const visual = (id: string, asset_id: string, duration = 1000) => ({ id, asset_id, title: id, in_ms: 0, out_ms: duration, source_audio_gain: 0, source_audio_fade_ms: 0 })
async function fixture() {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '独立剪辑', ratio: '16:9' })
  const id = project.id, base = `/api/projects/${id}/editing-cuts`
  const shot = await call<{ id: string }>('POST', `/api/projects/${id}/shots`, { title: '原镜头', duration: 2 })
  const paths = { red: join(directory, `${id}-red.png`), blue: join(directory, `${id}-blue.png`),
    audio: join(directory, `${id}-audio.wav`), video: join(directory, `${id}-video.mp4`) }
  await writeFile(paths.red, await sharp({ create: { width: 160, height: 90, channels: 3, background: '#e00000' } }).png().toBuffer())
  await writeFile(paths.blue, await sharp({ create: { width: 160, height: 90, channels: 3, background: '#0000e0' } }).png().toBuffer())
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', paths.audio)
  ffmpeg('-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', paths.video)
  for (const [key, path] of Object.entries(paths)) run(`INSERT INTO assets
    (id, project_id, shot_id, kind, filename, path, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'upload', ?)`,
    `${id}-${key}`, id, shot.id, key === 'audio' ? 'audio' : key === 'video' ? 'video' : 'image', key, path, now())
  await call('PUT', `/api/shots/${shot.id}/selection`, { asset_id: `${id}-red` })
  run('UPDATE projects SET music_asset_id=? WHERE id=?', `${id}-audio`, id)
  run('INSERT INTO project_audio_settings (project_id,music_gain,duck_music,duck_source) VALUES (?,0.7,0,0)', id)
  const cut = await call<EditingCut>('POST', base, { name: '预告一版' })
  return { id, base, cut, paths, shot: shot.id, red: `${id}-red`, blue: `${id}-blue`, audio: `${id}-audio`, video: `${id}-video` }
}

test('cuts save independent asset instances and mix settings without touching source shots or sibling cuts', async () => {
  const f = await fixture()
  assert.equal(f.cut.revision, 1)
  assert.deepEqual(f.cut.clips, [])
  assert.equal(f.cut.music_asset_id, null)
  const sibling = await call<EditingCut>('POST', f.base, { name: '第二版' })
  const original = {
    project: one('SELECT * FROM projects WHERE id=?', f.id), shots: all('SELECT * FROM shots WHERE project_id=?', f.id),
    clips: all('SELECT * FROM timeline_clips WHERE project_id=?', f.id), mix: all('SELECT * FROM project_audio_settings WHERE project_id=?', f.id),
    speech: all('SELECT * FROM speech_lines WHERE project_id=?', f.id), placements: all('SELECT * FROM speech_placements WHERE project_id=?', f.id),
  }
  const saved = await call<EditingCut>('PUT', `${f.base}/${f.cut.id}`, { ...input(f.cut), ratio: '9:16',
    clips: [visual('second', f.blue, 600), visual('first', f.red, 800), visual('repeat', f.blue, 400)],
    speech: [{ id: 'narration', asset_id: f.audio, label: '替换旁白', start_ms: 100, in_ms: 200, out_ms: 600, gain: 0.8 }],
    music_asset_id: f.audio, audio_settings: { music_gain: 0.1, duck_music: true, duck_source: true },
    captions: [{ id: 'caption', start_ms: 100, end_ms: 700, text: '傩王' }] })
  assert.equal(saved.revision, 2)
  initDb()
  assert.deepEqual(await call('GET', `${f.base}/${f.cut.id}`), saved)
  assert.deepEqual(await call('GET', `${f.base}/${sibling.id}`), sibling)
  assert.deepEqual({
    project: one('SELECT * FROM projects WHERE id=?', f.id), shots: all('SELECT * FROM shots WHERE project_id=?', f.id),
    clips: all('SELECT * FROM timeline_clips WHERE project_id=?', f.id), mix: all('SELECT * FROM project_audio_settings WHERE project_id=?', f.id),
    speech: all('SELECT * FROM speech_lines WHERE project_id=?', f.id), placements: all('SELECT * FROM speech_placements WHERE project_id=?', f.id),
  }, original)
  assert.equal((await call<{ cuts: EditingCut[] }>('GET', f.base)).cuts.length, 2)
})

test('revision compare-and-swap prevents stale and simultaneous overwrites', async () => {
  const f = await fixture(), url = `${f.base}/${f.cut.id}`
  const responses = await Promise.all(['窗口一', '窗口二'].map(name => app.inject({ method: 'PUT', url, payload: { ...input(f.cut), name } })))
  assert.deepEqual(responses.map(item => item.statusCode).sort(), [200, 409])
  const saved = await call<EditingCut>('GET', url)
  assert.equal(saved.revision, 2)
  const staleExport = await app.inject({ method: 'POST', url: `${url}/export`, payload: { revision: 1 } })
  assert.equal(staleExport.statusCode, 409)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.id).length, 0)
})

test('audio metadata uses decoded sample duration so the default imported MP3 trim saves successfully', async () => {
  const f = await fixture(), path = join(directory, `${f.id}-padded.mp3`), assetId = `${f.id}-mp3`
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.713', '-c:a', 'libmp3lame', path)
  run(`INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'audio','padded.mp3',?,'upload',?)`, assetId, f.id, path, now())
  const pcm = ffmpeg('-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1')
  const expected = Math.floor(pcm.length / 2 / 48000 * 1000)
  const metadata = await call<{ duration_ms: number }>('GET', `/api/assets/${assetId}/metadata`)
  assert.equal(metadata.duration_ms, expected)
  assert.equal((await call<{ duration_ms: number }>('GET', `/api/assets/${f.video}/metadata`)).duration_ms, 1000)
  assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${f.red}/metadata` })).statusCode, 400)
  const saved = await call<EditingCut>('PUT', `${f.base}/${f.cut.id}`, { ...input(f.cut), clips: [visual('picture', f.red)],
    speech: [{ id: 'mp3', asset_id: assetId, label: '上传MP3', start_ms: 0, in_ms: 0, out_ms: metadata.duration_ms, gain: 1 }] })
  assert.equal(saved.speech[0]?.out_ms, expected)
})

test('ownership, source types, actual media bounds and malformed clip IDs are rejected without saving', async () => {
  const f = await fixture(), other = await fixture(), url = `${f.base}/${f.cut.id}`
  for (const patch of [
    { clips: [visual('foreign', other.red)] },
    { clips: [visual('audio-as-picture', f.audio)] },
    { clips: [visual('too-long', f.video, 1100)] },
    { clips: [{ ...visual('image-in', f.red), in_ms: 100 }] },
    { clips: [visual('duplicate', f.red), visual('duplicate', f.blue)] },
    { speech: [{ id: 'invalid', asset_id: f.audio, label: '越界', start_ms: 0, in_ms: 0, out_ms: 1100, gain: 1 }] },
    { music_asset_id: f.red },
    { captions: [{ id: 'bad-time', start_ms: 500, end_ms: 100, text: '错误时间' }] },
  ]) {
    const response = await app.inject({ method: 'PUT', url, payload: { ...input(f.cut), ...patch } })
    assert.equal(response.statusCode, 422, response.body)
  }
  assert.deepEqual(await call('GET', url), f.cut)
  assert.equal((await app.inject({ method: 'GET', url: `${other.base}/${f.cut.id}` })).statusCode, 404)
})

test('drafts allow temporary timeline overflow but export requires complete valid ranges', async () => {
  const f = await fixture(), url = `${f.base}/${f.cut.id}`
  assert.equal((await app.inject({ method: 'POST', url: `${url}/export`, payload: { revision: 1 } })).statusCode, 422)
  let draft = await call<EditingCut>('PUT', url, { ...input(f.cut), clips: [visual('short', f.red, 400)],
    speech: [{ id: 'late', asset_id: f.audio, label: '晚入旁白', start_ms: 300, in_ms: 0, out_ms: 300, gain: 1 }] })
  const overflow = await app.inject({ method: 'POST', url: `${url}/export`, payload: { revision: draft.revision } })
  assert.equal(overflow.statusCode, 422)
  assert.match(overflow.body, /超出成片时长/)
  draft = await call<EditingCut>('PUT', url, { ...input(draft), speech: [], captions: [{ id: 'late-caption', start_ms: 100, end_ms: 500, text: '超出画面' }] })
  assert.equal((await app.inject({ method: 'POST', url: `${url}/export`, payload: { revision: draft.revision } })).statusCode, 422)
  draft = await call<EditingCut>('PUT', url, { ...input(draft), ratio: '9:16', captions: [{ id: 'long-caption', start_ms: 0, end_ms: 400, text: '很长的旁白'.repeat(20) }] })
  const longCaption = await app.inject({ method: 'POST', url: `${url}/export`, payload: { revision: draft.revision } })
  assert.equal(longCaption.statusCode, 422)
  assert.match(longCaption.body, /最多4行/)
})

test('queued exports freeze the saved sequence, audio and plain-text captions and render their timing', { timeout: 120000 }, async () => {
  const f = await fixture(), url = `${f.base}/${f.cut.id}`
  const saved = await call<EditingCut>('PUT', url, { ...input(f.cut), name: '已保存预告',
    clips: [visual('red-first', f.red, 400), visual('blue-middle', f.blue, 400), visual('red-repeat', f.red, 400)],
    speech: [{ id: 'voice', asset_id: f.audio, label: '傩王旁白', start_ms: 200, in_ms: 0, out_ms: 400, gain: 1 }],
    captions: [{ id: 'safe-caption', start_ms: 400, end_ms: 800, text: "傩王 %{n}: [] ' \\{\\b1}文字" }] })
  const job = await call<{ id: string; request: string }>('POST', `${url}/export`, { revision: saved.revision })
  const snapshot = JSON.parse(job.request)
  assert.equal(snapshot.editing_cut_id, saved.id)
  assert.equal(snapshot.editing_cut_revision, saved.revision)
  assert.equal(snapshot.editing_cut_name, '已保存预告')
  assert.deepEqual(snapshot.captions, saved.captions)
  await call('PUT', url, { ...input(saved), name: '继续修改的新稿', clips: [visual('changed', f.blue, 1000)], speech: [], captions: [] })
  assert.equal(one<{ request: string }>('SELECT request FROM jobs WHERE id=?', job.id)?.request, job.request)
  const stop = startWorker()
  try {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const current = one<{ status: string; error: string | null }>('SELECT status,error FROM jobs WHERE id=?', job.id)!
      if (current.status === 'succeeded' || current.status === 'failed') {
        assert.equal(current.status, 'succeeded', current.error ?? '')
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally { await stop() }
  const completed = one<{ status: string; result_asset_id: string }>('SELECT status,result_asset_id FROM jobs WHERE id=?', job.id)!
  assert.equal(completed.status, 'succeeded')
  assert.ok(one('SELECT 1 FROM saved_assets WHERE asset_id=?', completed.result_asset_id))
  const output = one<{ path: string }>('SELECT path FROM assets WHERE id=?', completed.result_asset_id)!.path
  assert.ok(Math.abs(probeVideoDurationMs(output) - 1200) < 100)
  for (const [seconds, color] of [[0.2, 'red'], [0.6, 'blue'], [1, 'red']] as const) {
    const frame = ffmpeg('-ss', String(seconds), '-i', output, '-frames:v', '1', '-vf', 'crop=2:2:640:200,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1')
    assert.ok(color === 'red' ? frame[0]! > frame[2]! + 100 : frame[2]! > frame[0]! + 100, `${seconds}s 应为 ${color}`)
  }
  function whitePixels(seconds: number) {
    const frame = ffmpeg('-ss', String(seconds), '-i', output, '-frames:v', '1', '-vf', 'crop=1280:240:0:480', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1')
    let count = 0
    for (let index = 0; index < frame.length; index += 3) if (frame[index]! > 200 && frame[index + 1]! > 200 && frame[index + 2]! > 200) count++
    return count
  }
  assert.equal(whitePixels(0.2), 0)
  assert.ok(whitePixels(0.6) > 100, '字幕时间内应有真实烧录的白字')
  assert.equal(whitePixels(1), 0)
  const levels = [0.05, 0.3, 0.9].map(seconds => {
    const samples = ffmpeg('-ss', String(seconds), '-i', output, '-t', '0.08', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1')
    let energy = 0
    for (let index = 0; index < samples.length; index += 4) energy += samples.readFloatLE(index) ** 2
    return Math.sqrt(energy / (samples.length / 4))
  })
  assert.ok(levels[1]! > 0.01)
  assert.ok(levels[0]! < levels[1]! * 0.05 && levels[2]! < levels[1]! * 0.05, '旁白只在保存的绝对时间区间播放')
  await assert.rejects(() => render({ id: f.id, ratio: '16:9' }, snapshot.clips,
    { [f.red]: { kind: 'image', path: f.paths.red }, [f.blue]: { kind: 'image', path: f.paths.blue } }, [], undefined,
    [{ id: 'invalid', start_ms: 0, end_ms: 1300, text: '越界' }]), /字幕/)
})

test('mix bus limits amplified overlapping tracks without changing the export duration', { timeout: 120000 }, async () => {
  const image = join(directory, 'limiter.png'), audio = join(directory, 'limiter.wav')
  await writeFile(image, await sharp({ create: { width: 160, height: 90, channels: 3, background: '#001020' } }).png().toBuffer())
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-af', 'volume=7', '-c:a', 'pcm_s16le', audio)
  const speech = { id: 'loud', project_id: 'limiter', line_id: 'loud', shot_id: null, asset_id: 'voice', offset_ms: 0,
    in_ms: 0, out_ms: 500, gain: 2, text: '', voice_name: '', stale: false, start_ms: 0, end_ms: 500 }
  const output = await render({ id: 'editing-cut-limiter', ratio: '16:9', music_asset_id: 'voice' },
    [{ ...visual('picture', 'picture', 500), source_duration_ms: null }],
    { picture: { kind: 'image', path: image }, voice: { kind: 'audio', path: audio } },
    [speech, { ...speech, id: 'overlap' }], { music_gain: 1, duck_music: false, duck_source: false })
  const samples = ffmpeg('-i', output, '-vn', '-ar', '48000', '-f', 'f32le', 'pipe:1')
  let peak = 0
  for (let index = 0; index < samples.length; index += 4) peak = Math.max(peak, Math.abs(samples.readFloatLE(index)))
  assert.ok(peak > 0.7 && peak < 0.99, `amplified mix should stay below digital clipping: ${peak}`)
  assert.ok(Math.abs(probeVideoDurationMs(output) - 500) < 100)
})

test('fractional short clips keep cumulative boundaries within one output frame', { timeout: 120000 }, async () => {
  const image = join(directory, 'fractional.png')
  await writeFile(image, await sharp({ create: { width: 160, height: 90, channels: 3, background: '#306080' } }).png().toBuffer())
  const durations = [200, 230, 370, 200, 230, 370, 200, 230, 370, 200, 230, 370]
  const total = durations.reduce((sum, duration) => sum + duration, 0)
  const output = await render({ id: 'fractional-cut', ratio: '16:9' }, durations.map((duration, index) =>
    ({ ...visual(`fraction-${index}`, 'picture', duration), source_duration_ms: null })),
  { picture: { kind: 'image', path: image } })
  assert.ok(Math.abs(probeVideoDurationMs(output) - total) <= 42,
    `export drift should stay below one 24fps frame: ${probeVideoDurationMs(output)}ms vs ${total}ms`)
})

test('mono 24kHz source audio cannot downmix stereo music or lower the 48kHz export sample rate', { timeout: 120000 }, async () => {
  const video = join(directory, 'mono-source.mp4'), music = join(directory, 'stereo-music.wav')
  ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.5:sample_rate=24000',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '24000', '-ac', '1', video)
  ffmpeg('-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*880*t):s=48000:d=0.5', '-c:a', 'pcm_s16le', music)
  const output = await render({ id: 'stereo-cut', ratio: '16:9', music_asset_id: 'music' },
    [{ ...visual('mono-source', 'video', 500), source_duration_ms: 500 }],
    { video: { kind: 'video', path: video }, music: { kind: 'audio', path: music } }, [],
    { music_gain: 1, duck_music: false, duck_source: false })
  const metadata = spawnSync(ffmpegPath!, ['-hide_banner', '-i', output], { encoding: 'utf8' }).stderr
  assert.match(metadata, /Audio: aac[^\n]*48000 Hz, stereo/)
  const samples = ffmpeg('-ss', '0.1', '-i', output, '-t', '0.2', '-vn', '-f', 'f32le', 'pipe:1')
  let leftEnergy = 0, rightEnergy = 0, cross = 0
  for (let index = 0; index < samples.length; index += 8) {
    const left = samples.readFloatLE(index), right = samples.readFloatLE(index + 4)
    leftEnergy += left * left; rightEnergy += right * right; cross += left * right
  }
  assert.ok(leftEnergy > 1 && rightEnergy > 1, 'both music channels should remain audible')
  assert.ok(Math.abs(cross / Math.sqrt(leftEnergy * rightEnergy)) < 0.15, 'independent music channels must not collapse to duplicated mono')
})
