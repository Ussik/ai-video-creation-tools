import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-asset-review-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, initDb, now, run } = await import('../src/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

interface Review { shot_id: string; asset_id: string; status: string; note: string }
interface Detail {
  shots: Array<{ id: string; selected_asset_id: string | null }>
  timeline_clips: Array<{ shot_id: string; asset_id: string }>
  asset_reviews: Review[]
}

test('reviews are per shot; rejection removes only the selected clip and blocks reselection', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '候选审核' })
  const first = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '第一镜', duration: 2 })
  const second = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '第二镜', duration: 2 })
  const otherProject = await call<{ id: string }>('POST', '/api/projects', { name: '其他项目' })
  const foreignShot = await call<{ id: string }>('POST', `/api/projects/${otherProject.id}/shots`, { title: '外部镜头' })

  const imagePath = join(testData, 'review.png')
  await writeFile(imagePath, await sharp({ create: { width: 16, height: 9, channels: 3, background: '#b32128' } }).png().toBuffer())
  for (const id of ['shared', 'second']) {
    run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
      VALUES (?, ?, ?, 'image', 'review.png', ?, 'upload', NULL, NULL, NULL, ?)`,
    id, project.id, id === 'shared' ? first.id : second.id, imagePath, now())
  }
  await call('PUT', `/api/shots/${first.id}/selection`, { asset_id: 'shared' })
  initDb()
  let detail = await call<Detail>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.shots[0]?.selected_asset_id, 'shared', 'schema migration preserves existing selections')
  assert.equal(detail.timeline_clips.length, 1)
  assert.deepEqual(detail.asset_reviews, [])

  const approved = await call<Review>('PUT', `/api/shots/${first.id}/assets/shared/review`,
    { status: 'approved', note: '人物与上一镜一致' })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.note, '人物与上一镜一致')
  const invalidNote = await app.inject({ method: 'PUT', url: `/api/shots/${second.id}/assets/shared/review`,
    payload: { status: 'rejected', note: '   ' } })
  assert.equal(invalidNote.statusCode, 422)
  const foreignReview = await app.inject({ method: 'PUT', url: `/api/shots/${foreignShot.id}/assets/shared/review`,
    payload: { status: 'approved', note: '' } })
  assert.equal(foreignReview.statusCode, 422)

  await call<Review>('PUT', `/api/shots/${second.id}/assets/shared/review`,
    { status: 'rejected', note: '角色站位与第二镜不连贯' })
  const blocked = await app.inject({ method: 'PUT', url: `/api/shots/${second.id}/selection`, payload: { asset_id: 'shared' } })
  assert.equal(blocked.statusCode, 422)
  assert.match(blocked.body, /已被拒绝/)
  detail = await call<Detail>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.shots[0]?.selected_asset_id, 'shared', 'same asset can remain selected in a different shot')
  assert.equal(detail.asset_reviews.length, 2)

  await call('PUT', `/api/shots/${second.id}/selection`, { asset_id: 'second' })
  await call<Review>('PUT', `/api/shots/${second.id}/assets/second/review`,
    { status: 'rejected', note: '动作穿帮' })
  detail = await call<Detail>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.shots[1]?.selected_asset_id, null)
  assert.deepEqual(detail.timeline_clips.map(clip => [clip.shot_id, clip.asset_id]), [[first.id, 'shared']])
  const rejectedAgain = await app.inject({ method: 'PUT', url: `/api/shots/${second.id}/selection`, payload: { asset_id: 'second' } })
  assert.equal(rejectedAgain.statusCode, 422)
  await call<Review>('PUT', `/api/shots/${second.id}/assets/second/review`, { status: 'pending', note: '待重新检查' })
  await call('PUT', `/api/shots/${second.id}/selection`, { asset_id: 'second' })
  detail = await call<Detail>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.shots[1]?.selected_asset_id, 'second')
})

test('video metadata supports first, middle and final frame review', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '关键帧' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '动作镜头' })
  const videoPath = join(testData, 'review-video.mp4')
  const ffmpeg = spawnSync(ffmpegPath!, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ], { encoding: 'utf8' })
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr)
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, ?, 'video', 'review-video.mp4', ?, 'upload', NULL, NULL, NULL, ?)`,
  'review-video', project.id, shot.id, videoPath, now())
  const metadata = await call<{ duration_ms: number }>('GET', '/api/assets/review-video/metadata')
  assert.ok(metadata.duration_ms >= 1900)
  for (const timeMs of [0, Math.floor(metadata.duration_ms / 2), metadata.duration_ms - 100]) {
    const frame = await app.inject({ method: 'GET', url: `/api/assets/review-video/frame?time_ms=${timeMs}` })
    assert.equal(frame.statusCode, 200, frame.body)
    assert.match(frame.headers['content-type'] || '', /image\/jpeg/)
  }
})
