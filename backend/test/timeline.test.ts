import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-timeline-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, initDb, now, one, run } = await import('../src/db.js')
const { probeVideoDurationMs, render } = await import('../src/render.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

interface Clip {
  id: string; project_id: string; shot_id: string; asset_id: string;
  in_ms: number; out_ms: number; source_duration_ms: number | null;
  source_audio_gain: number; source_audio_fade_ms: number
}

function ffmpeg(...args: string[]): void {
  const result = spawnSync(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

function audioRms(path: string, startSeconds: number, durationSeconds: number): number {
  const result = spawnSync(ffmpegPath!, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(startSeconds), '-i', path,
    '-t', String(durationSeconds), '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1',
  ], { maxBuffer: 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr.toString())
  const samples = result.stdout
  assert.ok(samples.length > 0)
  let sum = 0
  for (let offset = 0; offset < samples.length; offset += 4) {
    const sample = samples.readFloatLE(offset)
    sum += sample * sample
  }
  return Math.sqrt(sum / (samples.length / 4))
}

test('legacy selection migrates once, trims validate exact media bounds, and missing shots block export', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '接镜测试' })
  const first = await call<{ id: string; start_state: string }>('POST', `/api/projects/${project.id}/shots`, {
    title: '拔剑', duration: 3, start_state: '剑在鞘中', end_state: '剑尖向右', cut_note: '在挥剑中切镜',
  })
  assert.equal(first.start_state, '剑在鞘中')
  const second = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '格挡', duration: 2 })
  const imagePath = join(testData, 'legacy.png')
  await writeFile(imagePath, await sharp({ create: { width: 16, height: 9, channels: 3, background: '#e02020' } }).png().toBuffer())
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, ?, 'image', 'legacy.png', ?, 'upload', NULL, NULL, NULL, ?)`,
  'legacy-image', project.id, first.id, imagePath, now())
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', 'legacy-image', first.id)
  initDb()
  initDb()
  const detail = await call<{ timeline_clips: Clip[]; shots: Array<{ id: string; selected_asset_id: string | null; end_state: string; cut_note: string }> }>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.timeline_clips.length, 1)
  assert.deepEqual([detail.timeline_clips[0]?.in_ms, detail.timeline_clips[0]?.out_ms], [0, 3000])
  assert.deepEqual([detail.timeline_clips[0]?.source_audio_gain, detail.timeline_clips[0]?.source_audio_fade_ms], [1, 0])
  assert.equal(detail.shots[0]?.selected_asset_id, 'legacy-image')
  assert.equal(detail.shots[0]?.end_state, '剑尖向右')
  assert.equal(detail.shots[0]?.cut_note, '在挥剑中切镜')

  const missing = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export` })
  assert.equal(missing.statusCode, 422)
  assert.match(missing.body, /未选定素材/)

  const videoPath = join(testData, 'two-colors.mp4')
  ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=24:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath)
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, ?, 'video', 'two-colors.mp4', ?, 'upload', NULL, NULL, NULL, ?)`,
  'two-colors', project.id, second.id, videoPath, now())
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', 'two-colors', second.id)
  initDb()
  const migratedVideo = (await call<{ timeline_clips: Clip[] }>('GET', `/api/projects/${project.id}`))
    .timeline_clips.find(item => item.shot_id === second.id)!
  assert.equal(migratedVideo.source_duration_ms, probeVideoDurationMs(videoPath))
  const selected = await call<{ selected_asset_id: string }>('PUT', `/api/shots/${second.id}/selection`, { asset_id: 'two-colors' })
  assert.equal(selected.selected_asset_id, 'two-colors')
  const current = await call<{ timeline_clips: Clip[] }>('GET', `/api/projects/${project.id}`)
  const clip = current.timeline_clips[1]!
  assert.equal(clip.source_duration_ms, probeVideoDurationMs(videoPath))
  assert.equal(clip.out_ms, 2000)
  assert.deepEqual([clip.source_audio_gain, clip.source_audio_fade_ms], [1, 0])

  for (const invalidRange of [{ in_ms: 1900, out_ms: 2000 }, { in_ms: 0, out_ms: 2100 }, { in_ms: -1 }, { out_ms: 199.5 }]) {
    const invalid = await app.inject({ method: 'PATCH', url: `/api/timeline-clips/${clip.id}`, payload: invalidRange })
    assert.equal(invalid.statusCode, 422)
  }
  const trimmed = await call<Clip>('PATCH', `/api/timeline-clips/${clip.id}`, { in_ms: 800, out_ms: 1600 })
  assert.equal(trimmed.out_ms - trimmed.in_ms, 800)
  for (const invalidAudio of [
    { source_audio_gain: -0.1 }, { source_audio_gain: 2.1 },
    { source_audio_fade_ms: -1 }, { source_audio_fade_ms: 501 }, { source_audio_fade_ms: 1.5 },
  ]) {
    const invalid = await app.inject({ method: 'PATCH', url: `/api/timeline-clips/${clip.id}`, payload: invalidAudio })
    assert.equal(invalid.statusCode, 422)
  }
  const reset = await call<{ selected_asset_id: string }>('PUT', `/api/shots/${second.id}/selection`, { asset_id: 'two-colors' })
  assert.equal(reset.selected_asset_id, 'two-colors')
  const defaultRange = (await call<{ timeline_clips: Clip[] }>('GET', `/api/projects/${project.id}`))
    .timeline_clips.find(item => item.shot_id === second.id)!
  assert.deepEqual([defaultRange.in_ms, defaultRange.out_ms], [0, 2000])
  await call<Clip>('PATCH', `/api/timeline-clips/${clip.id}`, { in_ms: 800, out_ms: 1600 })
  const mixed = await call<Clip>('PATCH', `/api/timeline-clips/${clip.id}`, {
    source_audio_gain: 0.4, source_audio_fade_ms: 250,
  })
  assert.deepEqual([mixed.source_audio_gain, mixed.source_audio_fade_ms], [0.4, 250])
  const frame = await app.inject({ method: 'GET', url: '/api/assets/two-colors/frame?time_ms=1300' })
  assert.equal(frame.statusCode, 200)
  assert.match(frame.headers['content-type'] || '', /image\/jpeg/)
  assert.equal(frame.rawPayload[0], 0xff)
  const tail = await call<{ id: string; kind: string; url: string }>('POST', `/api/timeline-clips/${clip.id}/tail-frame`)
  assert.equal(tail.kind, 'image')
  assert.equal(tail.url, `/api/assets/${tail.id}/file`)
  const tailFile = one<{ path: string }>('SELECT path FROM assets WHERE id=?', tail.id)!
  assert.ok((await stat(tailFile.path)).size > 100)
  const tailPixel = await sharp(await readFile(tailFile.path)).resize(1, 1).raw().toBuffer()
  assert.ok(tailPixel[1]! > tailPixel[0]!, '尾帧应来自第二秒的绿色画面')

  const job = await call<{ request: string }>('POST', `/api/projects/${project.id}/export`)
  const payload = JSON.parse(job.request) as { clips: Array<{ in_ms: number; out_ms: number; source_audio_gain: number; source_audio_fade_ms: number }> }
  assert.deepEqual(payload.clips.map(item => [item.in_ms, item.out_ms]), [[0, 3000], [800, 1600]])
  assert.deepEqual(payload.clips.map(item => [item.source_audio_gain, item.source_audio_fade_ms]), [[1, 0], [0.4, 250]])
  const output = await render({ id: project.id, ratio: '16:9' }, [
    { title: '拔剑', asset_id: 'legacy-image', in_ms: 0, out_ms: 3000, source_duration_ms: null },
    { title: '格挡', asset_id: 'two-colors', in_ms: 800, out_ms: 1600, source_duration_ms: clip.source_duration_ms },
  ], {
    'legacy-image': { kind: 'image', path: imagePath }, 'two-colors': { kind: 'video', path: videoPath },
  })
  assert.ok(Math.abs(probeVideoDurationMs(output) - 3800) < 100)
})

test('export applies per-clip original audio mute, gain, and boundary fades', async () => {
  const source = join(testData, 'audio-controls-source.mp4')
  ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source)

  const output = await render({ id: 'audio-controls-test', ratio: '16:9' }, [
    { title: '正常并淡化', asset_id: 'source', in_ms: 0, out_ms: 1000, source_duration_ms: 1000,
      source_audio_gain: 1, source_audio_fade_ms: 300 },
    { title: '静音', asset_id: 'source', in_ms: 0, out_ms: 1000, source_duration_ms: 1000,
      source_audio_gain: 0, source_audio_fade_ms: 0 },
    { title: '增强', asset_id: 'source', in_ms: 0, out_ms: 1000, source_duration_ms: 1000,
      source_audio_gain: 2, source_audio_fade_ms: 0 },
  ], { source: { kind: 'video', path: source } })

  const early = audioRms(output, 0.02, 0.06)
  const normal = audioRms(output, 0.4, 0.2)
  const late = audioRms(output, 0.92, 0.06)
  const muted = audioRms(output, 1.4, 0.2)
  const boosted = audioRms(output, 2.4, 0.2)
  assert.ok(early < normal * 0.55, `淡入应降低片头音量：${early} vs ${normal}`)
  assert.ok(late < normal * 0.55, `淡出应降低片尾音量：${late} vs ${normal}`)
  assert.ok(muted < normal * 0.02, `静音片段应接近零：${muted} vs ${normal}`)
  assert.ok(boosted > normal * 1.7, `增强片段应比正常音量高：${boosted} vs ${normal}`)

  const music = join(testData, 'audio-controls-music.wav')
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-c:a', 'pcm_s16le', music)
  const withMusic = await render({ id: 'muted-source-with-music', ratio: '16:9', music_asset_id: 'music' }, [
    { title: '仅关闭原声', asset_id: 'source', in_ms: 0, out_ms: 1000, source_duration_ms: 1000,
      source_audio_gain: 0, source_audio_fade_ms: 0 },
  ], { source: { kind: 'video', path: source }, music: { kind: 'audio', path: music } })
  assert.ok(audioRms(withMusic, 0.4, 0.2) > 0.01, '关闭片段原声后，项目配乐仍应可听')
})

test('video duration excludes a longer audio track', async () => {
  const videoPath = join(testData, 'short-picture-long-audio.mp4')
  ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath)

  assert.ok(Math.abs(probeVideoDurationMs(videoPath) - 1000) < 30)
  await assert.rejects(render({ id: 'short-picture-test', ratio: '16:9' }, [
    { title: '短画面', asset_id: 'short-video', in_ms: 0, out_ms: 1500, source_duration_ms: 2000 },
  ], { 'short-video': { kind: 'video', path: videoPath } }), /超出视频素材时长/)
})
